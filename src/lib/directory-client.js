"use strict";
/** Minimal client for the Thing Description Directory (WoT Discovery Things API). */

class DirectoryClient {
    constructor(baseUrl, ttlS = 60) {
        this.base = baseUrl.replace(/\/$/, "");
        this.ttl = ttlS;
        this.registered = new Map(); // id -> td
        this.lastBeat = Date.now();
    }

    url(id) {
        return `${this.base}/things/${encodeURIComponent(id)}`;
    }

    async list(type) {
        const res = await fetch(`${this.base}/things${type ? `?type=${encodeURIComponent(type)}` : ""}`);
        if (!res.ok) throw new Error(`directory HTTP ${res.status}`);
        return res.json();
    }

    async get(id) {
        const res = await fetch(this.url(id));
        return res.ok ? res.json() : null;
    }

    async put(td) {
        const res = await fetch(this.url(td.id), {
            method: "PUT",
            headers: { "Content-Type": "application/td+json" },
            body: JSON.stringify({ ...td, registration: { ttl: this.ttl } }),
        });
        if (!res.ok) throw new Error(`directory rejected ${td.id}: HTTP ${res.status} ${await res.text()}`);
    }

    async register(td) {
        this.registered.set(td.id, td);
        await this.put(td);
    }

    async unregister(id) {
        this.registered.delete(id);
        await fetch(this.url(id), { method: "DELETE" });
    }

    /** Re-PUT our registrations every TTL/3 so they do not expire. */
    async heartbeat(force = false) {
        if (!force && Date.now() - this.lastBeat < (this.ttl * 1000) / 3) return;
        this.lastBeat = Date.now();
        for (const td of this.registered.values()) {
            await this.put(td).catch(() => {});
        }
    }

    startHeartbeat() {
        this.timer = setInterval(() => this.heartbeat(true), Math.max(5000, (this.ttl * 1000) / 3));
        this.timer.unref();
    }
}

module.exports = { DirectoryClient };
