"use strict";
/**
 * Loads config/wot.env (+ defaults from wot.env.example); environment variables override.
 * Same file is used by systemd and the Python devices -> one source of truth.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

function parseEnvFile(file) {
    const out = {};
    if (!fs.existsSync(file)) return out;
    for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("#") || !line.includes("=")) continue;
        const idx = line.indexOf("=");
        const key = line.slice(0, idx).trim();
        let val = line.slice(idx + 1).split(" #")[0].trim();
        val = val.replace(/^["']|["']$/g, "");
        out[key] = val;
    }
    return out;
}

function detectHost() {
    try {
        const out = execSync("hostname -I", { stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).toString();
        const v4 = out.split(/\s+/).find((a) => a && !a.includes(":"));
        if (v4) return v4;
    } catch (_) {
        /* not Linux */
    }
    for (const iface of Object.values(os.networkInterfaces())) {
        for (const e of iface || []) if (e.family === "IPv4" && !e.internal) return e.address;
    }
    return "127.0.0.1";
}

function loadConfig() {
    const values = {
        ...parseEnvFile(path.join(PROJECT_ROOT, "config", "wot.env.example")),
        ...parseEnvFile(path.join(PROJECT_ROOT, "config", "wot.env")),
    };
    for (const key of Object.keys(values)) if (process.env[key] !== undefined) values[key] = process.env[key];
    for (const [k, v] of Object.entries(process.env)) if (/^(WOT|APP|GATEWAY|DIRECTORY)_/.test(k)) values[k] = v;
    if (!values.WOT_HOST || values.WOT_HOST === "auto") values.WOT_HOST = detectHost();

    const num = (k, d) => (values[k] === undefined || values[k] === "" ? d : Number(values[k]));
    const cfg = {
        raw: values,
        root: PROJECT_ROOT,
        host: values.WOT_HOST,
        mqttPort: num("MQTT_PORT", 1883),
        directoryPort: num("DIRECTORY_PORT", 8090),
        gatewayHttpPort: num("GATEWAY_HTTP_PORT", 8080),
        gatewayWsPort: num("GATEWAY_WS_PORT", 8081),
        appPort: num("APP_PORT", 8082),
        threshold: num("TEMP_THRESHOLD_C", 28),
        hysteresis: num("TEMP_HYSTERESIS_C", 1),
        appMode: values.APP_MODE || "gateway",
        notifyUrl: values.NOTIFY_URL || "",
        sensorIntervalS: num("SENSOR_INTERVAL_S", 2),
        syncIntervalS: num("GATEWAY_SYNC_INTERVAL_S", 3),
        graceS: num("GATEWAY_GRACE_S", 20),
        readTimeoutMs: num("GATEWAY_READ_TIMEOUT_MS", 5000),
        ttlS: num("DIRECTORY_TTL_S", 60),
        logLevel: values.LOG_LEVEL || "info",
    };
    // Local services always talk to the directory over loopback; TDs advertise cfg.host.
    cfg.directoryUrl = values.DIRECTORY_URL || `http://127.0.0.1:${cfg.directoryPort}`;
    return cfg;
}

/** Fill {{KEY}} placeholders of a TD template with config values. */
function fillTemplate(text, cfg, extra = {}) {
    const subs = { ...cfg.raw, ...extra };
    return text.replace(/\{\{(\w+)\}\}/g, (m, key) => (subs[key] !== undefined ? String(subs[key]) : m));
}

module.exports = { loadConfig, fillTemplate, PROJECT_ROOT };
