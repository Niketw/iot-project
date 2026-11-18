#!/usr/bin/env python3
"""MQTT temperature sensor (DHT22).

Protocol is whatever things/temperature-sensor.td.json says (MQTT by default).
Sensor backends, tried in order when DHT_BACKEND=auto:
  1. kernel  - Linux IIO driver loaded with `dtoverlay=dht11,gpiopin=<DHT_GPIO>`
               (the dht11 driver also decodes DHT22). Most reliable on a Pi.
  2. adafruit - adafruit-circuitpython-dht (pip install adafruit-circuitpython-dht)
  3. sim      - smooth simulated temperature so everything still works without hardware
"""
import asyncio
import glob
import math
import os
import random
import time

from wotdev import ThingRuntime, load_config, load_td, now_ms, run_device, setup_logging

log = setup_logging("temperature-sensor")


class KernelDHT:
    name = "dht22-kernel-iio"

    def __init__(self, gpio):
        self.dev = None
        for dev in glob.glob("/sys/bus/iio/devices/iio:device*"):
            try:
                with open(os.path.join(dev, "name")) as fh:
                    if "dht" in fh.read().lower() and os.path.exists(os.path.join(dev, "in_temp_input")):
                        self.dev = dev
                        break
            except OSError:
                continue
        if self.dev is None:
            raise RuntimeError("no DHT IIO device - add 'dtoverlay=dht11,gpiopin=%d' to config.txt and reboot" % gpio)

    def read(self):
        with open(os.path.join(self.dev, "in_temp_input")) as fh:
            t = int(fh.read()) / 1000.0
        with open(os.path.join(self.dev, "in_humidityrelative_input")) as fh:
            h = int(fh.read()) / 1000.0
        return t, h


class AdafruitDHT:
    name = "dht22-adafruit"

    def __init__(self, gpio):
        import adafruit_dht  # noqa: import inside so missing lib only matters if selected
        import board
        self.dev = adafruit_dht.DHT22(getattr(board, f"D{gpio}"), use_pulseio=False)
        self.read()  # fail fast if wiring is wrong

    def read(self):
        t = self.dev.temperature
        h = self.dev.humidity
        if t is None or h is None:
            raise RuntimeError("empty reading")
        return float(t), float(h)


class SimulatedDHT:
    """Room temperature that slowly swings 23 -> 31 degC (period 6 min) so the fan rule fires."""
    name = "simulated"

    def __init__(self, gpio=None):
        self.t0 = time.time()

    def read(self):
        phase = (time.time() - self.t0) / 360.0 * 2 * math.pi
        t = 27.0 + 4.0 * math.sin(phase - math.pi / 2) + random.uniform(-0.1, 0.1)
        h = 45.0 + 5.0 * math.cos(phase) + random.uniform(-0.3, 0.3)
        return round(t, 2), round(h, 1)


def pick_backend(mode, gpio):
    order = {"auto": [KernelDHT, AdafruitDHT, SimulatedDHT], "kernel": [KernelDHT],
             "adafruit": [AdafruitDHT], "sim": [SimulatedDHT]}.get(mode, [SimulatedDHT])
    for cls in order:
        try:
            backend = cls(gpio)
            if cls is not SimulatedDHT:
                backend.read()
            log.info("sensor backend: %s", backend.name)
            return backend
        except Exception as exc:
            # The kernel driver often returns EIO on a single read - retry a few times before giving up.
            if cls is KernelDHT and "no DHT IIO device" not in str(exc):
                for _ in range(5):
                    time.sleep(2.1)
                    try:
                        backend.read()
                        log.info("sensor backend: %s", backend.name)
                        return backend
                    except Exception:
                        continue
            log.warning("backend %s unavailable: %s", cls.name, exc)
    raise SystemExit("no sensor backend available (set DHT_BACKEND=sim to simulate)")


async def main():
    cfg = load_config()
    td = load_td(os.environ.get("SENSOR_TD", "things/temperature-sensor.td.json"), cfg)
    backend = pick_backend(cfg.get("DHT_BACKEND", "auto"), cfg.int("DHT_GPIO", 4))
    simulated = isinstance(backend, SimulatedDHT)
    if simulated:
        log.warning("*** USING SIMULATED TEMPERATURE - check DHT22 wiring / overlay ***")

    state = {"temperature": None, "humidity": None, "seq": 0}
    first = backend.read()
    state["temperature"], state["humidity"] = round(first[0], 2), round(first[1], 1)

    thing = ThingRuntime(td)

    async def read_temperature():
        return state["temperature"]

    async def read_humidity():
        return state["humidity"]

    thing.on_read("temperature", read_temperature)
    thing.on_read("humidity", read_humidity)

    interval = max(2.0, cfg.float("SENSOR_INTERVAL_S", 2))

    async def sample_loop():
        loop = asyncio.get_running_loop()
        failures = 0
        while True:
            await asyncio.sleep(interval)
            try:
                t, h = await loop.run_in_executor(None, backend.read)
            except Exception as exc:
                failures += 1
                if failures % 10 == 1:
                    log.warning("sensor read failed (%s) - keeping last value", exc)
                continue
            # DHT22 occasionally returns garbage; reject impossible values / jumps
            if not (-40 <= t <= 80 and 0 <= h <= 100):
                continue
            if state["temperature"] is not None and abs(t - state["temperature"]) > 10 and failures < 3:
                failures += 1
                continue
            failures = 0
            state["temperature"], state["humidity"] = round(t, 2), round(h, 1)
            state["seq"] += 1
            await thing.property_changed("temperature")
            await thing.property_changed("humidity")
            thing.emit_event("measurement", {
                "temperature": state["temperature"], "humidity": state["humidity"],
                "ts": now_ms(), "seq": state["seq"], "simulated": simulated,
            })

    await run_device(cfg, [thing], background=[sample_loop()])


if __name__ == "__main__":
    asyncio.run(main())
