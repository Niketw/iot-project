# WoT Smart-Building Gateway

A Raspberry Pi gateway that exposes mixed-protocol devices (**MQTT**, **CoAP**, **HTTP**) through
**W3C Web of Things Thing Descriptions**, so that one application controls all of them without
knowing their protocols — and keeps working, unchanged, when a device switches protocol.

Built with Eclipse Thingweb **node-wot 0.9.2**, Mosquitto, aiocoap and aiohttp.

| Document | What's in it |
|---|---|
| **README.md** (this file) | hardware, installation, running on the Pi, demo |
| [docs/COMPONENTS.md](docs/COMPONENTS.md) | how every component works (architecture, data flows, design decisions) |
| [docs/DELIVERABLES_AND_METRICS.md](docs/DELIVERABLES_AND_METRICS.md) | the proposal's deliverables & evaluation metrics, how each is produced and measured |
| [docs/WIRING.md](docs/WIRING.md) | detailed wiring for the DHT22, relay/fan and LED |

```
                ┌──────────────────────── Raspberry Pi 4 ─────────────────────────┐
  DHT22 ──GPIO4─┤ temperature_sensor.py ──MQTT──┐                                 │
                │                               ├─ Mosquitto :1883                │
  Relay ─GPIO17─┤ relay_actuator.py ──CoAP:5683─┤  (or MQTT after the swap)       │
   + fan        │ smart_plug.py ─────HTTP:8091──┤                                 │
                │                               ▼                                 │
                │        node-wot GATEWAY  ── HTTP :8080 / WebSocket :8081 ──┐    │
                │              ▲  registers proxy TDs                        │    │
                │   Thing Directory :8090  (+ dashboard)                     │    │
                │              ▲  discovers TDs                              ▼    │
                │        Climate-controller APP (written only against TDs) :8082  │
                └──────────────────────────────────────────────────────────────────┘
```

---

## 1. What you need

| Item | Notes |
|---|---|
| Raspberry Pi 4 (any RAM), PSU, 32 GB microSD | **Raspberry Pi OS Bookworm or Trixie** (Lite or Desktop, 32/64-bit) |
| DHT22 sensor | module with 3 pins, or bare sensor + 10 kΩ pull-up |
| Relay module **or** LED + 330 Ω resistor | + small 5 V DC fan if you use the relay |
| Jumper wires | |

No second Pi or ESP32 is needed — everything runs on one Pi. The HTTP smart plug is simulated in software.

## 2. Wiring (summary — full version with diagrams in [docs/WIRING.md](docs/WIRING.md))

| From | Pi physical pin | BCM |
|---|---|---|
| DHT22 **VCC** (+) | pin 1 (3.3 V) | |
| DHT22 **DATA** (out) | pin 7 | **GPIO 4** |
| DHT22 **GND** (−) | pin 9 (GND) | |
| Relay **VCC** | pin 2 (5 V) — the relay coil needs 5 V | |
| Relay **GND** | pin 6 (GND) | |
| Relay **IN** | via an NPN transistor from pin 11, see note below | **GPIO 17** |
| Fan **red** ← Relay **NO**, Relay **COM** ← | pin 4 (5 V) | |
| Fan **black** | pin 14 (GND) | |

*Why a transistor:* most 5 V relay boards switch off only when IN reaches 5 V, but the Pi's signal tops
out at 3.3 V, so wired straight to the Pi the relay never turns off. Powering the board from 3.3 V
instead doesn't work either: the input LED lights, but the coil is too weak to click. An NPN
transistor (2N2222 / 2N3904 / BC547 + 1 kΩ) between GPIO 17 and IN fixes both problems. Set
`RELAY_ACTIVE_HIGH=true`. Wiring: [docs/WIRING.md](docs/WIRING.md#5-v-relay-boards-and-the-pis-33-v-signal) (Fix C).
Some boards accept 3.3 V directly; if yours turns fully on and off when IN goes straight to pin 11, you can skip the transistor.
**No transistor?** Wire IN straight to pin 11 and set `RELAY_DRIVE=open-drain` (with `RELAY_ACTIVE_HIGH=false`) in
`config/wot.env`: OFF then releases the pin and the board switches itself off. See WIRING.md, Fix E.

*LED instead of relay:* GPIO 17 (pin 11) → 330 Ω → LED long leg; LED short leg → GND (pin 14).
Then set `RELAY_ACTIVE_HIGH=true` in `config/wot.env`.

Pins can be changed in `config/wot.env` (`DHT_GPIO`, `RELAY_GPIO`).

## 3. Install on the Pi (one time, ~10 min)

**a) Prepare the SD card** with *Raspberry Pi Imager*: choose Raspberry Pi OS, click the ⚙ / "Edit settings"
button, set a hostname (e.g. `wotpi`), username/password, Wi-Fi, and **enable SSH**. Boot the Pi.

