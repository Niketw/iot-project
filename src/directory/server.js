"use strict";
/**
 * Thing Description Directory (TDD) - subset of the W3C WoT Discovery 1.0 "Things API".
 *
 *   GET    /.well-known/wot      the directory's own TD (WoT.exploreDirectory() entry point)
 *   GET    /things               all TDs (array, application/ld+json)
 *   GET    /things/{id}          one TD
 *   PUT    /things/{id}          create (201) or update (204) - TD is JSON-Schema validated
 *   POST   /things               anonymous TD -> 201 + Location
 *   DELETE /things/{id}          204
 *   GET    /                     dashboard
 *
 * Registrations carry `registration.ttl`; entries not refreshed within ttl expire.
 * State is persisted to data/directory.json so a restart keeps registrations.
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const { loadConfig } = require("../lib/config");

const cfg = loadConfig();
const DATA_DIR = path.join(cfg.root, "data");
const DATA_FILE = path.join(DATA_DIR, "directory.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const log = (...a) => console.log(new Date().toISOString(), "[directory]", ...a);

// ---------------------------------------------------------------- validation
// Official TD 1.1 JSON Schema (the one the W3C TD Playground uses), compiled once.
const tdSchema = require("@thing-description-playground/core/td-schema.json");
const ajv = addFormats(new Ajv({ strict: false, allErrors: false, validateFormats: false }));
const validateTd = ajv.compile(tdSchema);

// ---------------------------------------------------------------- store
/** @type {Map<string, {td:object, created:string, modified:string, expires:number|null, hash:string}>} */
const things = new Map();

function tdHash(td) {
    const { registration, ...rest } = td;
    return crypto.createHash("sha1").update(JSON.stringify(rest)).digest("hex");
}

function load() {
    try {
        const arr = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
        for (const e of arr) things.set(e.td.id, e);
        log(`restored ${things.size} registrations from ${DATA_FILE}`);
    } catch (_) {
        /* first start */
    }
}

let saveTimer = null;
function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify([...things.values()]));
        fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
    }, 500);
}

function expire() {
    const now = Date.now();
    let n = 0;
    for (const [id, e] of things) {
        if (e.expires && e.expires < now) {
            things.delete(id);
            n++;
            log(`expired ${id}`);
        }
    }
    if (n) save();
}
setInterval(expire, 5000).unref();

function withRegistration(e) {
    return {
        ...e.td,
        registration: {
            ...(e.td.registration || {}),
            created: e.created,
            modified: e.modified,
            ...(e.expires ? { expires: new Date(e.expires).toISOString() } : {}),
            retrieved: new Date().toISOString(),
        },
    };
}

function upsert(id, td) {
    const now = new Date().toISOString();
    const ttl = Number(td.registration?.ttl) || 0;
    const hash = tdHash(td);
    const existing = things.get(id);
    const entry = {
        td: { ...td, id, registration: ttl ? { ttl } : undefined },
        created: existing ? existing.created : now,
        modified: existing && existing.hash === hash ? existing.modified : now,
        expires: ttl ? Date.now() + ttl * 1000 : null,
        hash,
    };
    if (!entry.td.registration) delete entry.td.registration;
    things.set(id, entry);
    if (!existing || existing.hash !== hash) save();
    return !existing;
}

// ---------------------------------------------------------------- directory TD
function directoryTd() {
    const base = `http://${cfg.host}:${cfg.directoryPort}`;
    return {
        "@context": ["https://www.w3.org/2022/wot/td/v1.1", "https://www.w3.org/2022/wot/discovery"],
        "@type": "ThingDirectory",
        id: "urn:wot:directory",
        title: "Thing Description Directory",
        description: "Registry of all Thing Descriptions in the smart building (W3C WoT Discovery Things API subset).",
        securityDefinitions: { nosec_sc: { scheme: "nosec" } },
        security: "nosec_sc",
        base,
        properties: {
            things: {
                title: "All Thing Descriptions",
                type: "array",
                items: { type: "object" },
                readOnly: true,
                forms: [{ href: "/things", op: "readproperty", contentType: "application/ld+json", "htv:methodName": "GET" }],
            },
        },
        actions: {
            createThing: {
                input: { type: "object" },
                forms: [{ href: "/things/{id}", op: "invokeaction", contentType: "application/td+json", "htv:methodName": "PUT" }],
                uriVariables: { id: { type: "string" } },
            },
            retrieveThing: {
                output: { type: "object" },
                safe: true,
                idempotent: true,
                forms: [{ href: "/things/{id}", op: "invokeaction", contentType: "application/td+json", "htv:methodName": "GET" }],
                uriVariables: { id: { type: "string" } },
            },
            deleteThing: {
                idempotent: true,
                forms: [{ href: "/things/{id}", op: "invokeaction", "htv:methodName": "DELETE" }],
                uriVariables: { id: { type: "string" } },
            },
        },
    };
}

