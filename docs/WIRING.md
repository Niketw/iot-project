# Wiring

All pin numbers below are **physical pin numbers** on the Pi's 40-pin header, with the BCM (GPIO) name in
brackets. The software uses BCM numbers (`DHT_GPIO=4`, `RELAY_GPIO=17` in `config/wot.env`).

```
                    Raspberry Pi 40-pin header (pin 1 is next to the SD-card end, inner row)
                         3V3  (1) (2)  5V
                       GPIO2  (3) (4)  5V
                       GPIO3  (5) (6)  GND
     DHT22 DATA ──── GPIO4  (7) (8)  GPIO14
                         GND  (9) (10) GPIO15
     Relay IN ────── GPIO17 (11) (12) GPIO18
                      GPIO27 (13) (14) GND
                         ...
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
| IN (IN1) | pin 11 (GPIO 17) |

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
- If the relay never switches off: the board needs a 5 V "high" level. Power the board's VCC from 3.3 V (pin 1)
  instead, or use a board with a high/low-trigger jumper set to "high", or a 3.3 V relay module.

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
