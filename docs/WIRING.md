# Wiring

All pin numbers below are **physical pin numbers** on the Pi's 40-pin header, with the BCM (GPIO) name in
brackets. The software uses BCM numbers (`DHT_GPIO=4`, `RELAY_GPIO=17` in `config/wot.env`).

> **Pin 17 is not GPIO 17.** Physical *pin 17* is a 3.3 V power pin (relay VCC). *GPIO 17* is the signal on
> physical *pin 11* (relay IN). Power pins never appear in the software; only GPIO numbers do.

```
                    Raspberry Pi 40-pin header (pin 1 is next to the SD-card end, inner row)
     DHT22 VCC ──────  3V3  (1) (2)  5V
                       GPIO2  (3) (4)  5V   ──── fan circuit (COM)
                       GPIO3  (5) (6)  GND  ──── relay GND
     DHT22 DATA ──── GPIO4  (7) (8)  GPIO14
     DHT22 GND ───────  GND  (9) (10) GPIO15
     Relay IN* ───── GPIO17 (11) (12) GPIO18
                      GPIO27 (13) (14) GND  ──── fan black (−)
                         ...
     Relay VCC → pin 2 (5V).   * on most boards via an NPN transistor (Fix C)
```

**Always wire with the Pi powered off.**

## DHT22 temperature / humidity sensor → GPIO 4

### 3-pin module (has the pull-up resistor on board)

| DHT22 module | Pi |
|---|---|
| `+` / VCC | pin 1 (3.3 V) |
| `out` / DATA | pin 7 (GPIO 4) |
| `−` / GND | pin 9 (GND) |

### Bare 4-pin sensor (looking at the grille, pins down, left → right)

| DHT22 pin | Pi |
|---|---|
| 1 VCC | pin 1 (3.3 V) |
| 2 DATA | pin 7 (GPIO 4) **and** a **10 kΩ resistor to 3.3 V** |
| 3 — | not connected |
| 4 GND | pin 9 (GND) |

Use 3.3 V, not 5 V: the data line goes straight into the Pi's GPIO, which is not 5 V tolerant.

**How it is read:** the installer adds `dtoverlay=dht11,gpiopin=4` to `/boot/firmware/config.txt`. After a
reboot the Linux kernel's `dht11` IIO driver (which also decodes the DHT22) exposes the readings in
`/sys/bus/iio/devices/iio:deviceN/in_temp_input`. Kernel timing is far more reliable than user-space
bit-banging. Check by hand:

```bash
cat /sys/bus/iio/devices/iio:device0/in_temp_input        # e.g. 23400 = 23.4 °C (occasional "I/O error" is normal - retry)
```

## Relay module + small DC fan → GPIO 17

| Relay module | Pi |
|---|---|
| VCC | pin 2 (5 V) |
| GND | pin 6 (GND) |
| IN (IN1) | pin 11 (GPIO 17), **through an NPN transistor on most boards** (Fix C below) |

Most 5 V boards need IN at 5 V to switch off, and the Pi only reaches 3.3 V (see the next section). Test
yours: if wiring IN straight to pin 11 gives clean click-on / click-off, no transistor is needed. If the
relay stays on, use Fix C. Powering the board from 3.3 V (pin 17) usually fails: the LED switches but the
coil doesn't click.

Fan circuit through the relay's switch contacts (screw terminals):

```
 Pi pin 4 (5V) ───── COM ┐
                         │ relay contact (closes when the relay is ON)
 fan red  (+) ────── NO  ┘
 fan black (−) ───── Pi pin 14 (GND)
```

- Use a small 5 V fan (≤ 200 mA). For a 12 V fan, put a separate 12 V supply in place of "Pi 5V / GND"
  on the fan side (connect only the supply's + to COM and − to the fan's black wire).
- Most blue relay boards are **active-low** (IN = 0 V → relay on). That is the default
  (`RELAY_ACTIVE_HIGH=false`). If yours behaves inverted, set it to `true`.
- At power-on, before the service starts, an active-low relay may click on briefly. That is normal; the service
  switches it off at start and again when it stops.
- **If the relay never switches off** (LED stays on, no click, fan always runs), see the next section.

### 5 V relay boards and the Pi's 3.3 V signal

Many 5 V relay boards are active-low: IN pulled LOW = relay on, IN at **5 V** = relay off. The Pi can only
raise IN to **3.3 V**. That leaves about 1.7 V across the board's input LED, which keeps the relay energised.
So the relay stays on whatever the software does.

