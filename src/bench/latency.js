"use strict";
/**
 * Latency benchmark: direct protocol access vs. access through the WoT gateway.
 *
 * Both paths use the same node-wot client, so the only difference is the gateway hop:
 *   direct  : WoT.consume(device TD)  -> MQTT / CoAP / HTTP straight to the device
 *   gateway : WoT.consume(proxy TD)   -> HTTP to the gateway -> native protocol to the device
 *   gateway-ws (events only): raw WebSocket client on the gateway's ws:// event form
 *
 * Targets: 3 simulated devices (one per protocol, started by this script) and, with --real,
 * the physical devices (DHT22 sensor, fan relay, smart plug).
 *
 *   node src/bench/latency.js [--samples 200] [--warmup 20] [--event-seconds 60] [--tick 0.5] [--real] [--no-spawn]
 *
 * Output: results/latency-<ts>.csv (raw samples), results/latency-<ts>.json + latency-latest.{json,md}
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const WebSocket = require("ws");
const { createServient, withTimeout, cfg } = require("../lib/servient");
const { DirectoryClient } = require("../lib/directory-client");

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? Number(argv[i + 1]) : dflt;
};
const SAMPLES = opt("samples", 200);
const WARMUP = opt("warmup", 20);
const EVENT_SECONDS = opt("event-seconds", 60);
const TICK = opt("tick", 0.5);
const REAL = argv.includes("--real");
const SPAWN = !argv.includes("--no-spawn");
const PREFIX = "lat";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let restoreApp = async () => {}; // re-enables the climate app even if the benchmark fails
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function stats(arr) {
    if (!arr.length) return { n: 0 };
    const s = [...arr].sort((a, b) => a - b);
    const q = (p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
    return {
        n: s.length,
        mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3),
        p50: +q(0.5).toFixed(3),
        p95: +q(0.95).toFixed(3),
        p99: +q(0.99).toFixed(3),
        min: +s[0].toFixed(3),
        max: +s[s.length - 1].toFixed(3),
    };
}

function pythonBin() {
    if (process.env.WOT_PYTHON) return process.env.WOT_PYTHON;
    const win = path.join(cfg.root, ".venv", "Scripts", "python.exe");
    return fs.existsSync(win) ? win : path.join(cfg.root, ".venv", "bin", "python");
}

async function main() {
    const { WoT } = await createServient();
    const dir = new DirectoryClient(cfg.directoryUrl);
    let sim = null;

    // ------------------------------------------------------------ targets
    const targets = [
        { name: "sim-http", proto: "HTTP", id: `urn:wot:sim:${PREFIX}-http-0`, read: "value", action: "ping", event: "tick" },
        { name: "sim-coap", proto: "CoAP", id: `urn:wot:sim:${PREFIX}-coap-1`, read: "value", action: "ping", event: "tick" },
        { name: "sim-mqtt", proto: "MQTT", id: `urn:wot:sim:${PREFIX}-mqtt-2`, read: "value", action: "ping", event: "tick" },
    ];
    if (REAL) {
        targets.push(
            { name: "dht22-sensor", proto: "MQTT", id: "urn:wot:device:temperature-sensor-1", read: "temperature", event: "measurement", real: true },
            { name: "fan-relay", proto: "auto", id: "urn:wot:device:fan-relay-1", read: "on", action: "turnOn", event: null, real: true },
            { name: "smart-plug", proto: "HTTP", id: "urn:wot:device:smart-plug-1", read: "on", action: "turnOn", event: null, real: true }
        );
    }

    if (SPAWN) {
        const existing = await dir.get(targets[0].id);
        if (!existing) {
            log(`starting 3 simulated devices (tick ${TICK}s) with ${pythonBin()}`);
            sim = spawn(pythonBin(), [path.join("devices", "sim_devices.py"), "--count", "3", "--tick", String(TICK), "--prefix", PREFIX], {
                cwd: cfg.root,
                stdio: "ignore",
            });
        }
    }
    const cleanup = () => {
        if (sim && sim.exitCode === null) sim.kill("SIGTERM");
    };
    process.on("exit", cleanup);
    process.on("SIGINT", () => {
        cleanup();
        process.exit(130);
    });

    // pause the climate app so it does not toggle the relay during the benchmark
    let app = null;
    let appWasEnabled = null;
    try {
        const appTd = await dir.get("urn:wot:app:climate-controller");
        if (appTd) {
            app = await WoT.consume(appTd);
            appWasEnabled = await (await app.readProperty("enabled")).value();
            await app.writeProperty("enabled", false);
            restoreApp = () => app.writeProperty("enabled", appWasEnabled).catch(() => {});
        }
    } catch (_) {
        app = null;
    }

    // ------------------------------------------------------------ consume both paths
    for (const t of targets) {
        const t0 = Date.now();
        for (;;) {
            const native = await dir.get(t.id);
            const proxy = await dir.get(`urn:wot:gateway:${t.id}`);
            if (native && proxy) {
                t.nativeTd = native;
                t.proxyTd = proxy;
                break;
            }
            if (Date.now() - t0 > 60000) throw new Error(`${t.id} or its gateway proxy not found in directory`);
            await sleep(500);
        }
        if (t.proto === "auto") t.proto = String(t.nativeTd.properties[t.read].forms[0].href).split(":")[0].toUpperCase();
        t.direct = await WoT.consume(t.nativeTd);
        t.gateway = await WoT.consume(t.proxyTd);
        if (t.event) {
            const wsForm = (t.proxyTd.events[t.event].forms || []).find((f) => String(f.href).startsWith("ws"));
            t.wsHref = wsForm && wsForm.href;
        }
    }
    log(`targets: ${targets.map((t) => `${t.name}(${t.proto})`).join(", ")}`);
    await sleep(2000); // let the gateway's event subscriptions settle

    const raw = []; // {target, protocol, interaction, path, ms}
    const record = (t, interaction, p, ms) => raw.push({ target: t.name, protocol: t.proto, interaction, path: p, ms });

    // ------------------------------------------------------------ request/response interactions
    const ops = {
        read: (thing, t) => thing.readProperty(t.read).then((o) => o.value()),
        action: (thing, t) => thing.invokeAction(t.action),
    };
    for (const t of targets) {
        for (const [interaction, fn] of Object.entries(ops)) {
            if (interaction === "action" && !t.action) continue;
            const n = t.real && interaction === "action" ? Math.min(SAMPLES, 50) : SAMPLES;
            log(`${t.name.padEnd(13)} ${interaction.padEnd(6)} x${n} (+${WARMUP} warm-up), direct vs gateway interleaved`);
            for (let i = 0; i < WARMUP; i++) {
                await withTimeout(fn(t.direct, t), 5000, "warmup").catch(() => {});
                await withTimeout(fn(t.gateway, t), 5000, "warmup").catch(() => {});
            }
            for (let i = 0; i < n; i++) {
                const order = i % 2 ? ["gateway", "direct"] : ["direct", "gateway"];
                for (const p of order) {
                    const t0 = performance.now();
                    try {
                        await withTimeout(fn(t[p], t), 5000, `${t.name} ${interaction}`);
                        record(t, interaction, p, performance.now() - t0);
                    } catch (e) {
                        record(t, interaction, p + "-error", NaN);
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------ events (all paths concurrently)
    const evTargets = targets.filter((t) => t.event);
    const seen = {}; // `${target}|${path}` -> Set(seq)
    const subs = [];
    const sockets = [];
    const evStart = Date.now();
    const onEvent = (t, p, value) => {
        if (!value || typeof value.ts !== "number" || value.ts < evStart) return;
        const key = `${t.name}|${p}`;
        seen[key] = seen[key] || new Set();
        if (seen[key].has(value.seq)) return;
        seen[key].add(value.seq);
        record(t, "event", p, Date.now() - value.ts);
    };
    for (const t of evTargets) {
        for (const p of ["direct", "gateway"]) {
            subs.push(await t[p].subscribeEvent(t.event, async (d) => onEvent(t, p, await d.value())));
        }
        if (t.wsHref) {
            const ws = new WebSocket(t.wsHref);
            ws.on("message", (m) => {
                try {
                    onEvent(t, "gateway-ws", JSON.parse(m.toString()));
                } catch (_) {
                    /* ignore */
                }
            });
            sockets.push(ws);
        }
    }
    log(`collecting events for ${EVENT_SECONDS}s on ${evTargets.map((t) => t.name).join(", ")} (paths: direct, gateway(long-poll), gateway-ws)`);
    await sleep(EVENT_SECONDS * 1000);
    for (const s of subs) await Promise.resolve(s.stop()).catch(() => {});
    for (const ws of sockets) ws.close();

    // ------------------------------------------------------------ summary
    const groups = {};
    for (const r of raw) {
        const k = `${r.target}|${r.protocol}|${r.interaction}`;
        groups[k] = groups[k] || { target: r.target, protocol: r.protocol, interaction: r.interaction, paths: {} };
        const g = groups[k].paths;
        g[r.path] = g[r.path] || [];
        g[r.path].push(r.ms);
    }
    const summary = [];
    for (const g of Object.values(groups)) {
        const row = { target: g.target, protocol: g.protocol, interaction: g.interaction };
        for (const [p, arr] of Object.entries(g.paths)) {
            if (p.endsWith("-error")) row[p.replace("-error", "") + "Errors"] = arr.length;
            else row[p] = stats(arr);
        }
        if (row.direct?.n && row.gateway?.n) {
            row.addedP50 = +(row.gateway.p50 - row.direct.p50).toFixed(3);
            row.addedP95 = +(row.gateway.p95 - row.direct.p95).toFixed(3);
        }
        if (g.interaction === "event") {
            const allSeqs = new Set();
            for (const p of ["direct", "gateway", "gateway-ws"]) for (const s of seen[`${g.target}|${p}`] || []) allSeqs.add(s);
            row.delivery = {};
            for (const p of ["direct", "gateway", "gateway-ws"]) {
                const n = (seen[`${g.target}|${p}`] || new Set()).size;
                if (n) row.delivery[p] = +(n / allSeqs.size).toFixed(3);
            }
        }
        summary.push(row);
    }

    const f = (s, k) => (s && s.n ? s[k].toFixed(2) : "-");
    const md = [
        "# Latency: direct protocol access vs. WoT gateway",
        "",
        `Run ${new Date().toISOString()} on ${require("os").hostname()} | ${SAMPLES} samples per request type (${WARMUP} warm-up), events ${EVENT_SECONDS}s @ tick ${TICK}s`,
        "",
        "| target | native protocol | interaction | direct p50 | direct p95 | gateway p50 | gateway p95 | **added p50** | **added p95** | gateway-ws p50 | gateway-ws p95 | n (direct/gw) |",
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
        ...summary.map(
            (r) =>
                `| ${r.target} | ${r.protocol} | ${r.interaction} | ${f(r.direct, "p50")} | ${f(r.direct, "p95")} | ${f(r.gateway, "p50")} | ${f(r.gateway, "p95")} | **${
                    r.addedP50 ?? "-"
                }** | **${r.addedP95 ?? "-"}** | ${f(r["gateway-ws"], "p50")} | ${f(r["gateway-ws"], "p95")} | ${r.direct?.n ?? 0}/${r.gateway?.n ?? 0}${
                    r.directErrors || r.gatewayErrors ? ` (errors ${r.directErrors || 0}/${r.gatewayErrors || 0})` : ""
                } |`
        ),
        "",
        "All values in milliseconds. *added* = gateway − direct. read = readProperty, action = invokeAction (MQTT: until PUBACK, QoS 1),",
        "event = device timestamp → client receipt. Gateway events: node-wot HTTP long-poll (`gateway`) and WebSocket (`gateway-ws`).",
        "",
        "Event delivery ratio (unique events received / events seen on any path):",
        "",
        ...summary.filter((r) => r.delivery).map((r) => `- ${r.target}: ${Object.entries(r.delivery).map(([p, v]) => `${p} ${(v * 100).toFixed(1)}%`).join(", ")}`),
    ].join("\n");

    const outDir = path.join(cfg.root, "results");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(
        path.join(outDir, `latency-${stamp}.csv`),
        "target,protocol,interaction,path,ms\n" + raw.map((r) => `${r.target},${r.protocol},${r.interaction},${r.path},${Number.isNaN(r.ms) ? "" : r.ms.toFixed(3)}`).join("\n") + "\n"
    );
    const json = JSON.stringify({ timestamp: new Date().toISOString(), samples: SAMPLES, eventSeconds: EVENT_SECONDS, tick: TICK, summary }, null, 2);
    fs.writeFileSync(path.join(outDir, `latency-${stamp}.json`), json);
    fs.writeFileSync(path.join(outDir, "latency-latest.json"), json);
    fs.writeFileSync(path.join(outDir, "latency-latest.md"), md + "\n");
    console.log("\n" + md);

    await restoreApp();
    if (REAL) {
        const relay = targets.find((t) => t.name === "fan-relay");
        if (relay) await relay.gateway.invokeAction("turnOff").catch(() => {});
    }
    cleanup();
    await sleep(500);
    process.exit(0);
}

main().catch(async (e) => {
    console.error("latency benchmark failed:", e);
    await restoreApp();
    process.exit(1);
});
