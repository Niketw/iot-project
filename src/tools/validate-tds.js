"use strict";
/**
 * Validates Thing Descriptions with the W3C TD Playground validator
 * (@thing-description-playground/core - the same code as https://playground.thingweb.io).
 *
 *   node src/tools/validate-tds.js            # TD files in things/ and things/templates/
 *   node src/tools/validate-tds.js --live     # + every TD currently in the directory (incl. gateway proxies)
 *   node src/tools/validate-tds.js --jsonld   # + JSON-LD expansion check (needs Internet to fetch @context)
 *
 * Writes results/td-validation.json and results/td-validation.md. Exit code 1 if any TD fails.
 */
const fs = require("fs");
const path = require("path");
const { tdValidator } = require("@thing-description-playground/core");
const { loadConfig, fillTemplate } = require("../lib/config");

const cfg = loadConfig();
const args = process.argv.slice(2);
const LIVE = args.includes("--live");
const JSONLD = args.includes("--jsonld");

function collectFiles() {
    const out = [];
    for (const dir of ["things", "things/templates"]) {
        const abs = path.join(cfg.root, dir);
        if (!fs.existsSync(abs)) continue;
        for (const f of fs.readdirSync(abs).sort()) {
            if (!f.endsWith(".td.json")) continue;
            const raw = fs.readFileSync(path.join(abs, f), "utf8");
            out.push({ source: `${dir}/${f}`, text: fillTemplate(raw, cfg, { SIM_ID: "example-0" }) });
        }
    }
    return out;
}

async function collectLive() {
    const res = await fetch(`${cfg.directoryUrl}/things`);
    const tds = await res.json();
    const dirTd = await (await fetch(`${cfg.directoryUrl}/.well-known/wot`)).json();
    return [dirTd, ...tds].map((td) => {
        const { registration, ...rest } = td; // registration info is added by the directory
        return { source: `directory: ${td.id}`, text: JSON.stringify(rest) };
    });
}

async function validate({ source, text }) {
    const logs = [];
    const result = await tdValidator(text, (m) => logs.push(String(m)), {
        checkDefaults: true,
        checkJsonLd: JSONLD,
        checkTmConformance: false,
    });
    const r = result.report;
    const failedDetails = Object.entries(result.details || {})
        .filter(([, v]) => v === "failed")
        .map(([k]) => k);
    const pass = r.json === "passed" && r.schema === "passed" && (!JSONLD || r.jsonld === "passed") && failedDetails.length === 0;
    return { source, pass, report: r, failedDetails, log: logs.filter((l) => /fail|error|X /i.test(l)).slice(0, 5) };
}

(async () => {
    const inputs = collectFiles();
    if (LIVE) {
        try {
            inputs.push(...(await collectLive()));
        } catch (e) {
            console.error(`cannot read directory at ${cfg.directoryUrl}: ${e.message}`);
        }
    }
    const results = [];
    for (const input of inputs) results.push(await validate(input));

    const icon = (v) => ({ passed: "pass", failed: "FAIL", warning: "warn", null: "-" })[v] ?? String(v);
    const lines = [
        "# Thing Description validation",
        "",
        `Validator: W3C TD Playground core (@thing-description-playground/core), ${new Date().toISOString()}`,
        "",
        "| TD | JSON | TD 1.1 schema | full schema (defaults) | JSON-LD | extra checks | result |",
        "|---|---|---|---|---|---|---|",
    ];
    for (const r of results) {
        lines.push(
            `| ${r.source} | ${icon(r.report.json)} | ${icon(r.report.schema)} | ${icon(r.report.defaults)} | ${icon(r.report.jsonld)} | ${
                r.failedDetails.length ? "FAIL: " + r.failedDetails.join(", ") : icon(r.report.additional)
            } | **${r.pass ? "PASS" : "FAIL"}** |`
        );
    }
    const passed = results.filter((r) => r.pass).length;
    lines.push("", `**${passed}/${results.length} Thing Descriptions pass validation.**`);
    if (!JSONLD) lines.push("", "_JSON-LD check skipped (offline lab network). Run with `--jsonld` when the Pi has Internet access._");
    lines.push("", "_'warn' in the full-schema column means a default value (e.g. `readOnly: false`) is implicit — allowed by the spec._");

    fs.mkdirSync(path.join(cfg.root, "results"), { recursive: true });
    fs.writeFileSync(path.join(cfg.root, "results", "td-validation.json"), JSON.stringify(results, null, 2));
    fs.writeFileSync(path.join(cfg.root, "results", "td-validation.md"), lines.join("\n") + "\n");
    console.log(lines.join("\n"));
    for (const r of results.filter((x) => !x.pass)) console.log(`\n${r.source}:\n  ${r.log.join("\n  ")}`);
    process.exit(passed === results.length ? 0 : 1);
})();