**Confirm it first.** Pull the IN wire off GPIO 17 and touch it to 5 V (pin 2). If the relay switches off,
this is the problem. IN goes into the relay board, not into the Pi, so this is safe.

**Fix A: the board has a JD-VCC jumper** (a 3-pin header labelled `JD-VCC  VCC  GND`, jumper on the first two):

| Wire | To |
|---|---|
| remove the jumper cap | |
| `JD-VCC` | Pi pin 2 (5 V), powers the relay coil |
| `VCC` (on the 3-pin header or the input header) | Pi pin 17 (3.3 V), powers the input LED |
| `GND` | Pi pin 6 (GND) |
| `IN` | Pi pin 11 (GPIO 17) |

Keep `RELAY_ACTIVE_HIGH=false`. Now 3.3 V on IN fully switches the relay off.

**Fix B: the board has a trigger jumper labelled `H` / `L` (or `HIGH` / `LOW`).** Move it to **H**, keep VCC
on 5 V, and set `RELAY_ACTIVE_HIGH=true`.

**No jumper, no parts: try powering the board from 3.3 V.** Move the relay's VCC wire from pin 2 (5 V) to
the Pi's second 3.3 V pin, **pin 17** (pin 1 is taken by the DHT22); GND and IN stay as they are. Now the Pi's 3.3 V HIGH equals the board's supply, so the input
LED switches fully off. Catch: the 5 V relay coil now gets only 3.3 V and often can't pull in. A common
symptom is that **the board's LED turns on and off but there is no click**, so the fan never runs. If you
see that, put VCC back on pin 2 and use Fix C. Only if you hear four clean clicks in the polarity test is
this option enough.

**Fix C: no jumper. Add an NPN transistor** (2N2222, BC547 or 2N3904 plus a 1 kΩ resistor; 330 Ω–2.2 kΩ also works):

```
 Pi pin 11 (GPIO17) ── 1 kΩ ── B (base)
                               C (collector) ── relay IN
                               E (emitter)   ── Pi pin 6 (GND)
 relay VCC ── Pi pin 2 (5 V),   relay GND ── Pi pin 6 (GND)
```

GPIO HIGH turns the transistor on, which pulls IN to GND and energises the relay. GPIO LOW turns it off, and
the board pulls IN up to 5 V. The Pi never sees 5 V. Set `RELAY_ACTIVE_HIGH=true`. 2N2222 and 2N3904 in
the TO-92 package, flat face towards you and legs down, are **E B C** from left to right; BC547 is **C B E**.

**Fix E: no transistor, no jumper. Use open-drain mode (software only).** Keep VCC on pin 2 (5 V) and IN
straight on pin 11. In `config/wot.env` set:

```
RELAY_ACTIVE_HIGH=false
RELAY_DRIVE=open-drain
```

Then `./wotctl restart relay`. Now ON drives GPIO 17 LOW and OFF *releases* the pin (floating input), so the
board pulls IN up to its own 5 V and the relay switches off. Clue that your board needs this: the relay clicks
off when the relay service *stops* (pin released) but never when the software says off. Check with
`.venv/bin/python devices/relay_polarity_test.py open-drain`.

*Caveat:* a released pin can float a little above 3.3 V, outside the Pi's specification. The only current
that can flow into it is the board's input-LED current, which is tiny once the relay is off. This trick is
widely used with these boards. Fix C is the by-the-book solution.

**Fix D: LED instead of relay** (for the demo). See the LED section below; set `RELAY_ACTIVE_HIGH=true`.

After any fix: `sudo systemctl stop wot-relay`, run `.venv/bin/python devices/relay_polarity_test.py`, check
the relay clicks with the ON/OFF phases, then `sudo systemctl start wot-relay`.

## LED instead of the relay → GPIO 17

```
 Pi pin 11 (GPIO17) ── 330 Ω ──▶|── Pi pin 14 (GND)
                            long leg   short leg
```

Set `RELAY_ACTIVE_HIGH=true` in `config/wot.env`, then `./wotctl restart relay`.

## Quick hardware test (after install)

```bash
./wotctl fan on      # relay clicks / LED lights
./wotctl fan off
./wotctl status      # look for "sensor backend: dht22-kernel-iio" and a sensible temperature
```
