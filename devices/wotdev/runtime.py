"""TD-driven device runtime.

A device implements *what* it does (read/write/action handlers, emit events).
*How* it is reached is decided only by its Thing Description: for every form the
runtime looks at the href scheme (http / coap / mqtt) and the `op`, and binds
the handler to the right protocol endpoint.

Consequence: changing a device's protocol = editing its TD. No device code changes.

Protocol mapping (matches the node-wot client bindings):

    op               HTTP                 CoAP                   MQTT
    readproperty     GET  -> value        GET  -> value          retained publish on topic
    writeproperty    PUT  body=value      PUT  payload=value     subscribe topic, payload=value
    invokeaction     POST body=input      POST payload=input     subscribe topic, payload=input
    subscribeevent   GET  long-poll       GET  + Observe         publish on topic
"""
import asyncio
import json
import logging
import threading
import uuid
from collections import defaultdict
from urllib.parse import urljoin, urlparse

log = logging.getLogger("wotdev.runtime")

JSON_CF = 50  # CoAP content-format application/json


def _ops(form, kind, affordance):
    op = form.get("op")
    if op is None:
        if kind == "property":
            ops = []
            if not affordance.get("writeOnly"):
                ops.append("readproperty")
            if not affordance.get("readOnly"):
                ops.append("writeproperty")
            return ops
        return {"action": ["invokeaction"], "event": ["subscribeevent"]}[kind]
    return [op] if isinstance(op, str) else list(op)


def _decode(payload: bytes):
    if not payload:
        return None
    return json.loads(payload.decode("utf-8"))


def _encode(value) -> bytes:
    return json.dumps(value).encode("utf-8")


# --------------------------------------------------------------------------- HTTP
class _LongPollChannel:
    def __init__(self):
        self.waiters = set()
        self.last = None

    async def wait(self):
        fut = asyncio.get_running_loop().create_future()
        self.waiters.add(fut)
        try:
            return await fut
        finally:
            self.waiters.discard(fut)

    def emit(self, data):
        self.last = data
        for fut in list(self.waiters):
            if not fut.done():
                fut.set_result(data)


class HttpHub:
    _hubs = {}

    @classmethod
    async def get(cls, port):
        if port not in cls._hubs:
            hub = cls(port)
            await hub.start()
            cls._hubs[port] = hub
        return cls._hubs[port]

    def __init__(self, port):
        self.port = port
        self.routes = {}  # (METHOD, path) -> async handler(request) -> Response

    async def start(self):
        from aiohttp import web
        self.web = web
        app = web.Application(client_max_size=1024 * 1024)
        app.router.add_route("*", "/{tail:.*}", self._dispatch)
        self.runner = web.AppRunner(app, access_log=None, handle_signals=False)
        await self.runner.setup()
        await web.TCPSite(self.runner, "0.0.0.0", self.port).start()
        log.info("HTTP server listening on :%d", self.port)

    async def _dispatch(self, request):
        web = self.web
        cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, PUT, POST, HEAD, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type"}
        if request.method == "OPTIONS":
            return web.Response(status=204, headers=cors)
        handler = self.routes.get((request.method, request.path))
        if handler is None and request.method == "HEAD" and ("GET", request.path) in self.routes:
            return web.Response(status=200, headers=cors)  # node-wot long-poll handshake
        if handler is None:
            allowed = [m for (m, p) in self.routes if p == request.path]
            status = 405 if allowed else 404
            return web.json_response({"error": "method not allowed" if allowed else "not found"}, status=status, headers=cors)
        try:
            resp = await handler(request)
        except Exception as exc:  # pragma: no cover - surfaced to the client
            log.exception("HTTP handler failed")
            resp = web.json_response({"error": str(exc)}, status=500)
        resp.headers.update(cors)
        return resp

    async def stop(self):
        await self.runner.cleanup()


