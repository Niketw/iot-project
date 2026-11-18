# Work split: 7 people, equal shares

The project is divided into seven roles of **equal workload: 27.5 hours of individual work each, plus 3 hours
of shared team work, so 30.5 hours per person.** Each role owns a part of the code, a part of the documentation,
a section of the paper, and one evaluation or demo task. Everyone's code is about the same size, and roles with
less code carry more documentation, hardware or experiment work to balance it out.

Replace "Member 1 … Member 7" with names.

## Summary

| # | Role | Code owned (non-blank lines) | Other work | Individual hours |
|---|---|---|---|---|
| 1 | Hardware & physical devices | 442 | wiring and hardware bring-up, wiring guide, video filming | 27.5 |
| 2 | Device protocol runtime | 564 | protocol checks, device docs, abstract | 27.5 |
| 3 | Thing Descriptions & directory | 351 + 10 TD files | TD validation (M4), intro, background, discussion | 27.5 |
| 4 | WoT gateway | 568 | node-wot workarounds, gateway docs, stability test | 27.5 |
| 5 | Application, dashboard & figures | 571 | app docs, video editing | 27.5 |
| 6 | Interoperability & latency evaluation | 493 | Pi experiments (M1, M3), evaluation write-up, final paper assembly | 27.5 |
| 7 | Scalability, deployment & tooling | 543 | fresh-Pi install test, scalability run (M2), README | 27.5 |

**How the hours were estimated** (the same rule for everyone, so the split can be checked):

| Work type | Rate used |
|---|---|
| Code (write + test + debug) | 25 non-blank lines per hour, rounded to the nearest half hour |
| Thing Description JSON (repetitive, templated) | about 190 lines per hour |
| Documentation | about 60 lines per hour |
| Paper section | 1–4 hours depending on length |
| Hardware, experiments, video | estimated per task (listed in each section) |

## Shared work (3 hours each, everyone)

| Task | Hours |
|---|---|
| **Integration session:** everyone brings their part up together on the Pi and fixes interface problems | 1.5 |
| **Peer review:** review one other member's code and docs (rotation: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 1) | 1 |
| **Demo rehearsal:** walk through the 2-minute video script once as a team | 0.5 |

---

## Member 1: Hardware & physical devices

**What this part is:** everything that touches the physical world. The DHT22 sensor and the relay that switches
the fan, plus the Python programs that read the sensor and drive the relay. Also the simulated smart plug and
the simulated device fleet, which stand in for hardware we don't have.

**Owns**

| File | Lines |
|---|---|
| `devices/temperature_sensor.py` (DHT22: kernel driver → library → simulation fallback) | 131 |
| `devices/relay_actuator.py` (GPIO relay, polarity, open-drain mode, fail-loud) | 118 |
| `devices/relay_polarity_test.py` (hardware check for the relay wiring) | 85 |
| `devices/smart_plug.py` (simulated HTTP heater plug) | 49 |
| `devices/sim_devices.py` (N simulated devices for the benchmarks) | 59 |
| **Total** | **442** |

**What they do**
- Wire the DHT22 and the relay and fan to the Pi, and confirm the kernel driver reads the sensor
  (`sensor backend: dht22-kernel-iio` in `./wotctl status`).
- Solve the relay level problem (a 3.3 V GPIO driving a 5 V relay board) and choose and document the fix:
  transistor or open-drain mode.
- Make the sensor robust against DHT22 read errors and glitches.
- Maintain `docs/WIRING.md`, the wiring guide everyone follows.
- Write the hardware and testbed details in the paper (§5 "Testbed": Pi model, OS, sensor, relay), and film
  the hardware shots for the demo video.

**Hours**

| Task | Hours |
|---|---|
| Code (442 lines) | 17.5 |
| Wiring, hardware bring-up and relay debugging | 6 |
| `docs/WIRING.md` | 2 |
| Paper: testbed paragraph | 1 |
| Video: hardware filming | 1 |
| **Total** | **27.5** |

**Works with:** Member 2 (the devices are built on their runtime), Member 5 (the video).

---

## Member 2: Device protocol runtime

**What this part is:** the small library that makes devices protocol-independent. A device only says what it
does (read temperature, turn on), and the runtime reads the device's Thing Description and serves those
functions over HTTP, CoAP or MQTT, whichever the description says. This is why changing the relay's protocol
needs no code change.

**Owns**

| File | Lines |
|---|---|
| `devices/wotdev/runtime.py` (HTTP, CoAP and MQTT bindings driven by the TD forms) | 368 |
| `devices/wotdev/config.py` (shared config loader, TD template filling) | 79 |
| `devices/wotdev/directory.py` (registration with the Thing Directory: TTL, heartbeat) | 77 |
| `devices/wotdev/__init__.py` (device start-up and clean shutdown) | 40 |
| **Total** | **564** |

**What they do**
- Implement and maintain the mapping from each TD operation to each protocol: HTTP GET/PUT/POST and
  long-poll, CoAP GET/PUT/POST and Observe, MQTT retained topics, subscriptions and QoS.
