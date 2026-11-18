"use strict";
/**
 * Interoperability (protocol-swap) test.
 *
 *  1. Snapshot every source file of the application, gateway and devices (hash + content).
 *  2. For relay protocol in [CoAP, MQTT, CoAP]:
 *       - replace ONLY things/fan-relay.td.json with the matching template, restart the relay
 *       - wait until the directory + gateway show the new protocol
 *       - for app mode in [gateway, direct]: drive the UNCHANGED application through its
 *         own WoT interface (threshold below / above the current temperature) and check
 *         that the physical relay follows (read via the gateway). Record time-to-actuate.
 *  3. Snapshot again -> lines of code changed (target 0) + lines of TD changed.
 *
 * Restart command: $SWAP_RESTART_CMD or "sudo systemctl restart wot-relay".
 * Output: results/swap-test-<timestamp>.{json,md} and results/swap-test-latest.md
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const { createServient, cfg } = require("../lib/servient");
const { DirectoryClient } = require("../lib/directory-client");

const ROOT = cfg.root;
const RELAY_TD = path.join(ROOT, cfg.raw.RELAY_TD || "things/fan-relay.td.json");
const TEMPLATES = {
    coap: path.join(ROOT, "things/templates/fan-relay.coap.td.json"),
    mqtt: path.join(ROOT, "things/templates/fan-relay.mqtt.td.json"),
};
const RESTART = process.env.SWAP_RESTART_CMD || "sudo systemctl restart wot-relay";
const CODE_DIRS = ["src", "devices"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let restore = async () => {};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function snapshot() {
    const files = {};
    const walk = (dir) => {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) {
                if (!["node_modules", "__pycache__", "public"].includes(e.name)) walk(p);
            } else if (/\.(js|py)$/.test(e.name)) {
                const text = fs.readFileSync(p, "utf8");
                files[path.relative(ROOT, p).replace(/\\/g, "/")] = {
                    sha256: crypto.createHash("sha256").update(text).digest("hex"),
                    text,
                };
            }
        }
    };
    for (const d of CODE_DIRS) walk(path.join(ROOT, d));
    return files;
}

/** Number of changed lines between two texts (LCS-based: added + removed). */
function changedLines(a, b) {
    const x = a.split(/\r?\n/);
    const y = b.split(/\r?\n/);
    const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
    for (let i = x.length - 1; i >= 0; i--)
        for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const common = dp[0][0];
    return { added: y.length - common, removed: x.length - common };
}

function protocolOfTd(file) {
    const td = JSON.parse(fs.readFileSync(file, "utf8"));
    return String(td.properties.on.forms[0].href).split(":")[0];
}

