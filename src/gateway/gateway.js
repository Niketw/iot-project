"use strict";
/**
 * WoT Gateway (Eclipse Thingweb node-wot).
 *
 * 1. Polls the Thing Directory for device TDs (MQTT / CoAP / HTTP).
 * 2. For each device: WoT.consume(nativeTD) -> ConsumedThing (talks the native protocol)
 *                     WoT.produce(proxyInit) -> ExposedThing  (served over HTTP + WebSocket)
 *    Every read / write / action on the proxy is forwarded to the ConsumedThing;
 *    every native event is re-emitted on the proxy.
 * 3. Registers the proxy TD (id = urn:wot:gateway:<device id>) in the directory.
 *
 * When a device's TD changes (e.g. relay moved CoAP -> MQTT) or the device re-registers
 * after a restart, the proxy stays up and only its backing ConsumedThing is replaced,
 * so applications using the proxy never notice.
 */
const crypto = require("crypto");
const { createServient, dedupeSubscriptions, withTimeout, cfg: baseCfg } = require("../lib/servient");
const { DirectoryClient } = require("../lib/directory-client");

const PROXY_PREFIX = "urn:wot:gateway:";
const PROXIED_ID_PREFIXES = ["urn:wot:device:", "urn:wot:sim:"];
const log = (...a) => console.log(new Date().toISOString(), "[gateway]", ...a);

function tdKey(td) {
    const { registration, ...rest } = td;
    const h = crypto.createHash("sha1").update(JSON.stringify(rest)).digest("hex");
    return `${h}:${registration?.created ?? ""}`;
}

function schemesOf(td) {
    const s = new Set();
    for (const group of ["properties", "actions", "events"]) {
        for (const aff of Object.values(td[group] || {})) {
            for (const f of aff.forms || []) s.add(String(f.href).split(":")[0]);
        }
    }
    return [...s];
}

/** Strip protocol-specific parts of a native TD -> ExposedThingInit for the proxy. */
function proxyInit(nativeTd, directoryUrl) {
    const strip = (group) =>
        Object.fromEntries(
            Object.entries(nativeTd[group] || {}).map(([name, aff]) => {
                const { forms, ...rest } = aff;
                return [name, rest];
            })
        );
    return {
        "@context": nativeTd["@context"],
        "@type": nativeTd["@type"],
        id: PROXY_PREFIX + nativeTd.id,
        title: nativeTd.title,
        description: `${nativeTd.description || nativeTd.title} [Proxied by the WoT gateway; native TD: ${nativeTd.id}]`,
        properties: strip("properties"),
        actions: strip("actions"),
        events: strip("events"),
        links: [
            {
                rel: "alternate",
                href: `${directoryUrl}/things/${encodeURIComponent(nativeTd.id)}`,
                type: "application/td+json",
            },
        ],
    };
}

class Proxy {
    constructor(gw, nativeTd) {
        this.gw = gw;
        this.nativeId = nativeTd.id;
        this.id = PROXY_PREFIX + nativeTd.id;
        this.nativeTd = nativeTd;
        this.key = null;
        this.backing = null;
        this.subscriptions = [];
        this.inflightReads = new Map();
        this.missingSince = null;
        this.rebindTimer = null;
        this.generation = 0;
        this.stats = { reads: 0, writes: 0, actions: 0, events: 0, dropped: 0, errors: 0, rebinds: 0 };
    }

    async start() {
        const { WoT, cfg } = this.gw;
        const init = proxyInit(this.nativeTd, `http://${cfg.host}:${cfg.directoryPort}`);
        this.exposed = dedupeSubscriptions(await WoT.produce(init));

        for (const name of Object.keys(init.properties)) {
            this.exposed.setPropertyReadHandler(name, () => this.readProperty(name));
            if (!init.properties[name].readOnly) {
                this.exposed.setPropertyWriteHandler(name, async (input) => {
                    this.stats.writes++;
                    const value = await input.value();
                    await withTimeout(this.backing.writeProperty(name, value), cfg.readTimeoutMs, `write ${name}`);
                });
            }
        }
        for (const [name, action] of Object.entries(init.actions)) {
            this.exposed.setActionHandler(name, async (params) => {
                this.stats.actions++;
                const input = action.input ? await params.value() : undefined;
                const out = await withTimeout(this.backing.invokeAction(name, input), cfg.readTimeoutMs, `invoke ${name}`);
                return action.output && out ? out.value() : undefined;
            });
        }
        await this.exposed.expose();
        await this.bind(this.nativeTd);
        this.td = this.exposed.getThingDescription();
        await this.gw.directory.register(this.td);
        log(`proxy up   ${this.id}  [${schemesOf(this.nativeTd).join(",")}] -> http+ws`);
    }

