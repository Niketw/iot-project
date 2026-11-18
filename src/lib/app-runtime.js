"use strict";
/**
 * Generic runtime for protocol-independent WoT applications.
 *
 *  - Discovers Things through the Thing Directory (WoT.exploreDirectory).
 *  - Selects devices by semantic @type + required affordances (never by protocol/address).
 *  - mode "gateway": uses the gateway's proxy TDs; mode "direct": uses the devices' own TDs
 *    (node-wot then speaks MQTT/CoAP/HTTP itself). Same application code either way.
 *  - Re-binds automatically when a selected TD changes (e.g. protocol swap) or events stop.
 *  - Exposes the application itself as a Thing (settings + status + alert event).
 */
const crypto = require("crypto");
const { createServient, withTimeout, cfg: baseCfg } = require("./servient");
const { DirectoryClient } = require("./directory-client");

const log = (...a) => console.log(new Date().toISOString(), "[app]", ...a);

function tdKey(td) {
    const { registration, ...rest } = td;
    return crypto.createHash("sha1").update(JSON.stringify(rest)).digest("hex") + (registration?.created ?? "");
}

function protocolsOf(td) {
    const s = new Set();
    for (const g of ["properties", "actions", "events"])
        for (const a of Object.values(td[g] || {})) for (const f of a.forms || []) s.add(String(f.href).split(":")[0]);
    return [...s];
}

function matches(td, req) {
    const types = [].concat(td["@type"] || []);
    if (req.type && !types.includes(req.type)) return false;
    for (const [group, names] of [["properties", req.properties], ["actions", req.actions], ["events", req.events]]) {
        for (const n of names || []) if (!td[group] || !td[group][n]) return false;
    }
    return true;
}