// ---------------------------------------------------------------- HTTP
function send(res, status, body, type = "application/json") {
    const headers = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, PUT, POST, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };
    if (body === undefined) {
        res.writeHead(status, headers);
        return res.end();
    }
    const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { ...headers, "Content-Type": type });
    res.end(data);
}

function problem(res, status, title, detail) {
    send(res, status, { type: "about:blank", title, status, detail }, "application/problem+json");
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (c) => {
            size += c.length;
            if (size > 2 * 1024 * 1024) reject(new Error("body too large"));
            chunks.push(c);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}

async function handleUpsert(req, res, id) {
    let td;
    try {
        td = JSON.parse(await readBody(req));
    } catch (e) {
        return problem(res, 400, "Invalid JSON", e.message);
    }
    if (id && td.id && td.id !== id) return problem(res, 400, "ID mismatch", `URL id ${id} != TD id ${td.id}`);
    if (!id) id = td.id || `urn:uuid:${crypto.randomUUID()}`;
    const existing = things.get(id);
    // Heartbeats re-send an identical TD - skip the (expensive) validation then.
    if (!existing || existing.hash !== tdHash(td)) {
        if (!validateTd({ ...td, id })) {
            const errs = (validateTd.errors || []).slice(0, 5).map((e) => `${e.instancePath || "/"} ${e.message}`);
            log(`rejected ${id}: ${errs.join("; ")}`);
            return problem(res, 400, "Thing Description failed TD 1.1 JSON Schema validation", errs.join("; "));
        }
    }
    const created = upsert(id, td);
    if (created) log(`registered ${id} (${td.title})`);
    else if (existing.hash !== tdHash(td)) log(`updated ${id}`);
    if (req.method === "POST") res.setHeader("Location", `/things/${encodeURIComponent(id)}`);
    return send(res, created ? 201 : 204);
}

function serveStatic(res, file) {
    const p = path.join(PUBLIC_DIR, file);
    if (!p.startsWith(PUBLIC_DIR) || !fs.existsSync(p)) return problem(res, 404, "Not found");
    const ext = path.extname(p);
    const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" }[ext] || "application/octet-stream";
    send(res, 200, fs.readFileSync(p), type);
}

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, "http://localhost");
        const parts = url.pathname.split("/").filter(Boolean);
        if (req.method === "OPTIONS") return send(res, 204);

        if (url.pathname === "/.well-known/wot") return send(res, 200, directoryTd(), "application/td+json");

        if (parts[0] === "things") {
            if (parts.length === 1) {
                if (req.method === "GET") {
                    expire();
                    let list = [...things.values()].map(withRegistration);
                    const type = url.searchParams.get("type");
                    if (type) list = list.filter((td) => [].concat(td["@type"] || []).includes(type));
                    return send(res, 200, list, "application/ld+json");
                }
                if (req.method === "POST") return handleUpsert(req, res, null);
                return problem(res, 405, "Method not allowed");
            }
            const id = decodeURIComponent(parts.slice(1).join("/"));
            if (req.method === "GET") {
                const e = things.get(id);
                return e ? send(res, 200, withRegistration(e), "application/td+json") : problem(res, 404, "Not found", id);
            }
            if (req.method === "PUT") return handleUpsert(req, res, id);
            if (req.method === "DELETE") {
                const existed = things.delete(id);
                if (existed) {
                    log(`deleted ${id}`);
                    save();
                }
                return existed ? send(res, 204) : problem(res, 404, "Not found", id);
            }
            return problem(res, 405, "Method not allowed");
        }

        if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/dashboard")) return serveStatic(res, "index.html");
        if (req.method === "GET" && parts[0] === "static") return serveStatic(res, parts.slice(1).join("/"));
        if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true, things: things.size });
        return problem(res, 404, "Not found");
    } catch (e) {
        log("error", e);
        return problem(res, 500, "Internal error", e.message);
    }
});

load();
server.listen(cfg.directoryPort, "0.0.0.0", () => {
    log(`Thing Directory on http://${cfg.host}:${cfg.directoryPort}  (dashboard: /, API: /things, TD: /.well-known/wot)`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
        clearTimeout(saveTimer);
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(DATA_FILE, JSON.stringify([...things.values()]));
        process.exit(0);
    });
}