    /** Coalesce concurrent reads of the same property (node-wot's MQTT read can't run twice in parallel). */
    readProperty(name) {
        this.stats.reads++;
        let p = this.inflightReads.get(name);
        if (!p) {
            p = withTimeout(
                this.backing.readProperty(name).then((o) => o.value()),
                this.gw.cfg.readTimeoutMs,
                `read ${this.nativeId}/${name}`
            )
                .catch((e) => {
                    this.stats.errors++;
                    throw e;
                })
                .finally(() => this.inflightReads.delete(name));
            this.inflightReads.set(name, p);
        }
        return p;
    }

    async bind(nativeTd) {
        await this.unsubscribeAll();
        this.nativeTd = nativeTd;
        this.key = tdKey(nativeTd);
        this.backing = await this.gw.WoT.consume(nativeTd);
        this.inflightReads.clear();
        const gen = this.generation;
        for (const name of Object.keys(nativeTd.events || {})) {
            try {
                const sub = await this.backing.subscribeEvent(
                    name,
                    async (data) => {
                        let value;
                        try {
                            value = await data.value();
                        } catch (e) {
                            // e.g. the initial CoAP Observe response is `null` before any event happened
                            this.stats.dropped++;
                            return;
                        }
                        this.stats.events++;
                        try {
                            this.exposed.emitEvent(name, value);
                        } catch (e) {
                            this.stats.errors++;
                        }
                    },
                    (err) => {
                        if (gen !== this.generation) return; // stopped on purpose during rebind
                        this.stats.errors++;
                        log(`event ${this.nativeId}/${name} failed (${err && err.message}) - will rebind`);
                        this.scheduleRebind();
                    }
                );
                this.subscriptions.push(sub);
            } catch (e) {
                log(`cannot subscribe ${this.nativeId}/${name}: ${e.message} - will retry`);
                this.scheduleRebind();
            }
        }
    }

    scheduleRebind(delayMs = 3000) {
        if (this.rebindTimer || this.destroyed) return;
        this.rebindTimer = setTimeout(async () => {
            this.rebindTimer = null;
            try {
                this.stats.rebinds++;
                await this.bind(this.nativeTd);
            } catch (e) {
                log(`rebind ${this.nativeId} failed: ${e.message}`);
                this.scheduleRebind(Math.min(delayMs * 2, 30000));
            }
        }, delayMs);
    }

    async unsubscribeAll() {
        this.generation++;
        const subs = this.subscriptions;
        this.subscriptions = [];
        await Promise.all(subs.map((s) => Promise.resolve().then(() => s.stop()).catch(() => {})));
    }

    async destroy() {
        this.destroyed = true;
        clearTimeout(this.rebindTimer);
        await this.unsubscribeAll();
        try {
            await this.exposed.destroy();
        } catch (_) {
            /* ignore */
        }
        await this.gw.directory.unregister(this.id).catch(() => {});
        log(`proxy gone ${this.id}`);
    }
}

class Gateway {
    async start() {
        const { WoT, cfg, servient } = await createServient({ httpPort: baseCfg.gatewayHttpPort, wsPort: baseCfg.gatewayWsPort });
        this.WoT = WoT;
        this.cfg = cfg;
        this.servient = servient;
        this.proxies = new Map(); // nativeId -> Proxy
        this.directory = new DirectoryClient(cfg.directoryUrl, cfg.ttlS);
        this.startedAt = Date.now();
        this.lastSync = { at: null, ms: 0, natives: 0 };
        await this.exposeSelf();
        await this.syncLoop();
    }