# --------------------------------------------------------------------------- CoAP
class CoapHub:
    _hubs = {}

    @classmethod
    async def get(cls, port, host_hint=None):
        if port not in cls._hubs:
            hub = cls(port, host_hint)
            await hub.start()
            cls._hubs[port] = hub
        return cls._hubs[port]

    def __init__(self, port, host_hint=None):
        import aiocoap.resource as resource
        self.port = port
        self.host_hint = host_hint  # the host in the TD's coap:// hrefs, i.e. the address clients will use
        self.site = resource.Site()
        self.resources = {}

    async def start(self):
        """Bind the CoAP server. Tries IPv6 "any" first (dual-stack: also serves IPv4), then the IPv4
        address from the TD hrefs - needed on Pis with IPv6 disabled ("no local bindable address found
        for ::"). aiocoap's IPv4 transport cannot bind to 0.0.0.0, so a concrete address is used.
        COAP_BIND may override this with a comma-separated list of addresses to try in order."""
        import os
        import aiocoap
        hint = self.host_hint or "127.0.0.1"
        default = hint if os.name == "nt" else f"::,{hint}"
        hosts = [h.strip() for h in (os.environ.get("COAP_BIND") or default).split(",") if h.strip()]
        last_exc = None
        for host in hosts:
            # an IPv4 address needs a transport that can open an IPv4 socket (udp6 is IPv6-only)
            transports = ["simplesocketserver"] if ":" not in host else None
            try:
                self.ctx = await aiocoap.Context.create_server_context(self.site, bind=(host, self.port), transports=transports)
                log.info("CoAP server listening on udp/%d (bound to %s)", self.port, host)
                return
            except Exception as exc:  # e.g. aiocoap.error.ResolutionError when IPv6 is disabled
                last_exc = exc
                log.warning("CoAP bind to %s failed (%s: %s) - trying next address", host, type(exc).__name__, exc)
        raise RuntimeError(f"could not bind CoAP server on port {self.port} (tried {', '.join(hosts)})") from last_exc

    def resource(self, path):
        key = tuple(seg for seg in path.split("/") if seg)
        if key not in self.resources:
            res = _CoapAffordance(path)
            self.site.add_resource(key, res)
            self.resources[key] = res
        return self.resources[key]

    async def stop(self):
        await self.ctx.shutdown()


def _make_coap_resource_class():
    import aiocoap
    import aiocoap.resource as resource

    class CoapAffordance(resource.ObservableResource):
        def __init__(self, path):
            super().__init__()
            self.path = path
            self.get_h = None
            self.put_h = None
            self.post_h = None
            self.is_event = False
            self.last_event = None

        def _json(self, value, code=aiocoap.CONTENT):
            return aiocoap.Message(code=code, payload=_encode(value), content_format=JSON_CF)

        async def render_get(self, request):
            if self.is_event:
                return self._json(self.last_event)
            if self.get_h is None:
                return aiocoap.Message(code=aiocoap.METHOD_NOT_ALLOWED)
            return self._json(await self.get_h())

        async def render_put(self, request):
            if self.put_h is None:
                return aiocoap.Message(code=aiocoap.METHOD_NOT_ALLOWED)
            await self.put_h(_decode(request.payload))
            return aiocoap.Message(code=aiocoap.CHANGED)

        async def render_post(self, request):
            if self.post_h is None:
                return aiocoap.Message(code=aiocoap.METHOD_NOT_ALLOWED)
            out = await self.post_h(_decode(request.payload))
            if out is None:
                return aiocoap.Message(code=aiocoap.CHANGED)
            return self._json(out, code=aiocoap.CHANGED)

        def notify(self, data):
            self.last_event = data
            self.updated_state()

    return CoapAffordance


_CoapAffordanceClass = None


def _CoapAffordance(path):
    global _CoapAffordanceClass
    if _CoapAffordanceClass is None:
        _CoapAffordanceClass = _make_coap_resource_class()
    return _CoapAffordanceClass(path)