- Handle reconnection (MQTT broker restarts) and the registration lifecycle (register, heartbeat every TTL/3,
  delete on shutdown).
- Check each protocol from outside with plain tools (`mosquitto_sub`, a CoAP client, `curl`) to prove the
  devices speak real MQTT, CoAP and HTTP.
- Write the device section of `docs/COMPONENTS.md` (§4) and paper §3.3 "TD-driven devices", and draft the
  paper's abstract.

**Hours**

| Task | Hours |
|---|---|
| Code (564 lines) | 22.5 |
| Protocol checks with external tools | 2 |
| `docs/COMPONENTS.md` §4 | 1.5 |
| Paper §3.3 | 1 |
| Paper abstract | 0.5 |
| **Total** | **27.5** |

**Works with:** Member 1 (uses this runtime), Member 3 (the TD format it reads).

---

## Member 3: Thing Descriptions & Thing Directory

**What this part is:** the "contracts" of the system. The ten Thing Descriptions describe every device in
the W3C standard format, and the Thing Directory is the server where all of them are registered and found.
Also responsible for proving every TD is valid, which is evaluation metric M4.

**Owns**

| File | Lines |
|---|---|
| `src/directory/server.js` (WoT Discovery API: register, find, delete, TTL expiry, validation) | 258 |
| `src/tools/validate-tds.js` (W3C TD Playground validation, metric M4) | 93 |
| **Code total** | **351** |
| `things/*.td.json` and `things/templates/*.td.json` (10 TDs: sensor, relay CoAP and MQTT, plug, sim devices) | 938 JSON lines |

**What they do**
- Write and maintain all Thing Descriptions. In particular, keep the CoAP and MQTT relay TDs identical
  except for their forms, which is what makes the protocol swap work.
- Run the directory and make sure it rejects invalid TDs.
- Run `./wotctl validate --live` on the Pi (and `--jsonld` when online) and report M4.
- Write `docs/COMPONENTS.md` §3 and §6, and the paper's §1 Introduction, §2 Background, references, and §6
  Discussion. Also paper §3.2 and §3.4 with Table 1.

**Hours**

| Task | Hours |
|---|---|
| Code (351 lines) | 14 |
| Thing Descriptions (938 lines, templated) | 5 |
| `docs/COMPONENTS.md` §3, §6 | 2 |
| Paper §1, §2, references (plus §3.2, §3.4, Table 1) | 4 |
| Paper §6 Discussion | 1.5 |
| M4 validation run on the Pi | 1 |
| **Total** | **27.5** |

**Works with:** Member 2 (devices register TDs), Member 4 (the gateway reads them), Member 6 (M4 sits next to
M3 in the results).

---

## Member 4: WoT gateway

**What this part is:** the core of the project. The gateway, built on Eclipse node-wot, discovers every
device in the directory and talks to it in its own protocol. It then re-offers every device through one
uniform HTTP and WebSocket interface, and it keeps working when a device restarts or changes protocol.

**Owns**

| File | Lines |
|---|---|
| `src/gateway/gateway.js` (discovery loop, proxy Things, re-binding, read coalescing) | 329 |
| `src/lib/servient.js` (node-wot set-up and the three node-wot 0.9.2 workarounds) | 112 |
| `src/lib/config.js` (shared config for all Node services) | 76 |
| `src/lib/directory-client.js` (directory API client) | 51 |
| **Total** | **568** |

**What they do**
- Maintain the proxy mechanism: one ConsumedThing (native protocol) plus one ExposedThing (HTTP/WS) per device.
- Maintain re-binding on TD change or device restart, which is what makes the protocol swap invisible to the app.
- Own the node-wot problems found during the build (MQTT reads, shared event streams, duplicate WebSocket
  events, long-poll retries) and their workarounds.
- Run a stability test: leave the gateway running for a few hours with devices restarting and check nothing
  leaks or hangs.
- Write `docs/COMPONENTS.md` §7 and §13, and paper §3.5 with Table 2 (node-wot issues).

**Hours**

| Task | Hours |
|---|---|
| Code (568 lines) | 22.5 |
| `docs/COMPONENTS.md` §7, §13 | 2.5 |
| Paper §3.5 and Table 2 | 1.5 |
| Gateway stability test | 1 |
| **Total** | **27.5** |

**Works with:** Member 3 (directory), Member 5 (the app uses the gateway), Members 6 and 7 (the benchmarks
measure the gateway).

---

## Member 5: Application, dashboard & figures

**What this part is:** what the user sees. The climate-control application is the thermostat rule: fan on
and heater off when hot, the reverse when cool, written only against Thing Descriptions. The web dashboard
shows and controls everything. The plotting script turns benchmark results into the paper's figures.

**Owns**