async function main() {
    const { WoT } = await createServient();
    const dir = new DirectoryClient(cfg.directoryUrl);
    const before = snapshot();
    const originalTd = fs.readFileSync(RELAY_TD, "utf8");
    const startProto = protocolOfTd(RELAY_TD);
    const sequence = startProto === "coap" ? ["coap", "mqtt", "coap"] : ["mqtt", "coap", "mqtt"];

    const appTd = await dir.get("urn:wot:app:climate-controller");
    if (!appTd) throw new Error("application Thing not found in directory - is wot-app running?");
    const app = await WoT.consume(appTd);
    const read = async (thing, prop) => (await thing.readProperty(prop)).value();
    const original = { threshold: await read(app, "threshold"), mode: await read(app, "mode") };
    restore = async () => {
        restore = async () => {};
        await app.writeProperty("threshold", original.threshold).catch(() => {});
        await app.writeProperty("mode", original.mode).catch(() => {});
        if (fs.readFileSync(RELAY_TD, "utf8") !== originalTd) {
            log("restoring original relay TD");
            fs.writeFileSync(RELAY_TD, originalTd);
            execSync(RESTART, { stdio: "inherit", shell: true });
        }
    };

    async function relayProxy() {
        const td = await dir.get("urn:wot:gateway:urn:wot:device:fan-relay-1");
        if (!td) throw new Error("fan relay proxy not found");
        return WoT.consume(td);
    }
    async function waitFor(pred, timeoutMs, what) {
        const t0 = Date.now();
        for (;;) {
            try {
                if (await pred()) return Date.now() - t0;
            } catch (_) {
                /* keep trying */
            }
            if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
            await sleep(250);
        }
    }

    const rows = [];
    for (const [i, proto] of sequence.entries()) {
        log(`--- phase ${i + 1}: relay protocol = ${proto.toUpperCase()}`);
        if (i > 0 || startProto !== proto) {
            fs.copyFileSync(TEMPLATES[proto], RELAY_TD);
            log(`installed ${path.relative(ROOT, TEMPLATES[proto])} -> ${path.relative(ROOT, RELAY_TD)}; restarting relay`);
            execSync(RESTART, { stdio: "inherit", shell: true });
        }
        await waitFor(
            async () => {
                const td = await dir.get("urn:wot:device:fan-relay-1");
                return td && String(td.properties.on.forms[0].href).startsWith(proto);
            },
            30000,
            "relay TD in directory"
        );
        const gwTd = await dir.get("urn:wot:gateway");
        const gateway = await WoT.consume(gwTd);
        const proxyBindMs = await waitFor(
            async () => {
                const list = await read(gateway, "proxies");
                const p = list.find((x) => x.native === "urn:wot:device:fan-relay-1");
                return p && p.nativeProtocols.includes(proto);
            },
            30000,
            "gateway rebind"
        );
        log(`gateway proxy now bound over ${proto} (${proxyBindMs} ms after TD appeared)`);

        for (const mode of ["gateway", "direct"]) {
            await app.writeProperty("mode", mode);
            await waitFor(async () => {
                const s = await read(app, "status");
                return s.state === "running" && s.bound.fan && (mode === "direct" ? s.bound.fan.protocols.includes(proto) : s.bound.fan.id.startsWith("urn:wot:gateway:"));
            }, 30000, `app bound in ${mode} mode`);
            const relay = await relayProxy();
            let temp = null;
            await waitFor(async () => {
                temp = (await read(app, "status")).temperature;
                return typeof temp === "number";
            }, 20000, "temperature");

            const row = { protocol: proto, mode, temperature: temp, on: null, off: null, pass: false, error: null };
            try {
                await app.writeProperty("threshold", Math.round((temp - 5) * 10) / 10);
                row.on = await waitFor(async () => (await read(relay, "on")) === true, 20000, "fan ON");
                await app.writeProperty("threshold", Math.round((temp + 10) * 10) / 10);
                row.off = await waitFor(async () => (await read(relay, "on")) === false, 20000, "fan OFF");
                row.pass = true;
            } catch (e) {
                row.error = e.message;
            }
            const appStatus = await read(app, "status");
            row.appBoundTo = appStatus.bound.fan.protocols.join("+");
            rows.push(row);
            log(`  mode=${mode.padEnd(7)} app->fan via ${row.appBoundTo.padEnd(7)} fan ON after ${row.on} ms, OFF after ${row.off} ms  ${row.pass ? "PASS" : "FAIL " + row.error}`);
        }
    }

    await restore();

    const after = snapshot();
    const codeChanges = [];
    let codeLines = 0;
    for (const f of new Set([...Object.keys(before), ...Object.keys(after)])) {
        if (before[f]?.sha256 === after[f]?.sha256) continue;
        const d = changedLines(before[f]?.text || "", after[f]?.text || "");
        codeLines += d.added + d.removed;
        codeChanges.push({ file: f, ...d });
    }
    const tdDiff = changedLines(fs.readFileSync(TEMPLATES.coap, "utf8"), fs.readFileSync(TEMPLATES.mqtt, "utf8"));
    const appFile = before["src/app/app.js"];
    const summary = {
        timestamp: new Date().toISOString(),
        relaySequence: sequence,
        codeFilesChecked: Object.keys(before).length,
        applicationCodeLinesChanged: codeLines,
        codeChanges,
        appSha256: appFile?.sha256,
        tdLinesChanged: tdDiff.added + tdDiff.removed,
        tdDiff,
        allPassed: rows.every((r) => r.pass),
        rows,
    };

    const md = [
        "# Protocol-swap interoperability test",
        "",
        `Run: ${summary.timestamp}  |  relay sequence: ${sequence.map((s) => s.toUpperCase()).join(" -> ")}`,
        "",
        "| # | relay protocol | app mode | app reaches fan via | temperature °C | fan ON after (ms) | fan OFF after (ms) | result |",
        "|---|---|---|---|---|---|---|---|",
        ...rows.map(
            (r, i) =>
                `| ${i + 1} | ${r.protocol.toUpperCase()} | ${r.mode} | ${r.appBoundTo} | ${r.temperature} | ${r.on ?? "-"} | ${r.off ?? "-"} | ${r.pass ? "PASS" : "FAIL: " + r.error} |`
        ),
        "",
        `- **Lines of application/gateway/device code changed: ${codeLines}** (target 0; ${summary.codeFilesChecked} source files hashed before and after)`,
        `- Files changed to move the relay: \`${path.relative(ROOT, RELAY_TD).replace(/\\/g, "/")}\` only — ${summary.tdLinesChanged} TD lines differ between the CoAP and MQTT variants`,
        `- src/app/app.js sha256: \`${summary.appSha256}\``,
        `- Overall: **${summary.allPassed ? "PASS" : "FAIL"}**`,
        "",
        "Time-to-actuate = time from writing the new threshold to the application Thing until the relay reports the new state",
        "(includes waiting for the next sensor measurement, i.e. up to SENSOR_INTERVAL_S).",
    ].join("\n");

    const outDir = path.join(ROOT, "results");
    fs.mkdirSync(outDir, { recursive: true });
    const stamp = summary.timestamp.replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(outDir, `swap-test-${stamp}.json`), JSON.stringify(summary, null, 2));
    fs.writeFileSync(path.join(outDir, `swap-test-${stamp}.md`), md + "\n");
    fs.writeFileSync(path.join(outDir, "swap-test-latest.md"), md + "\n");
    console.log("\n" + md);
    process.exit(summary.allPassed && codeLines === 0 ? 0 : 1);
}

main().catch(async (e) => {
    console.error("swap test failed:", e.message);
    await restore().catch(() => {});
    process.exit(2);
});
