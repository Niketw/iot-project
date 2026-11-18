# How every component works

This document explains the system piece by piece: what each component does, how it does it, which files
implement it, and why it was designed that way. Read it top to bottom once; afterwards each section stands
on its own.

## Contents

1. [The big picture](#1-the-big-picture)
2. [W3C Web of Things in 5 minutes](#2-w3c-web-of-things-in-5-minutes)
3. [Thing Descriptions (`things/`)](#3-thing-descriptions-things)
4. [The devices (`devices/`)](#4-the-devices-devices)
5. [MQTT broker (Mosquitto)](#5-mqtt-broker-mosquitto)
6. [Thing Description Directory (`src/directory/`)](#6-thing-description-directory-srcdirectory)
7. [The gateway (`src/gateway/`)](#7-the-gateway-srcgateway)
8. [The application (`src/app/`, `src/lib/app-runtime.js`)](#8-the-application)
9. [Dashboard](#9-dashboard)
10. [Evaluation tools](#10-evaluation-tools)
11. [Configuration, installer, services](#11-configuration-installer-services)
12. [End-to-end walkthroughs](#12-end-to-end-walkthroughs)
13. [node-wot 0.9.2 issues found and how they are handled](#13-node-wot-092-issues-found-and-how-they-are-handled)

---

## 1. The big picture

```
 ┌─────────────── devices (Python, one per systemd service) ───────────────┐
 │  Temperature Sensor  (DHT22, GPIO4)   native protocol: MQTT              │
 │  Fan Relay           (relay, GPIO17)  native protocol: CoAP  ⇄  MQTT     │
 │  Heater Smart Plug   (simulated)      native protocol: HTTP              │
 └─────────┬──────────────────┬───────────────────┬─────────────────────────┘
           │MQTT (Mosquitto)  │CoAP (UDP 5683)    │HTTP (8091)
           │  each device registers its Thing Description in ↓
           │                  │                   │
 ┌─────────▼──────────────────▼───────────────────▼────────┐   ┌────────────────────────┐
 │ GATEWAY (node-wot)                                       │◀──│ THING DIRECTORY :8090  │
 │  ConsumedThing per device  ──►  ExposedThing (proxy)     │──▶│ GET/PUT/DELETE /things │
 │  speaks MQTT/CoAP/HTTP          served on HTTP :8080     │   │ TD validation, TTL     │
 │                                 and WebSocket :8081      │   │ dashboard  /           │
 └──────────────────────────────┬───────────────────────────┘   └───────────▲────────────┘
                                │ HTTP / WS (one uniform interface)         │ discover
                      ┌─────────▼───────────────────────────────────────────┴──┐
                      │ APPLICATION "Climate Controller" (node-wot)  :8082      │
                      │ finds devices by @type, uses only TD affordances        │
                      │ temp > threshold → fan.turnOn, heater.turnOff, notify   │
                      └─────────────────────────────────────────────────────────┘
```

Six processes run on the Pi, plus Mosquitto: `wot-directory`, `wot-sensor`, `wot-relay`, `wot-plug`,
`wot-gateway` and `wot-app`. They only know each other through **Thing Descriptions** stored in the directory.
No component has another component's protocol, topic or port hard-coded, apart from the directory URL.

**Startup order (self-healing, so order does not really matter):**
directory → devices register their TDs → gateway sees them and creates proxies, registering *proxy* TDs →
application discovers the proxies (or the device TDs in `direct` mode) and binds.

## 2. W3C Web of Things in 5 minutes

- A **Thing** is any device or service. Its **Thing Description (TD)** is a JSON-LD document describing
  - **properties**: state you can read or write (`temperature`, `on`)
  - **actions**: things you can invoke (`turnOn`, `toggle`)
  - **events**: notifications you can subscribe to (`measurement`, `stateChanged`)
  - and for each of those, one or more **forms**: `href` + `op` (operation) + protocol details.
    The form is the **only** protocol-specific part of a TD.
- A **WoT runtime** such as Eclipse Thingweb **node-wot** gives applications the *Scripting API*:
  - `WoT.consume(td)` → a **ConsumedThing**: `readProperty`, `writeProperty`, `invokeAction`, `subscribeEvent`.
    node-wot picks a form whose protocol it supports and talks MQTT/CoAP/HTTP for you.
  - `WoT.produce(init)` → an **ExposedThing**: you register handlers and node-wot serves the Thing over its
    configured servers (HTTP, WebSocket, …), generating the forms of its TD automatically.
  - `WoT.exploreDirectory(url)` → iterate over the TDs held by a Thing Description Directory.
- **Protocol bindings** define how `op`s map to a protocol (e.g. `readproperty` = HTTP GET, CoAP GET, or
  "read the retained MQTT message on this topic").

The whole project rests on this one idea: **if the application only uses names from the TD (`temperature`,
`turnOn`, `stateChanged`), then everything protocol-specific lives in the forms, and changing the protocol
means changing the forms, not the application.**

## 3. Thing Descriptions (`things/`)

| File | Thing | Native protocol |
|---|---|---|
| `things/temperature-sensor.td.json` | DHT22 temperature sensor | MQTT |
| `things/fan-relay.td.json` | fan relay (**the file the protocol swap replaces**) | CoAP (or MQTT) |
| `things/smart-plug.td.json` | simulated heater plug | HTTP |
| `things/templates/*.td.json` | the released templates: sensor, plug, **relay CoAP + relay MQTT**, simulated devices for all 3 protocols | |

**Templates and placeholders.** Hrefs contain placeholders such as `{{WOT_HOST}}`, `{{MQTT_PORT}}`,
`{{COAP_PORT}}`, `{{SIM_ID}}`, filled from `config/wot.env` when a device starts. The same TD works on any
Pi and any IP address.

**Semantic annotation.** Every TD has an `@context` with the TD 1.1 context plus a few prefixes, and an
`@type`:

| Thing | `@type` |
|---|---|
| Sensor | `saref:TemperatureSensor` |
| Relay | `saref:Switch`, `bldg:FanController` |
| Plug | `saref:Switch`, `bldg:SmartPlug` |

[SAREF](https://saref.etsi.org/) is the ETSI smart-appliance ontology; `bldg:` is a small project
namespace. The application selects devices by these types, never by address or protocol.

**How each protocol is described in the forms:**

| | MQTT (sensor, relay-MQTT) | CoAP (relay-CoAP) | HTTP (plug) |
|---|---|---|---|
| read property | `mqtt://host:1883/<topic>` + `op: readproperty`, value is a **retained** message | `coap://host:5683/fan/properties/on`, `cov:method: GET` | `http://host:8091/plug/properties/on`, `htv:methodName: GET` |
| write property | separate topic `…/on/set` (otherwise the device would read back its own retained value) | same path, `PUT` | same path, `PUT` |
| action | topic `…/actions/turnOn`, `mqv:qos: "1"` | `POST` | `POST` |
| event | topic `…/events/stateChanged` | `subprotocol: cov:observe` (CoAP Observe, RFC 7641) | `subprotocol: longpoll` |

**Identical affordances across protocols.** The CoAP and MQTT relay TDs have exactly the same property,
action and event names and data schemas. Only the forms differ (19 lines). That is what makes the swap
transparent. Events carry `ts` (device Unix time in ms) and `seq`, which the latency benchmark uses.

**Validation.** All TDs pass the official TD 1.1 JSON Schema, the full schema with defaults, and the extra
assertions of the W3C TD Playground, plus JSON-LD expansion when Internet access is available
(`./wotctl validate`, see §10).

## 4. The devices (`devices/`)

### 4.1 The TD-driven device runtime (`devices/wotdev/runtime.py`)

**The idea:** a device implements only *behaviour*, as handlers. Its *protocol* is decided entirely by its
TD. At start-up `ThingRuntime.start()` walks every form of the TD and, based on the href scheme and `op`,
binds the handler to the right endpoint:

```python
thing = ThingRuntime(td)                 # td loaded from things/fan-relay.td.json
thing.on_read("on", read_on)             # protocol-independent handlers
thing.on_write("on", write_on)
thing.on_action("turnOn", turn_on)
thing.emit_event("stateChanged", {...})  # whenever the state changes
await thing.property_changed("on")       # republishes retained MQTT value, notifies observers
```

| op | `http://` → `HttpHub` (aiohttp) | `coap://` → `CoapHub` (aiocoap) | `mqtt://` → `MqttHub` (paho-mqtt) |
|---|---|---|---|
| `readproperty` | route `GET path` → JSON of handler result | resource GET | publish value **retained** on topic, re-publish on every `property_changed` |
| `writeproperty` | route `PUT path` → handler(body) | resource PUT | subscribe topic → handler(payload) |
| `invokeaction` | route `POST path` → handler(body) | resource POST | subscribe topic → handler(payload) |
| `subscribeevent` | route `GET path` blocks until the next event (long-poll); `HEAD` answers the node-wot handshake | `ObservableResource`; `emit_event` triggers an Observe notification | publish JSON on topic |

**Hubs** are shared per port or broker. 100 simulated HTTP devices therefore share one aiohttp server and
dispatch on the path; CoAP devices share one aiocoap `Site`; MQTT devices share one client connection. The
MQTT hub re-subscribes and re-publishes retained values after a broker reconnect.

**Consequence:** to move the relay from CoAP to MQTT you only swap its TD file. `relay_actuator.py` has no
CoAP or MQTT code at all.

### 4.2 Registration (`devices/wotdev/directory.py`)

Each device process implements the WoT Discovery lifecycle against the directory:

1. **start:** `DELETE /things/{id}`, then `PUT /things/{id}` with `registration.ttl = 60`.
   The delete makes the directory treat it as a *new* registration (new `registration.created`), and that is
   how the gateway and app learn that the device restarted and re-bind (needed, for instance, because a
   restarted CoAP server has lost its Observe relationships).
2. **every TTL/3 (20 s):** `PUT` again (heartbeat). A crashed device's TD expires after 60 s.
3. **SIGTERM (systemctl stop):** `DELETE /things/{id}`.

`run_device()` (`devices/wotdev/__init__.py`) ties it together: start runtimes → register → run background
loops → clean shutdown on SIGINT/SIGTERM.

### 4.3 Temperature sensor (`devices/temperature_sensor.py`), MQTT

- **Backends**, tried in order when `DHT_BACKEND=auto`:
  1. **kernel**: Linux IIO driver (`dtoverlay=dht11,gpiopin=4`), reading `/sys/bus/iio/devices/iio:deviceN/in_temp_input`
     (milli-°C) and `in_humidityrelative_input`. The kernel does the µs-precise timing, so it is the most reliable option.
  2. **adafruit**: `adafruit-circuitpython-dht` (user-space bit-banging).
  3. **sim**: a smooth 23 → 31 °C sine wave with a 6-minute period, so the system remains demonstrable
     without hardware. Logged loudly; events carry `"simulated": true`.
- Reads every `SENSOR_INTERVAL_S` (≥ 2 s, the DHT22 limit) in a worker thread. It rejects impossible values
  and > 10 °C single-sample jumps (typical DHT glitches), and keeps the last good value on read errors.
- Each reading updates the retained `temperature`/`humidity` topics and publishes a `measurement` event
  `{temperature, humidity, ts, seq, simulated}`.
- `readproperty` returns the cached value instantly. Benchmarks therefore measure the protocol, not the
  sensor's 2 s conversion time.

### 4.4 Fan relay (`devices/relay_actuator.py`), CoAP ⇄ MQTT

- Drives GPIO 17 with **gpiozero** `OutputDevice` (lgpio backend on Bookworm/Trixie), with polarity from
  `RELAY_ACTIVE_HIGH`. If no GPIO is available (e.g. on a laptop) it uses a mock and says so.
- Affordances: property `on` (read/write), actions `turnOn`/`turnOff`/`toggle`, event `stateChanged`.
  `turnOn`/`turnOff` are idempotent and only emit an event when the state actually changes.
- Fail-safe: the relay is switched off when the service stops.
- Fails loudly: if GPIO cannot be opened the service exits (systemd shows it as failed) instead of silently
  using a mock that would report "off" while the real relay never changes. `RELAY_MOCK=true` allows the mock
  for laptop development.
- `RELAY_DRIVE=open-drain`: ON drives the pin LOW, OFF *releases* it (floating input). This is for 5 V
  active-low boards that a 3.3 V HIGH cannot switch off; once released, the board pulls IN to 5 V itself
  (see docs/WIRING.md). `devices/relay_polarity_test.py` checks the setting on the hardware.
- Protocol = whatever `RELAY_TD` (default `things/fan-relay.td.json`) says.

### 4.5 Smart plug (`devices/smart_plug.py`), HTTP, simulated

A 1.5 kW heater plug: property `on`, property `power` (≈1500 W ± noise when on, ≈0.5 W standby), the same
three actions and a `stateChanged` event over HTTP long-poll. It starts ON. The application switches it OFF
when the room is too hot and back ON when it has cooled below the hysteresis band.

### 4.6 Simulated devices (`devices/sim_devices.py`)

`--count N` devices spread round-robin over HTTP, CoAP and MQTT, each with its own TD (from
`things/templates/sim-device.<proto>.td.json`). Each has a property `value`, a no-op action `ping`, and an
event `tick {value, ts, seq}` every `--tick` seconds, staggered so ticks do not all fire at once.
`--port-offset` allows several simulator processes at once (the scalability test starts one per step).
The gateway proxies them exactly like real devices.

## 5. MQTT broker (Mosquitto)

The stock Debian `mosquitto` service. The installer adds `/etc/mosquitto/conf.d/wot-gateway.conf`
(`listener 1883`, `allow_anonymous true`), so that clients on the isolated lab network can connect.
TD forms point to `mqtt://<pi-ip>:1883/<topic>`.

**Topic layout:**

```
building/room1/temperature-sensor/properties/temperature    retained
building/room1/temperature-sensor/properties/humidity       retained
building/room1/temperature-sensor/events/measurement
building/room1/fan-relay/properties/on                      retained   (MQTT variant)
building/room1/fan-relay/properties/on/set                  write
building/room1/fan-relay/actions/{turnOn,turnOff,toggle}    QoS 1
building/room1/fan-relay/events/stateChanged
sim/<id>/...                                                simulated devices
```

Watch the traffic live with `mosquitto_sub -v -t 'building/#'`.

## 6. Thing Description Directory (`src/directory/`)

A small HTTP server (plain Node `http`, no framework) implementing the core of the **W3C WoT Discovery
"Things API"**:

| Endpoint | |
|---|---|
| `GET /.well-known/wot` | the directory's **own TD** (type `ThingDirectory`), with a `things` property. This is what `WoT.exploreDirectory()` consumes |
| `GET /things` | array of all TDs (`application/ld+json`); optional `?type=saref:Switch` filter |
| `GET /things/{id}` | one TD |
| `PUT /things/{id}` | create (201) / update (204) |
| `POST /things` | anonymous registration → 201 + `Location` |
| `DELETE /things/{id}` | 204 |
| `GET /` | dashboard |

How it works:

- **Validation on write:** every new or changed TD is validated against the **official TD 1.1 JSON Schema**
  (the file shipped with the W3C TD Playground), compiled once with Ajv. Invalid TDs are rejected with
  `400` and an RFC 7807 problem report. Heartbeats re-send an identical TD; those are hash-compared and skip
  validation, which keeps 100 devices cheap.
- **Registration info:** the directory adds `registration.{created, modified, expires, retrieved}` to each TD
  it returns. `created` changes only for a brand-new registration, and consumers use it to detect device
  restarts.
- **TTL expiry:** entries whose `ttl` elapsed without a heartbeat are removed (checked every 5 s).
- **Persistence:** state is saved atomically to `data/directory.json`, so restarting the directory loses
  nothing.

## 7. The gateway (`src/gateway/`)

This is the central piece: a **node-wot servient** with client bindings for **HTTP, CoAP and MQTT** and
server bindings for **HTTP (:8080) and WebSocket (:8081)** (`src/lib/servient.js`).

### 7.1 Discovery loop

Every `GATEWAY_SYNC_INTERVAL_S` (3 s) the gateway calls `GET /things` and keeps the device TDs (ids starting
with `urn:wot:device:` or `urn:wot:sim:`). For each TD it computes a key = hash(TD without registration) +
`registration.created`.

| Situation | Reaction |
|---|---|
| new device | create a proxy (§7.2) |
| key changed (TD edited, e.g. **protocol swap**, or device restarted) | **re-bind** the proxy to the new TD, keeping the proxy itself alive |
| device missing | wait `GATEWAY_GRACE_S` (20 s, which covers restarts), then destroy the proxy and delete its TD |

It also refreshes its own registrations (heartbeat) in the same loop.

### 7.2 A proxy = one ConsumedThing + one ExposedThing

```
            native TD (CoAP)                                     proxy TD (HTTP + WS)
  ┌──────────────────────────────┐                     ┌────────────────────────────────────┐
  │ WoT.consume(nativeTD)        │  readProperty(on) ◀─│ setPropertyReadHandler("on")       │◀─ HTTP GET  /fan-relay/properties/on
  │ = backing ConsumedThing      │  writeProperty   ◀──│ setPropertyWriteHandler("on")      │◀─ HTTP PUT
  │   talks CoAP to the relay    │  invokeAction    ◀──│ setActionHandler("turnOn")         │◀─ HTTP POST /fan-relay/actions/turnOn
  │                              │  subscribeEvent ───▶│ emitEvent("stateChanged", data)    │──▶ HTTP long-poll / WebSocket
  └──────────────────────────────┘                     └────────────────────────────────────┘
```

1. **Proxy TD.** The native TD's properties, actions and events are copied **without their forms**, along with
   `@context`, `@type` and `title`. The id becomes `urn:wot:gateway:<device id>`, and a link with
   `rel: alternate` points back to the native TD. `WoT.produce()` turns this into an ExposedThing. On
   `expose()`, node-wot generates HTTP and WebSocket forms for every affordance
   (`http://<pi>:8080/fan-relay/properties/on`, `ws://<pi>:8081/fan-relay/events/stateChanged`, …).
2. **Handlers** forward each interaction to the backing ConsumedThing, with a timeout
   (`GATEWAY_READ_TIMEOUT_MS`):
   - property reads are **coalesced**: concurrent reads of the same property share one in-flight request
     (required for MQTT, see §13, and it also protects slow devices);
   - writes and actions are forwarded; action output is returned only if the TD declares an `output`.
3. **Events:** the proxy eagerly subscribes to every native event and re-emits it on the ExposedThing.
   node-wot then delivers it to every HTTP long-poll client and WebSocket client. If a native subscription
   fails (e.g. the plug's HTTP server restarted), the proxy re-binds with exponential back-off.
4. **Registration:** the generated proxy TD (`exposed.getThingDescription()`) is `PUT` into the directory,
   which validates it like any other TD.

**Re-bind** = stop the old subscriptions → `WoT.consume(newTD)` → re-subscribe. The ExposedThing, its URLs
and every client connected to it stay untouched. This is why the application in gateway mode does not even
notice a protocol swap.

### 7.3 The gateway is a Thing too

`urn:wot:gateway` exposes:

- `status`: pid, uptime, number of proxies, RSS, heap, sync time;
- `proxies`: for each proxy, its native protocols and counters (reads, writes, actions, events, dropped,
  errors, rebinds).

`wotctl status`, the swap test and the scalability benchmark read these, using WoT themselves.

## 8. The application

### 8.1 `src/app/app.js`: the part that must never change

About 40 lines of logic. It declares **what** it needs and **what** to do (simplified):

```js
requires: {
  sensor: { type: "saref:TemperatureSensor", events: ["measurement"] },
  fan:    { type: "bldg:FanController", properties: ["on"], actions: ["turnOn", "turnOff"] },
  heater: { type: "bldg:SmartPlug",     properties: ["on"], actions: ["turnOn", "turnOff"], optional: true },
},
bind({ sensor, fan, heater }, app) {
  app.subscribe(sensor, "measurement", async (m) => {
    const fanOn = await read(fan, "on"), heaterOn = heater && await read(heater, "on");
    if (m.temperature > threshold)                    want = { fan: true,  heater: false };  // cool
    else if (m.temperature < threshold - hysteresis)  want = { fan: false, heater: true  };  // heat
    else return;                                                                             // hysteresis band
    if (fanOn !== want.fan)               fan.invokeAction(want.fan ? "turnOn" : "turnOff");
    if (heater && heaterOn !== want.heater) heater.invokeAction(want.heater ? "turnOn" : "turnOff");
    notify(...)                                                                               // if anything switched
  });
}
```

It contains no protocol, URL, topic, port or IP address. `sensor`, `fan` and `heater` are node-wot
ConsumedThings.

**Rule (a simple thermostat):** above the threshold the fan goes ON and the heater plug OFF. Below
`threshold − hysteresis` the fan goes OFF and the heater plug ON. Inside the hysteresis band nothing changes,
which prevents the relay from chattering around the threshold. Every switch sends a notification. The rule
reads both devices' real state on every measurement and only switches what differs. So while automatic
control is enabled, a manual change that contradicts the rule (e.g. heater off while it's cold) is undone at
the next measurement; switch automatic control off on the dashboard to control devices by hand.

### 8.2 `src/lib/app-runtime.js`: generic plumbing

- **Discovery:** `WoT.exploreDirectory(".../.well-known/wot")`, the standard Scripting API call, runs every
  5 s.
- **Selection by semantics:** for each role, the first TD whose `@type` matches and that has all required
  affordances. The `mode` setting chooses the pool:
  - `gateway`: the gateway's proxy TDs (everything over HTTP/WS);
  - `direct`: the devices' own TDs (node-wot inside the app speaks MQTT/CoAP/HTTP itself).
- **Re-binding:** when the selected TDs change (key = hash + `registration.created`), when a subscription
  fails, or when no event arrived for 6 sensor intervals, the runtime stops all subscriptions, consumes the
  new TDs and calls `bind()` again. A *generation counter* ignores errors from subscriptions it stopped
  itself; without it, stopping a long-poll would trigger an endless re-bind loop.
- **Serialized handlers:** events are processed one at a time, so a slow actuation cannot overlap the next
  measurement.
- **The application is itself a Thing** (`urn:wot:app:climate-controller`, HTTP :8082):
  - writable `threshold`, `hysteresis`, `enabled`, `mode`;
  - readable `status` (temperature, fan state, what it is bound to and over which protocols, last alert);
  - event `alert`.

  The dashboard, `wotctl threshold`, the swap test and the latency benchmark control the app through this
  WoT interface.
- **Notification:** `notify()` logs the message, emits the `alert` event and, if `NOTIFY_URL` is set, POSTs
  the text there (e.g. to an ntfy server on the lab network).

## 9. Dashboard

`src/directory/public/index.html`, served at `http://<pi>:8090/`. It is plain HTML and JS with no
dependencies, and it is **itself a TD consumer**:

- it reads `/things` and builds one card per gateway proxy, showing native protocol badges;
- it finds each affordance's `readproperty`/`invokeaction` forms in the TD and polls or calls them;
- it opens the **WebSocket** event forms (`ws://…:8081/…/events/…`) to show a live event log;
- it controls the application through its TD (threshold, enabled, mode) and shows which protocol the app
  currently uses to reach the fan. That makes the protocol swap visible on screen.

It supports light and dark mode.

## 10. Evaluation tools

| Tool | What it does | Output |
|---|---|---|
| `src/tools/validate-tds.js` (`wotctl validate [--live] [--jsonld]`) | runs every TD file, and with `--live` every TD in the directory (including the gateway-generated proxy TDs), through `@thing-description-playground/core`, the library behind the W3C TD Playground. Checks: JSON, TD 1.1 schema, full schema/defaults, extra assertions (security, unique names, enum/const, multi-language, …), JSON-LD expansion with `--jsonld` | `results/td-validation.{md,json}` |
| `src/tools/swap-test.js` (`wotctl swap-test`) | hashes every source file (`src/**/*.js`, `devices/**/*.py`; 19 at present); for relay protocol CoAP → MQTT → CoAP it replaces only `things/fan-relay.td.json`, restarts the relay, waits for the gateway to re-bind, then for **both** app modes writes a threshold below/above the current temperature and checks the physical relay follows. Re-hashes and counts changed lines (LCS diff) | `results/swap-test-*.{md,json}` |
| `src/bench/latency.js` (`wotctl bench-latency`) | starts 3 simulated devices (HTTP, CoAP, MQTT) and, with `--real`, includes the physical ones. For each device and interaction it runs warm-up, then N samples **interleaved** direct/gateway (alternating order cancels drift), using the **same node-wot client** for both paths. Events: subscribes direct, gateway long-poll and gateway WebSocket simultaneously and computes `receive time − device ts` (same clock, same Pi). Also delivery ratio. Pauses the app during the run | `results/latency-*.{csv,json,md}` |
| `bench/scalability.py` (`wotctl bench-scale`) | grows the simulated fleet 0 → 10 → 25 → 50 → 75 → 100. Per step: proxy-creation time; then 30 s of 1 Hz sampling of the gateway process (psutil CPU %, RSS), JS heap from the gateway Thing, system CPU and memory, while reading every device's `value` through the gateway every 5 s (read latency under load) and counting forwarded events/s | `results/scalability-*.{csv,md}` |
| `bench/plot.py` (`wotctl plots`) | figures + one combined `results/REPORT.md` | `results/plots/*.png` |

## 11. Configuration, installer, services

- **`config/wot.env`**: the single source of configuration, read by the Node services (`src/lib/config.js`)
  and the Python devices (`devices/wotdev/config.py`). Environment variables override it. `WOT_HOST=auto`
  resolves to the Pi's current IPv4 (`hostname -I`) at start-up, so TDs always carry the right address.
  The file is deliberately *not* used as a systemd `EnvironmentFile`: systemd does not strip inline
  `# comments`.
- **`install.sh`**: apt packages, Mosquitto config, Node ≥ 18 (NodeSource fallback), Python venv
  (`--system-site-packages` so the Pi's gpiozero/lgpio are visible), `npm ci`, DHT overlay, `gpio` group,
  systemd units. Idempotent; normalises Windows line endings.
- **systemd:** six `wot-*.service` units (`Restart=always`, run as your user, `SupplementaryGroups=gpio`),
  grouped by `wot.target`, which is enabled at boot.
- **`wotctl`:** a thin wrapper around systemctl/journalctl plus convenience calls to the app and gateway
  Things and the evaluation tools.

## 12. End-to-end walkthroughs

### A. "Too hot" (gateway mode, relay on CoAP)

1. `temperature_sensor.py` reads 29.1 °C from the kernel driver and publishes `measurement` on
   `building/room1/temperature-sensor/events/measurement` (MQTT).
2. The gateway's ConsumedThing for the sensor (subscribed over MQTT) receives it, and the proxy calls
   `emitEvent("measurement", …)`.
3. node-wot answers the application's pending HTTP **long-poll** on
   `http://<pi>:8080/temperature-sensor/events/measurement`.
4. The application's handler runs `fan.readProperty("on")`: HTTP GET to the gateway → proxy read handler →
   **CoAP GET** `coap://<pi>:5683/fan/properties/on` → `false`.
5. 29.1 > 28 → `fan.invokeAction("turnOn")`: HTTP POST to the gateway → **CoAP POST** `/fan/actions/turnOn` →
   `relay_actuator.py` sets GPIO 17 → **the fan spins**. The relay emits `stateChanged` (CoAP Observe → gateway → WS → dashboard).
6. `heater.readProperty("on")` / `invokeAction("turnOff")`: HTTP → gateway → **HTTP** to the plug.
7. `notify()` → log + `alert` event + optional webhook.

### B. Protocol swap

1. `./wotctl swap mqtt` copies `things/templates/fan-relay.mqtt.td.json` over `things/fan-relay.td.json` and
   restarts `wot-relay`.
2. The relay process unregisters (SIGTERM), starts, reads its TD, finds `mqtt://` forms, so it subscribes
   to the action/write topics and publishes the retained `on` value. It registers the new TD (new `created`).
3. Within ≤ 3 s the gateway notices the key change and logs `rebind … (protocol coap -> mqtt)`. The proxy
   now forwards over MQTT. Its HTTP/WS interface is unchanged.
4. Application in gateway mode: nothing to do. In direct mode its runtime sees the changed device TD,
   re-consumes it, and node-wot in the app now publishes MQTT messages instead of sending CoAP requests.
   **`app.js` is byte-for-byte identical** (the swap test proves it with SHA-256).

### C. Device crash

The relay process dies, systemd restarts it within 3 s, and it re-registers with a new `created`. The gateway
re-binds (re-establishing the CoAP Observe), and the proxy never went away. If the device stays dead, its TD
expires after 60 s and the gateway removes the proxy 20 s later.

## 13. node-wot 0.9.2 issues found and how they are handled

Building the gateway surfaced several behaviours of node-wot 0.9.2 that matter for anyone reproducing this.
They are worth a paragraph in the report.

| # | Behaviour | Effect | Handling |
|---|---|---|---|
| 1 | MQTT `readproperty` is implemented as "subscribe, wait for the (retained) message, unsubscribe", and the message pool silently **ignores a second subscriber on the same topic** | two concurrent reads of an MQTT property: the second never resolves; a property without a retained value never resolves | devices publish property values **retained**; write topics are separate (`…/set`); the gateway **coalesces concurrent reads** and applies timeouts |
| 2 | The HTTP client's long-poll handshake is a `HEAD` request, but `htv:methodName` in the form overrides it | a long-poll event form with `htv:methodName: GET` makes the handshake block → "network timeout" | long-poll event forms carry no `htv:methodName` (`GET` is the default) |
| 3 | `ProtocolListenerRegistry.notify` creates **one content stream per form** and hands it to every listener on that form | two subscribers on the same form (e.g. app + dashboard long-polling one event) race; one gets an **empty body** | `src/lib/servient.js` patches `notify` to give each listener its own content |
| 4 | The WebSocket server registers its listener **once per form** of the event | every WS client receives each event N times (N = number of forms) | `dedupeSubscriptions()` registers each listener once, on its own `ws://` form |
| 5 | The HTTP long-poll subscription does not retry after an error, and stopping it reports an "aborted" error | consumers must re-subscribe themselves; naive re-subscribe-on-error loops forever | gateway and app re-bind on error, guarded by a generation counter |
| 6 | The WebSocket **client** binding is not implemented (server only) | node-wot clients cannot use the gateway's ws:// forms | benchmarks use node-wot over HTTP plus a raw `ws` client for the WebSocket path; the dashboard uses the browser WebSocket API |
| 7 | HTTP servers generate forms for every network interface and for CBOR as well as JSON | large TDs, more forms | `Helpers.setStaticAddress(WOT_HOST)`, JSON only |
