"use strict";
/**
 * Creates a node-wot Servient with all client bindings (HTTP, CoAP, MQTT) and,
 * optionally, HTTP / WebSocket servers for exposing Things.
 */
const { loadConfig } = require("./config");

const cfg = loadConfig();
if (!process.env.DEBUG) {
    const levels = { error: ["error"], warn: ["error", "warn"], info: ["error", "warn", "info"] };
    process.env.DEBUG =
        cfg.logLevel === "debug" ? "node-wot*" : (levels[cfg.logLevel] || levels.warn).map((l) => `node-wot:*:${l}`).join(",");
}

const { Servient, Helpers, ContentSerdes } = require("@node-wot/core");
const { HttpClientFactory, HttpServer } = require("@node-wot/binding-http");
const { CoapClientFactory } = require("@node-wot/binding-coap");
const { MqttClientFactory } = require("@node-wot/binding-mqtt");
const { WebSocketServer } = require("@node-wot/binding-websockets");

// node-wot 0.9.2 creates ONE content stream per form and hands it to every listener on
// that form, so two concurrent subscribers (e.g. app + dashboard long-polling the same
// event) race for the data and one receives an empty body. Give each listener its own copy.
const ProtocolListenerRegistry = require("@node-wot/core/dist/protocol-listener-registry").default;
const contentSerdes = require("@node-wot/core/dist/content-serdes").default; // singleton instance
ProtocolListenerRegistry.prototype.notify = function notify(affordance, data, schema, formIndex) {
    const formMap = this.listeners.get(affordance);
    if (!formMap) return;
    const deliver = (index, listeners) => {
        const contentType = affordance.forms[index].contentType;
        for (const listener of [...listeners]) listener(contentSerdes.valueToContent(data, schema, contentType));
    };
    if (formIndex !== undefined && formMap.has(formIndex)) return deliver(formIndex, formMap.get(formIndex));
    for (const [index, listeners] of formMap) deliver(index, listeners);
};

/**
 * @param {object} opts
 * @param {number} [opts.httpPort]  expose Things over HTTP on this port
 * @param {number} [opts.wsPort]    expose Things over WebSocket on this port
 */
async function createServient(opts = {}) {
    // Advertise exactly one address in generated TDs (the Pi's LAN IP) instead of every interface.
    Helpers.setStaticAddress(cfg.host);
    // Offer JSON only (node-wot also offers CBOR by default, doubling every form).
    ContentSerdes.get().offered.delete("application/cbor");

    const servient = new Servient();
    servient.addClientFactory(new HttpClientFactory());
    servient.addClientFactory(new CoapClientFactory());
    servient.addClientFactory(new MqttClientFactory());
    if (opts.httpPort) servient.addServer(new HttpServer({ port: opts.httpPort }));
    if (opts.wsPort) servient.addServer(new WebSocketServer({ port: opts.wsPort }));
    const WoT = await servient.start();
    return { servient, WoT, cfg };
}

/**
 * Work-arounds for two node-wot 0.9.2 issues in ExposedThing event delivery:
 *  1. The WebSocket server registers its listener once per form index, so a WS client
 *     would receive every event N times (N = number of forms).
 *  2. Listeners registered on the same form index share ONE content stream, so a WS
 *     client and an HTTP long-poll client on the same form steal each other's data.
 * Fix: each listener is registered exactly once, and a listener that also asks for a
 * ws:// form is moved onto that form (HTTP long-poll requests use the http:// forms).
 */
function dedupeSubscriptions(thing) {
    const wrap = (subName, unsubName, group) => {
        const sub = thing[subName].bind(thing);
        const unsub = thing[unsubName].bind(thing);
        const seen = new Map(); // name -> Map(listener -> formIndex)
        const isWsForm = (name, idx) => String(thing[group][name]?.forms?.[idx]?.href || "").startsWith("ws");
        thing[subName] = async (name, listener, options = {}) => {
            if (!seen.has(name)) seen.set(name, new Map());
            const m = seen.get(name);
            if (m.has(listener)) {
                const current = m.get(listener);
                if (isWsForm(name, options.formIndex) && !isWsForm(name, current)) {
                    try {
                        unsub(name, listener, { ...options, formIndex: current });
                    } catch (_) {
                        /* ignore */
                    }
                    m.set(listener, options.formIndex);
                    return sub(name, listener, options);
                }
                return;
            }
            m.set(listener, options.formIndex);
            return sub(name, listener, options);
        };
        thing[unsubName] = (name, listener, options = {}) => {
            const m = seen.get(name);
            if (!m || !m.has(listener)) return;
            const formIndex = m.get(listener);
            if (options.formIndex !== undefined && options.formIndex !== formIndex) return;
            m.delete(listener);
            try {
                return unsub(name, listener, { ...options, formIndex });
            } catch (_) {
                /* already gone */
            }
        };
    };
    wrap("handleSubscribeEvent", "handleUnsubscribeEvent", "events");
    wrap("handleObserveProperty", "handleUnobserveProperty", "properties");
    return thing;
}

function withTimeout(promise, ms, what) {
    let timer;
    return Promise.race([
        promise,
        new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`timeout after ${ms} ms: ${what}`)), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

module.exports = { createServient, dedupeSubscriptions, withTimeout, cfg };