| File | Lines |
|---|---|
| `src/app/app.js` (the thermostat rule, the file that must never change in the swap test) | 55 |
| `src/lib/app-runtime.js` (discovery by `@type`, gateway/direct modes, re-binding, the app as a Thing) | 177 |
| `src/directory/public/index.html` (dashboard) | 200 |
| `bench/plot.py` (figures and `results/REPORT.md`) | 139 |
| **Total** | **571** |

**What they do**
- Maintain the rule (thresholds, hysteresis, heater control) and the app's settings over WoT (threshold,
  enabled, mode).
- Keep the dashboard plain, working and readable in light and dark mode.
- Produce the paper's figures from the Pi results.
- Write `docs/COMPONENTS.md` §8 and §9, and paper §3.6.
- Edit the 2-minute demo video (Appendix A of the paper has the shot list) from the team's recordings.

**Hours**

| Task | Hours |
|---|---|
| Code (571 lines) | 23 |
| `docs/COMPONENTS.md` §8, §9 | 1.5 |
| Paper §3.6 | 1 |
| Video editing | 2 |
| **Total** | **27.5** |

**Works with:** Member 4 (the gateway), Member 1 (video footage), Members 6 and 7 (results for the figures).

---

## Member 6: Interoperability & latency evaluation

**What this part is:** proving the research question. The protocol-swap test shows the app keeps working with
**zero lines of code changed** when the relay moves from CoAP to MQTT (metric M3). The latency benchmark
measures how much delay the gateway adds compared with talking to devices directly (metric M1).

**Owns**

| File | Lines |
|---|---|
| `src/tools/swap-test.js` (protocol swap CoAP → MQTT → CoAP, lines-of-code check, M3) | 219 |
| `src/bench/latency.js` (direct vs gateway: read, action, event; p50/p95; M1) | 274 |
| **Total** | **493** |

**What they do**
- Run `./wotctl swap-test` and `./wotctl bench-latency` on the Pi, check the results make sense, and re-run if
  something interfered.
- Interpret the numbers: where the overhead comes from, and why MQTT actions look fast.
- Keep the M1 and M3 parts of `docs/DELIVERABLES_AND_METRICS.md` accurate.
- Write paper §5.1 and §5.2 with Tables 3 and 4, and the Conclusion. Assemble the final paper: collect
  everyone's sections, replace the yellow placeholders with Pi numbers, and check consistency.

**Hours**

| Task | Hours |
|---|---|
| Code (493 lines) | 19.5 |
| Pi experiment runs and analysis (swap test, latency) | 3 |
| Paper §5.1, §5.2, Tables 3–4 | 3 |
| `docs/DELIVERABLES_AND_METRICS.md` M1/M3 | 1 |
| Conclusion and final paper assembly | 1 |
| **Total** | **27.5** |

**Works with:** Member 4 (what is measured), Member 5 (figures), everyone (paper assembly).

---

## Member 7: Scalability, deployment & tooling

**What this part is:** making the project run on a fresh Pi with one command, and the control tool everyone
uses. Also the scalability experiment: how much CPU and memory the gateway needs as devices grow from 10 to
100 (metric M2).

**Owns**

| File | Lines |
|---|---|
| `bench/scalability.py` (CPU/RAM/latency vs 0–100 devices, M2) | 217 |
| `install.sh` (one-shot installer: packages, Mosquitto, Node, Python, services) | 188 |
| `wotctl` (control script: status, logs, swap, evaluate, …) | 138 |
| **Total** | **543** |

**What they do**
- Keep the installer working: test it on a **freshly flashed** SD card, from Raspberry Pi Imager to running
  dashboard, and fix anything that breaks.
- Maintain `wotctl` and the systemd services.
- Run `./wotctl bench-scale` on the Pi and report M2. Watch the Pi's memory, since it only has 2 GB.
- Maintain `README.md` (installation and how to run).
- Write paper §5.3 with Table 5 and Figure 3.

**Hours**

| Task | Hours |
|---|---|
| Code (543 lines) | 21.5 |
| Fresh-Pi install test and fixes | 2 |
| `README.md` | 1.5 |
| Paper §5.3, Table 5, Figure 3 | 1.5 |
| Scalability run on the Pi | 1 |
| **Total** | **27.5** |

**Works with:** everyone (all parts are installed and started by `install.sh` and `wotctl`), Member 5 (figures).

---

## Order of work

| Phase | Who | Depends on |
|---|---|---|
| 1. Hardware wired, Pi installed | Members 1 and 7 | nothing |
| 2. TDs, directory, device runtime | Members 2 and 3 | phase 1 for real hardware; can start in simulation |
| 3. Gateway, application, dashboard | Members 4 and 5 | phase 2 |
| 4. Integration session (everyone) | all | phase 3 |
| 5. Experiments: M1, M2, M3, M4 | Members 3, 6 and 7 | phase 4 |
| 6. Figures, paper, video | Members 5 and 6 lead, everyone writes their section | phase 5 |

Everything can be developed on a laptop first (simulated sensor, `RELAY_MOCK=true`), so phases 2 and 3 don't
have to wait for the hardware.