# --------------------------------------------------------------------------- MQTT
class MqttHub:
    _hubs = {}

    @classmethod
    async def get(cls, host, port):
        key = (host, port)
        if key not in cls._hubs:
            hub = cls(host, port)
            await hub.start()
            cls._hubs[key] = hub
        return cls._hubs[key]

    def __init__(self, host, port):
        self.host, self.port = host, port
        self.subs = {}       # topic -> async callback(payload)
        self.retained = {}   # topic -> payload (re-published after reconnect)
        self.connected = threading.Event()

    async def start(self):
        import paho.mqtt.client as mqtt
        self.loop = asyncio.get_running_loop()
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"wotdev-{uuid.uuid4().hex[:8]}")
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.reconnect_delay_set(1, 10)
        self.client.connect_async(self.host, self.port, keepalive=30)
        self.client.loop_start()
        for _ in range(100):  # wait up to 10 s for the first connection
            if self.connected.is_set():
                break
            await asyncio.sleep(0.1)
        if not self.connected.is_set():
            log.warning("MQTT broker %s:%d not reachable yet - will keep retrying", self.host, self.port)

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if getattr(reason_code, "is_failure", False):
            log.error("MQTT connect failed: %s", reason_code)
            return
        log.info("MQTT connected to %s:%d", self.host, self.port)
        for topic in self.subs:
            client.subscribe(topic, qos=1)
        for topic, payload in self.retained.items():
            client.publish(topic, payload, qos=1, retain=True)
        self.connected.set()

    def _on_message(self, client, userdata, msg):
        cb = self.subs.get(msg.topic)
        if cb is not None:
            asyncio.run_coroutine_threadsafe(self._run_cb(cb, msg.topic, msg.payload), self.loop)

    async def _run_cb(self, cb, topic, payload):
        try:
            await cb(payload)
        except Exception:
            log.exception("MQTT handler for %s failed", topic)

    def subscribe(self, topic, cb):
        self.subs[topic] = cb
        if self.connected.is_set():
            self.client.subscribe(topic, qos=1)

    def publish(self, topic, payload: bytes, retain=False, qos=0):
        if retain:
            self.retained[topic] = payload
        self.client.publish(topic, payload, qos=qos, retain=retain)

    async def stop(self):
        self.client.loop_stop()
        self.client.disconnect()