**b) Copy this folder to the Pi.** From the Windows PowerShell on your PC, inside the folder that
*contains* the project folder (`iot-project`):

```powershell
scp -r .\iot-project pi@wotpi.local:~/wot-gateway
```

(replace `pi` with your username; `node_modules`, `.venv`, `data` and `results` are not needed —
delete them first if they exist, the installer recreates them). A USB stick or `git clone` works just as well.

**c) Run the installer on the Pi:**

```bash
ssh pi@wotpi.local
cd ~/wot-gateway
bash install.sh
sudo reboot          # only needed the first time (loads the DHT22 kernel driver)
```

The installer is idempotent and does everything:

- apt: Mosquitto, Node.js ≥ 18, Python venv, psutil, matplotlib, gpiozero/lgpio
- configures Mosquitto (anonymous, lab network), creates `config/wot.env`
- creates `.venv` (aiohttp, aiocoap, paho-mqtt) and installs node-wot (`npm ci`)
- adds `dtoverlay=dht11,gpiopin=4` to `/boot/firmware/config.txt` (the kernel `dht11` driver also reads the DHT22)
- installs **6 systemd services** grouped in `wot.target`, enabled at boot

Options: `bash install.sh --adafruit-dht` (use the Adafruit library instead of the kernel driver),
`--no-overlay`, `--no-start`.

## 4. Run it

After the reboot **everything starts automatically**. Check:

```bash
cd ~/wot-gateway
./wotctl status
```

```
  mosquitto      active
  directory      active
  sensor         active
  relay          active
  plug           active
  gateway        active
  app            active

  proxy  Fan Relay                    native=coap   reads=12 actions=2 events=3 errors=0
  proxy  Temperature Sensor           native=mqtt   reads=0 actions=0 events=310 errors=0
  proxy  Heater Smart Plug            native=http   reads=5 actions=1 events=1 errors=0

  app    state=running  mode=gateway  temp=23.4 °C  threshold=28  fan=off  fan-via=http+ws
  relay TD protocol: coap    sensor backend: dht22-kernel-iio
```

Open the **dashboard** from any computer on the same network: `http://wotpi.local:8090/`
(`./wotctl urls` prints all addresses).

| Command | |
|---|---|
| `./wotctl status` | services, proxies, application state, sensor backend |
| `./wotctl logs [gateway\|app\|sensor\|relay\|plug\|directory]` | follow logs |
| `./wotctl restart [service]` / `stop` / `start` | control services |
| `./wotctl threshold 22` | set the fan threshold (°C) |
| `./wotctl mode direct` / `mode gateway` | app talks to devices directly / via the gateway |
| `./wotctl fan on` / `fan off` | switch the fan through the gateway |
| `./wotctl swap mqtt` / `swap coap` | **move the relay to another protocol — edits only its TD** |
| `./wotctl evaluate` | run every experiment → `results/REPORT.md` |

### Demo script (≈ 2 min, for the video)

1. Show `./wotctl status` and the dashboard: three devices, three protocols, one gateway.
2. Breathe on / hold the DHT22 (or `./wotctl threshold 22`): temperature crosses the threshold →
   **fan turns on, heater plug turns off**, alert appears on the dashboard.
3. `./wotctl threshold 35` → fan turns off.
4. `./wotctl swap mqtt` → `./wotctl status` shows `native=mqtt`; repeat step 2 — **same app, no code change**.
5. `./wotctl mode direct` → app now drives the relay over MQTT itself; repeat step 2.
6. `./wotctl swap coap` to go back.

