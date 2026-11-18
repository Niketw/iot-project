# Deliverables and evaluation metrics

This maps every deliverable (§6) and evaluation metric (§7) of the proposal *"A Protocol-Independent
Smart-Building Gateway Using W3C Web of Things"* to what exists in this repository, how to produce it on
the Pi, and where the result ends up.

**Research question:** *Can a Raspberry Pi gateway that exposes mixed-protocol devices through WoT Thing
Descriptions let one application control all of them without change, and what latency and resource
overhead does this layer add compared with direct protocol access?*

One command produces every measurable result:

```bash
./wotctl evaluate        # ≈ 15 min → results/REPORT.md + results/plots/*.png
```

---

## Part 1: Deliverables

| # | Deliverable (proposal §6) | Status | Where / how |
|---|---|---|---|
| D1 | **Raspberry Pi WoT gateway with three mixed-protocol devices** | ✅ implemented | `src/gateway/gateway.js` (node-wot, HTTP + WebSocket), devices in `devices/`: DHT22 over **MQTT**, relay/fan over **CoAP**, simulated smart plug over **HTTP**. Thing Directory: `src/directory/server.js`. Install: `bash install.sh` |
| D2 | **Validated Thing Descriptions released as templates** | ✅ implemented | `things/templates/` (7 templates: sensor-MQTT, relay-CoAP, relay-MQTT, plug-HTTP, sim-device ×3). Validate: `./wotctl validate --live` → `results/td-validation.md` |
| D3 | **Protocol-independent application with a recorded protocol-swap test** | ✅ implemented | `src/app/app.js`; automated test `./wotctl swap-test` → `results/swap-test-latest.md`; manual/video version: `./wotctl swap mqtt` (README "Demo script") |
| D4 | **Overhead and scalability measurements** | ✅ tooling complete, run on the Pi | `./wotctl bench-latency`, `./wotctl bench-scale`, `./wotctl plots` → `results/latency-latest.md`, `results/scalability-latest.md`, `results/plots/` |
| D5 | **Report or 4-page workshop paper + 2-minute demo video** | 📝 draft written | **`WoT_Smart_Building_Gateway_Paper.docx`** (project root): full paper + video shot list (Appendix A). Swap in the Pi numbers from `results/REPORT.md` (yellow-highlighted placeholders mark what to update) |

### D1: Gateway with three mixed-protocol devices

What to show: `./wotctl status` (three proxies with `native=mqtt / coap / http`) and the dashboard
`http://<pi>:8090/`. Requirements met:

- three devices, three native protocols, on one Pi (allowed by the proposal: "on the Pi (or a second Pi / ESP32 if available)");
- node-wot reads each device through its native binding and **re-exposes all of them through one HTTP and
  one WebSocket interface** (`:8080`, `:8081`);
- devices register in a **Thing Directory** (WoT Discovery API) and the gateway discovers them there;
- scalability test with **10–100 simulated devices** (D4).

### D2: Validated Thing Descriptions as templates

| Template | Thing | Protocol |
|---|---|---|
| `temperature-sensor.mqtt.td.json` | DHT22 temperature/humidity sensor | MQTT (retained properties, event topic) |
| `fan-relay.coap.td.json` | relay / fan | CoAP (GET/PUT/POST, Observe) |
| `fan-relay.mqtt.td.json` | relay / fan, same affordances | MQTT (QoS 1 actions, `/set` write topic) |
| `smart-plug.http.td.json` | smart plug | HTTP (REST, long-poll events) |
| `sim-device.{http,coap,mqtt}.td.json` | generic simulated device | each protocol |

Placeholders (`{{WOT_HOST}}`, ports, `{{SIM_ID}}`) make them reusable on any network. Semantic `@type`s use
SAREF. Validation uses the W3C TD Playground's own library (offline-capable), see metric M4.

### D3: Protocol-independent application and protocol-swap test

`src/app/app.js` uses only TD vocabulary (`@type`, `measurement`, `on`, `turnOn`, `turnOff`). Rule: above the threshold fan ON + heater plug OFF; below threshold − hysteresis fan OFF + heater plug ON. The swap test:

1. hashes all application, gateway and device source files (19 files);
2. for relay protocol **CoAP → MQTT → CoAP**, replaces **only** `things/fan-relay.td.json` and restarts the relay;
3. for **both** application modes (through the gateway, and direct with node-wot speaking the native protocol
   itself), drives the app via its own WoT interface (threshold below/above the current temperature) and
   checks that the relay follows;