async function runApplication(spec) {
    const { WoT, cfg } = await createServient({ httpPort: baseCfg.appPort });
    const directory = new DirectoryClient(cfg.directoryUrl, cfg.ttlS);

    const settings = { threshold: cfg.threshold, hysteresis: cfg.hysteresis, enabled: true, mode: cfg.appMode };
    const status = { state: "starting", bound: {}, lastEventAt: null, rebinds: 0, lastAlert: null };
    let current = { key: null, subs: [], things: null };
    let forceRebind = false;
    let generation = 0; // bumped on every teardown; errors from older generations are ignored
    let appThing;

    // ---------------------------------------------------------------- the app as a Thing
    appThing = await WoT.produce({
        "@context": "https://www.w3.org/2022/wot/td/v1.1",
        "@type": "Thing",
        id: `urn:wot:app:${spec.title.toLowerCase().replace(/\W+/g, "-")}`,
        title: spec.title,
        description: "Protocol-independent application; uses devices only through their Thing Descriptions.",
        properties: {
            threshold: { type: "number", unit: "degree Celsius", minimum: -20, maximum: 80 },
            hysteresis: { type: "number", minimum: 0, maximum: 10 },
            enabled: { type: "boolean", description: "Automatic control on/off" },
            mode: { type: "string", enum: ["gateway", "direct"], description: "Use gateway proxies or devices' own TDs" },
            status: { type: "object", readOnly: true },
        },
        events: { alert: { data: { type: "object", properties: { message: { type: "string" }, ts: { type: "number" } } } } },
    });
    for (const key of ["threshold", "hysteresis", "enabled", "mode"]) {
        appThing.setPropertyReadHandler(key, async () => settings[key]);
        appThing.setPropertyWriteHandler(key, async (input) => {
            const v = await input.value();
            settings[key] = v;
            log(`setting ${key} = ${JSON.stringify(v)}`);
            if (key === "mode") forceRebind = true;
        });
    }
    appThing.setPropertyReadHandler("status", async () => ({ ...status, settings }));
    await appThing.expose();
    await directory.register(appThing.getThingDescription());
    directory.startHeartbeat();

    // ---------------------------------------------------------------- context given to bind()
    const ctx = {
        settings,
        status,
        log,
        /** Subscribe to an event; handler receives the decoded value. Calls are serialized. */
        async subscribe(thing, event, handler) {
            let chain = Promise.resolve();
            const gen = generation;
            const sub = await thing.subscribeEvent(
                event,
                async (data) => {
                    status.lastEventAt = Date.now();
                    const value = await data.value();
                    chain = chain
                        .then(() => withTimeout(Promise.resolve(handler(value)), 15000, `handler ${event}`))
                        .catch((e) => log(`handler error: ${e.message}`));
                },
                (err) => {
                    if (gen !== generation) return; // we stopped it ourselves
                    log(`subscription ${event} failed: ${err && err.message} - re-binding`);
                    forceRebind = true;
                }
            );
            current.subs.push(sub);
            return sub;
        },
        /** Notify: log + `alert` event on the app Thing + optional webhook. */
        notify(message) {
            const alert = { message, ts: Date.now() };
            status.lastAlert = alert;
            log(`ALERT: ${message}`);
            appThing.emitEvent("alert", alert);
            if (cfg.notifyUrl) {
                fetch(cfg.notifyUrl, { method: "POST", body: message, headers: { "Content-Type": "text/plain" } }).catch((e) =>
                    log(`webhook failed: ${e.message}`)
                );
            }
        },
    };

    // ---------------------------------------------------------------- discovery + binding
    async function discover() {
        const tds = [];
        const proc = await WoT.exploreDirectory(`${cfg.directoryUrl}/.well-known/wot`);
        for await (const td of proc) tds.push(td);
        const wantProxy = settings.mode === "gateway";
        const pool = tds.filter((td) => (wantProxy ? td.id?.startsWith("urn:wot:gateway:urn:wot:device:") : td.id?.startsWith("urn:wot:device:")));
        const natives = tds.filter((td) => td.id?.startsWith("urn:wot:device:"));
        const chosen = {};
        const missing = [];
        for (const [role, req] of Object.entries(spec.requires)) {
            const td = pool.find((t) => matches(t, req));
            if (td) chosen[role] = td;
            else if (!req.optional) missing.push(`${role} (${whyMissing(req, pool, natives, wantProxy)})`);
        }
        return { chosen, missing };
    }

    /** Explain a missing device so the status tells you where to look. */
    function whyMissing(req, pool, natives, wantProxy) {
        const ofType = (list) => list.filter((t) => [].concat(t["@type"] || []).includes(req.type));
        const candidate = ofType(pool)[0];
        if (candidate) return `${candidate.id} lacks required affordances - check its TD`;
        const native = ofType(natives)[0];
        if (!native) return "device not registered in the directory - is its service running? see ./wotctl status";
        if (!matches(native, req)) return `${native.id} lacks required affordances - check its TD`;
        return wantProxy ? "device registered but the gateway has not proxied it - check ./wotctl logs gateway" : "unknown";
    }

    async function teardown() {
        generation++;
        const subs = current.subs;
        current.subs = [];
        await Promise.all(subs.map((s) => Promise.resolve().then(() => s.stop()).catch(() => {})));
    }

    async function reconcile() {
        const { chosen, missing } = await discover();
        if (missing.length) {
            status.state = `waiting for: ${missing.join(", ")} (mode=${settings.mode})`;
            if (current.key) {
                await teardown();
                current.key = null;
            }
            return;
        }
        const key = settings.mode + Object.entries(chosen).map(([r, td]) => r + tdKey(td)).join("|");
        const stale = status.lastEventAt && Date.now() - status.lastEventAt > Math.max(20000, cfg.sensorIntervalS * 6000);
        if (key === current.key && !forceRebind && !stale) return;

        if (current.key) status.rebinds++;
        forceRebind = false;
        await teardown();
        const things = {};
        for (const [role, td] of Object.entries(chosen)) things[role] = await WoT.consume(td);
        status.bound = Object.fromEntries(Object.entries(chosen).map(([r, td]) => [r, { id: td.id, protocols: protocolsOf(td) }]));
        status.lastEventAt = Date.now();
        await spec.bind(things, ctx);
        current.key = key;
        status.state = "running";
        log(
            `bound (mode=${settings.mode}): ` +
                Object.entries(status.bound).map(([r, b]) => `${r}=${b.id} [${b.protocols}]`).join("  ")
        );
    }

    log(`starting "${spec.title}" mode=${settings.mode} threshold=${settings.threshold} directory=${cfg.directoryUrl}`);
    for (;;) {
        try {
            await reconcile();
        } catch (e) {
            status.state = `error: ${e.message}`;
            log(`reconcile failed: ${e.message}`);
            current.key = null;
        }
        // Poll quickly while something is pending, otherwise every 5 s.
        for (let i = 0; i < 10 && !forceRebind; i++) await new Promise((r) => setTimeout(r, 500));
    }
}

process.on("unhandledRejection", (e) => log("unhandled rejection:", e && e.message ? e.message : e));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

module.exports = { runApplication };