# --------------------------------------------------------------------------- Thing
class ThingRuntime:
    """Binds a TD's affordances to handlers over whatever protocols its forms declare."""

    def __init__(self, td: dict):
        self.td = td
        self.id = td.get("id")
        self.read_handlers = {}
        self.write_handlers = {}
        self.action_handlers = {}
        self._event_sinks = defaultdict(list)     # event name -> [callable(data)]
        self._property_sinks = defaultdict(list)  # property name -> [async callable()]
        self.schemes = set()

    # -- handler registration (protocol independent) --
    def on_read(self, name, fn):
        self.read_handlers[name] = fn

    def on_write(self, name, fn):
        self.write_handlers[name] = fn

    def on_action(self, name, fn):
        self.action_handlers[name] = fn

    def emit_event(self, name, data):
        for sink in self._event_sinks[name]:
            sink(data)

    async def property_changed(self, name):
        """Call after a property value changes (needed for MQTT retained reads)."""
        for sink in self._property_sinks[name]:
            await sink()

    # -- binding --
    async def start(self):
        base = self.td.get("base", "")
        for kind, group in (("property", "properties"), ("action", "actions"), ("event", "events")):
            for name, aff in (self.td.get(group) or {}).items():
                for form in aff.get("forms", []):
                    href = urljoin(base, form["href"]) if base else form["href"]
                    await self._bind(kind, name, aff, form, href)
        log.info("%s bound over %s", self.td.get("title"), ", ".join(sorted(self.schemes)) or "nothing")

    async def _read(self, name):
        return await self.read_handlers[name]()

    async def _write(self, name, value):
        await self.write_handlers[name](value)

    async def _invoke(self, name, value):
        return await self.action_handlers[name](value)

    async def _bind(self, kind, name, aff, form, href):
        url = urlparse(href)
        scheme = url.scheme
        ops = _ops(form, kind, aff)
        self.schemes.add(scheme)
        if scheme == "http":
            await self._bind_http(name, form, url, ops)
        elif scheme == "coap":
            await self._bind_coap(name, url, ops)
        elif scheme == "mqtt":
            await self._bind_mqtt(name, form, url, ops)
        else:
            raise ValueError(f"Unsupported scheme {scheme!r} in {href}")

    async def _bind_http(self, name, form, url, ops):
        hub = await HttpHub.get(url.port or 80)
        web = hub.web
        path = url.path
        for op in ops:
            if op == "readproperty":
                async def h(req, n=name):
                    return web.json_response(await self._read(n))
                hub.routes[(form.get("htv:methodName", "GET"), path)] = h
            elif op == "writeproperty":
                async def h(req, n=name):
                    body = await req.read()
                    await self._write(n, _decode(body))
                    return web.Response(status=204)
                hub.routes[(form.get("htv:methodName", "PUT"), path)] = h
            elif op == "invokeaction":
                async def h(req, n=name):
                    body = await req.read()
                    out = await self._invoke(n, _decode(body))
                    return web.Response(status=204) if out is None else web.json_response(out)
                hub.routes[(form.get("htv:methodName", "POST"), path)] = h
            elif op in ("subscribeevent", "observeproperty"):
                channel = _LongPollChannel()
                if op == "subscribeevent":
                    self._event_sinks[name].append(channel.emit)
                else:
                    async def push(n=name, ch=channel):
                        ch.emit(await self._read(n))
                    self._property_sinks[name].append(push)

                async def h(req, ch=channel):
                    return web.json_response(await ch.wait())
                hub.routes[(form.get("htv:methodName", "GET"), path)] = h

    async def _bind_coap(self, name, url, ops):
        hub = await CoapHub.get(url.port or 5683, url.hostname)
        res = hub.resource(url.path)
        for op in ops:
            if op == "readproperty":
                res.get_h = lambda n=name: self._read(n)
            elif op == "writeproperty":
                res.put_h = lambda v, n=name: self._write(n, v)
            elif op == "invokeaction":
                res.post_h = lambda v, n=name: self._invoke(n, v)
            elif op == "subscribeevent":
                res.is_event = True
                self._event_sinks[name].append(res.notify)
            elif op == "observeproperty":
                async def push(n=name, r=res):
                    r.updated_state()
                self._property_sinks[name].append(push)

    async def _bind_mqtt(self, name, form, url, ops):
        hub = await MqttHub.get(url.hostname, url.port or 1883)
        topic = url.path.lstrip("/")
        qos = int(form.get("mqv:qos", 0))
        for op in ops:
            if op == "readproperty":
                async def publish_value(n=name, t=topic):
                    hub.publish(t, _encode(await self._read(n)), retain=True, qos=1)
                self._property_sinks[name].append(publish_value)
                await publish_value()
            elif op == "writeproperty":
                async def on_write(payload, n=name):
                    await self._write(n, _decode(payload))
                hub.subscribe(topic, on_write)
            elif op == "invokeaction":
                async def on_invoke(payload, n=name):
                    await self._invoke(n, _decode(payload))
                hub.subscribe(topic, on_invoke)
            elif op == "subscribeevent":
                self._event_sinks[name].append(lambda data, t=topic, q=qos: hub.publish(t, _encode(data), qos=q))
            elif op == "observeproperty":
                async def publish_change(n=name, t=topic):
                    hub.publish(t, _encode(await self._read(n)), qos=qos)
                self._property_sinks[name].append(publish_change)


async def stop_all_hubs():
    for hub_cls in (HttpHub, CoapHub, MqttHub):
        for hub in list(hub_cls._hubs.values()):
            try:
                await hub.stop()
            except Exception:
                pass
        hub_cls._hubs.clear()