4. re-hashes and counts changed lines → metric M3.

**For the video:** follow the "Demo script" in the README. `./wotctl status` and the dashboard show the
relay's native protocol and the protocol the application uses to reach it, so the swap is visible on screen.

### D4: Overhead and scalability measurements

See metrics M1 and M2. Raw data (CSV/JSON) and figures are generated automatically.

### D5: Report / paper and video

**Suggested 4-page workshop paper outline** (all numbers and figures come from `results/REPORT.md`):

1. *Introduction* — protocol fragmentation in buildings; WoT TD as a uniform description; research question.
2. *Background* — W3C WoT TD 1.1 / Architecture 1.1, Scripting API, protocol bindings, WoT Discovery; node-wot.
3. *System design* — architecture figure (docs/COMPONENTS.md §1); TD-driven devices; gateway proxy pattern
   (ConsumedThing → ExposedThing, re-binding); Thing Directory; application selection by `@type`.
4. *Evaluation*
   - Interoperability: swap-test table (M3) + TD validation (M4).
   - Latency overhead: `latency_p50_p95.png`, `added_latency.png`, table of added p50/p95 per interaction × protocol (M1).
   - Scalability: `scalability_cpu.png`, `scalability_ram.png`, `scalability_latency.png` (M2).
5. *Discussion* — where the overhead comes from (an extra HTTP hop + JSON (de)serialisation + node-wot
   validation); MQTT read semantics (retained message, subscribe/unsubscribe per read); event delivery via
   long-poll vs WebSocket; the node-wot 0.9.2 issues found (docs/COMPONENTS.md §13); limitations (single Pi,
   no security, simulated plug).
6. *Conclusion*.

**2-minute video plan:** 0:00 setup and dashboard → 0:20 heat the sensor, fan on and heater off → 0:50
`./wotctl swap mqtt`, status shows MQTT → 1:10 heat again, same behaviour, `sha256sum src/app/app.js` unchanged →
1:35 switch the app to direct mode → 1:50 plots of latency and scalability.

### Mapping to the one-week plan (proposal §5)

| Plan item | Output in this repo |
|---|---|
| install node-wot on the Pi | `install.sh` |
| build MQTT, CoAP, HTTP devices | `devices/temperature_sensor.py`, `relay_actuator.py`, `smart_plug.py`, runtime in `devices/wotdev/` |
| write + validate TDs, set up Thing Directory | `things/`, `src/tools/validate-tds.js`, `src/directory/server.js` |
| gateway + temperature-to-fan application | `src/gateway/gateway.js`, `src/app/app.js` |
| protocol-swap test, direct vs gateway latency | `src/tools/swap-test.js`, `src/bench/latency.js` |
| scalability test 10–100 devices | `devices/sim_devices.py`, `bench/scalability.py` |
| report, clean code, demo | `bench/plot.py` → `results/REPORT.md`, README demo script |

---

## Part 2: Evaluation metrics

### M1: Added latency (median and 95th percentile, ms) per interaction type vs direct access

| | |
|---|---|
| **Definition** | added = latency(through gateway) − latency(direct), reported at p50 and p95, for each interaction type × native protocol |
| **Interactions** | `readProperty`, `invokeAction`, event delivery |
| **Direct path** | node-wot `WoT.consume(device TD)`: MQTT, CoAP or HTTP straight to the device |
| **Gateway path** | node-wot `WoT.consume(proxy TD)`: HTTP to the gateway, then native protocol to the device. Events additionally over the gateway's **WebSocket** (raw `ws` client, since node-wot has no WS client) |
| **Fairness** | same client library on both paths; warm-up discarded; direct/gateway samples **interleaved** with alternating order; benchmark client, gateway and devices on the same Pi (no network jitter, one clock for event timestamps); the climate app is paused during the run |
| **Targets** | 3 simulated devices (one per protocol, identical behaviour) give a clean protocol comparison; the real DHT22/relay/plug (`--real`) give realistic numbers. Relay action = idempotent `turnOn`, so the relay does not chatter |
| **Event latency** | device timestamp `ts` (inside every event) → time the client receives it. Also reports **delivery ratio** (long-poll can miss events between polls) |
| **Command** | `./wotctl bench-latency [--samples 200] [--event-seconds 60] [--tick 0.5]` |
| **Output** | `results/latency-latest.md` (table), `latency-*.csv` (every sample), `plots/latency_p50_p95.png`, `plots/added_latency.png` |
| **Notes for interpretation** | MQTT `invokeAction` completes at the broker's PUBACK (QoS 1), not when the device acts. MQTT `readProperty` = subscribe + retained message + unsubscribe |