    /** The gateway is a Thing too: its status is readable over WoT (used by the dashboard + benchmarks). */
    async exposeSelf() {
        const cfg = this.cfg;
        const t = await this.WoT.produce({
            "@context": "https://www.w3.org/2022/wot/td/v1.1",
            "@type": "Thing",
            id: "urn:wot:gateway",
            title: "WoT Gateway",
            description: "Protocol-independent gateway; proxies every registered device over HTTP and WebSocket.",
            properties: {
                status: {
                    type: "object",
                    readOnly: true,
                    properties: {
                        pid: { type: "integer" },
                        uptimeS: { type: "number" },
                        proxies: { type: "integer" },
                        rssMB: { type: "number" },
                        heapUsedMB: { type: "number" },
                        lastSyncMs: { type: "number" },
                    },
                },
                proxies: { type: "array", readOnly: true, items: { type: "object" } },
            },
        });
        t.setPropertyReadHandler("status", async () => {
            const m = process.memoryUsage();
            return {
                pid: process.pid,
                uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
                proxies: this.proxies.size,
                rssMB: +(m.rss / 1048576).toFixed(1),
                heapUsedMB: +(m.heapUsed / 1048576).toFixed(1),
                lastSyncMs: this.lastSync.ms,
            };
        });
        t.setPropertyReadHandler("proxies", async () =>
            [...this.proxies.values()].map((p) => ({
                id: p.id,
                native: p.nativeId,
                title: p.nativeTd.title,
                nativeProtocols: schemesOf(p.nativeTd),
                stats: p.stats,
            }))
        );
        await t.expose();
        this.selfTd = t.getThingDescription();
        await this.directory.register(this.selfTd);
        log(`gateway HTTP :${cfg.gatewayHttpPort}  WS :${cfg.gatewayWsPort}  directory ${cfg.directoryUrl}`);
    }

    async syncLoop() {
        for (;;) {
            try {
                await this.sync();
            } catch (e) {
                log(`sync failed: ${e.message}`);
            }
            await new Promise((r) => setTimeout(r, this.cfg.syncIntervalS * 1000));
        }
    }

    async sync() {
        const t0 = Date.now();
        const tds = await this.directory.list();
        const natives = tds.filter((td) => td.id && PROXIED_ID_PREFIXES.some((p) => td.id.startsWith(p)));
        const seen = new Set();
        for (const td of natives) {
            seen.add(td.id);
            const existing = this.proxies.get(td.id);
            if (!existing) {
                const proxy = new Proxy(this, td);
                this.proxies.set(td.id, proxy);
                try {
                    await proxy.start();
                } catch (e) {
                    log(`cannot proxy ${td.id}: ${e.message}`);
                    this.proxies.delete(td.id);
                    await proxy.destroy().catch(() => {});
                }
            } else {
                existing.missingSince = null;
                if (existing.key !== tdKey(td)) {
                    const before = schemesOf(existing.nativeTd).join(",");
                    const after = schemesOf(td).join(",");
                    log(`rebind ${td.id} (${before === after ? "re-registered" : `protocol ${before} -> ${after}`})`);
                    existing.stats.rebinds++;
                    await existing.bind(td).catch((e) => {
                        log(`rebind failed: ${e.message}`);
                        existing.scheduleRebind();
                    });
                }
            }
        }
        for (const [id, proxy] of this.proxies) {
            if (seen.has(id)) continue;
            proxy.missingSince = proxy.missingSince || Date.now();
            if (Date.now() - proxy.missingSince > this.cfg.graceS * 1000) {
                this.proxies.delete(id);
                await proxy.destroy();
            }
        }
        // keep proxy registrations fresh (directory TTL)
        await this.directory.heartbeat();
        this.lastSync = { at: Date.now(), ms: Date.now() - t0, natives: natives.length };
    }

    async stop() {
        log("shutting down");
        await Promise.all([...this.proxies.values()].map((p) => this.directory.unregister(p.id).catch(() => {})));
        await this.directory.unregister("urn:wot:gateway").catch(() => {});
        process.exit(0);
    }
}

const gw = new Gateway();
process.on("SIGINT", () => gw.stop());
process.on("SIGTERM", () => gw.stop());
process.on("unhandledRejection", (e) => log("unhandled rejection:", e && e.message ? e.message : e));
gw.start().catch((e) => {
    console.error(e);
    process.exit(1);
});