### Talking to the gateway yourself

```bash
curl http://wotpi.local:8080/temperature-sensor/properties/temperature    # MQTT device, read over HTTP
curl -X POST http://wotpi.local:8080/fan-relay/actions/toggle             # CoAP device, action over HTTP
curl -X PUT -H 'Content-Type: application/json' -d true http://wotpi.local:8080/fan-relay/properties/on
curl http://wotpi.local:8080/heater-smart-plug/events/stateChanged         # long-poll (waits for next event)
curl http://wotpi.local:8090/things                                         # every Thing Description
```

WebSocket events: `ws://wotpi.local:8081/temperature-sensor/events/measurement`.

## 5. Evaluation

```bash
./wotctl evaluate          # ≈ 15 min; or run the steps individually:
./wotctl validate --live   # all TDs through the W3C TD-playground validator
./wotctl swap-test         # CoAP→MQTT→CoAP × gateway/direct, counts changed lines of code
./wotctl bench-latency     # direct vs gateway: read / action / event, p50 + p95
./wotctl bench-scale       # gateway CPU / RAM with 0, 10, 25, 50, 75, 100 simulated devices
./wotctl plots             # results/plots/*.png + results/REPORT.md
```

Details of every metric: [docs/DELIVERABLES_AND_METRICS.md](docs/DELIVERABLES_AND_METRICS.md).

## 6. Configuration

Everything lives in **`config/wot.env`** (created from `config/wot.env.example`): GPIO pins, relay polarity,
threshold/hysteresis, ports, sensor backend, application mode. After editing: `./wotctl restart`.

## 7. Troubleshooting

| Symptom | Fix |
|---|---|
| `sensor backend: simulated` in `wotctl status` | Reboot after install; check DATA is on GPIO 4 and VCC on 3.3 V; `ls /sys/bus/iio/devices/` should show a device. Or try `bash install.sh --adafruit-dht`. |
| Relay clicks the wrong way round (on when it should be off) | Flip `RELAY_ACTIVE_HIGH` in `config/wot.env`, `./wotctl restart relay`. |
| Relay never switches off (LED stays on, no click) | The board is powered from 5 V but the Pi's signal only reaches 3.3 V. Power relay VCC from **pin 17 (3.3 V)**. If it then doesn't click at all, power VCC from pin 2 (5 V) and add an NPN transistor — see [docs/WIRING.md](docs/WIRING.md#5-v-relay-boards-and-the-pis-33-v-signal). |
| Dashboard not reachable from the PC | Use the IP from `./wotctl urls`; the PC must be on the same network. |
| A service is `failed` | `./wotctl logs <service>` shows why. |
| Pi's IP address changed | Nothing to do — TDs are re-generated with the current IP when services restart (`./wotctl restart`). |

## 8. Running without a Pi (development)

Everything also runs on a laptop with Python ≥ 3.10, Node ≥ 18 and an MQTT broker
(the sensor falls back to simulation, the relay to a mock): set `WOT_HOST=127.0.0.1` and
`DHT_BACKEND=sim` in `config/wot.env`, then start in this order:
`node src/directory/server.js`, the three `python devices/*.py`, `node src/gateway/gateway.js`, `node src/app/app.js`.

## Repository layout

```
config/wot.env.example      single configuration file (copied to wot.env)
things/                     ACTIVE Thing Descriptions of the 3 devices (fan-relay.td.json is the one the swap changes)
things/templates/           all validated TD templates (CoAP + MQTT relay, sensor, plug, simulated devices)
devices/                    Python devices: TD-driven runtime (wotdev/), sensor, relay, plug, simulator
src/directory/              Thing Description Directory (WoT Discovery API) + dashboard
src/gateway/                node-wot gateway
src/app/app.js              the protocol-independent application (the file that must never change)
src/lib/                    shared Node code (config, servient factory, app runtime, directory client)
src/tools/                  TD validator, protocol-swap test
src/bench/, bench/          latency benchmark, scalability benchmark, plots/report
install.sh, wotctl          installer and control script
```