### M2: Gateway CPU and RAM vs number of devices

| | |
|---|---|
| **Definition** | gateway **process** CPU (% of one core; mean and p95 over 30 s at 1 Hz) and RSS memory (mean, max) plus JS heap, as the number of proxied devices grows |
| **Steps** | 0, 10, 25, 50, 75, 100 simulated devices (round-robin HTTP/CoAP/MQTT) **plus** the 3 real devices |
| **Load per device** | one `tick` event every 5 s (forwarded by the gateway) + one `readProperty` through the gateway every 5 s |
| **Also recorded** | proxy creation time per step, read latency p50/p95 under load, read errors, forwarded events/s, system CPU, simulator CPU (the simulators run on the same Pi and are reported separately) |
| **Command** | `./wotctl bench-scale [--steps 0,10,25,50,75,100] [--duration 30] [--tick 5] [--load-period 5]` |
| **Output** | `results/scalability-latest.md`, `scalability-*.csv`, `plots/scalability_cpu.png`, `plots/scalability_ram.png`, `plots/scalability_latency.png` |

### M3: Lines of application code changed when a device changes protocol (target: 0)

| | |
|---|---|
| **Definition** | number of added + removed lines (LCS diff) over **all** application, gateway and device source files (`src/**/*.js`, `devices/**/*.py`, 19 files) between before and after moving the relay CoAP → MQTT → CoAP |
| **Pass criterion** | 0 lines changed **and** the application still switches the fan correctly in every phase, in both gateway and direct mode (6 checks) |
| **Also reported** | which non-code file changed (`things/fan-relay.td.json` only), how many TD lines differ between the CoAP and MQTT variants, time-to-actuate per phase, SHA-256 of `src/app/app.js` |
| **Command** | `./wotctl swap-test` |
| **Output** | `results/swap-test-latest.md` and `.json` |

### M4: All Thing Descriptions pass validation

| | |
|---|---|
| **Validator** | `@thing-description-playground/core` 1.4.0, the validation library of the W3C TD Playground (playground.thingweb.io), run locally |
| **Checks** | JSON syntax · TD 1.1 JSON Schema · full schema with defaults · playground assertions (security definitions, unique affordance names, enum+const, object/array items, multi-language, links, URI variables, …) · JSON-LD expansion (`--jsonld`, needs Internet for the `@context`) |
| **Scope** | all files in `things/` and `things/templates/`; with `--live` also every TD registered at run time, **including the TDs generated by the gateway and the application**; the directory itself also rejects schema-invalid TDs at registration |
| **Pass criterion** | every TD: JSON, schema and assertion checks pass (a "warn" in the defaults column only means a default such as `readOnly: false` is implicit, which the spec allows) |
| **Command** | `./wotctl validate --live` (add `--jsonld` when the Pi is online) |
| **Output** | `results/td-validation.md` and `.json` |

---

## Reference results from the development run (not the Pi)

The full system was run end to end on the development laptop (Windows 11, 32-core x86, Node 22, Python 3.11,
an aedes MQTT broker standing in for Mosquitto, simulated sensor, mock relay) to verify every tool. **Use
these only as a sanity check.** The Pi 4 numbers you measure will be higher (slower CPU), and those are
the ones for the report.

| Metric | Development-run result |
|---|---|
| M3 swap test | **6/6 PASS**, **0 lines of code changed** in 19 files (re-run after the heater-rule change); only `things/fan-relay.td.json` changed (19 TD lines differ CoAP vs MQTT); gateway re-bound to the new protocol ≈ 2.4 s after the relay re-registered |
| M4 validation | **19/19 TDs pass** (10 files + 9 live TDs incl. gateway proxies, directory and app); JSON-LD check also passes (10/10) when online |
| M1 added latency (p50) | read +1.3–1.8 ms, action +1.1–1.5 ms, event +1.2–2.0 ms (long-poll); WebSocket events +0.2–0.9 ms over direct; direct paths 0.3–1.7 ms |
| M1 event delivery | 97.5–100 % on all paths |
| M2 scalability | 0 → 100 sim devices: gateway CPU mean 0.3 % → 13.7 % of one core, RSS 88 → 106 MB, read p50 2.8–3.9 ms, 0 read errors, 20 events/s forwarded |
