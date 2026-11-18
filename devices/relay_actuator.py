#!/usr/bin/env python3
"""Fan relay / LED actuator.

The protocol is decided ONLY by the TD in RELAY_TD (default things/fan-relay.td.json):
copy things/templates/fan-relay.coap.td.json or fan-relay.mqtt.td.json over it
(`./wotctl swap coap|mqtt`) and restart - this code does not change.
"""
import asyncio
import logging
import os

from wotdev import ThingRuntime, load_config, load_td, now_ms, run_device, setup_logging

log = setup_logging("fan-relay")


class GpioRelay:
    def __init__(self, pin, active_high):
        from gpiozero import OutputDevice
        self.dev = OutputDevice(pin, active_high=active_high, initial_value=False)
        self.name = f"GPIO{pin} ({'active-high' if active_high else 'active-low'})"

    def set(self, on):
        self.dev.on() if on else self.dev.off()

    def get(self):
        return bool(self.dev.value)


class MockRelay:
    name = "mock (no GPIO available)"

    def __init__(self):
        self.on = False

    def set(self, on):
        self.on = on

    def get(self):
        return self.on


async def main():
    cfg = load_config()
    td_path = os.environ.get("RELAY_TD") or cfg.get("RELAY_TD", "things/fan-relay.td.json")
    td = load_td(td_path, cfg)
    try:
        relay = GpioRelay(cfg.int("RELAY_GPIO", 17), cfg.bool("RELAY_ACTIVE_HIGH", False))
    except Exception as exc:
        logging.getLogger("fan-relay").warning("GPIO unavailable (%s) - using a mock relay", exc)
        relay = MockRelay()
    log.info("relay output: %s; TD: %s", relay.name, td_path)

    thing = ThingRuntime(td)
    seq = {"n": 0}

    async def set_state(on: bool):
        on = bool(on)
        changed = relay.get() != on
        relay.set(on)
        if changed:
            seq["n"] += 1
            log.info("fan %s", "ON" if on else "OFF")
            await thing.property_changed("on")
            thing.emit_event("stateChanged", {"on": on, "ts": now_ms(), "seq": seq["n"]})

    async def read_on():
        return relay.get()

    async def write_on(value):
        await set_state(value)

    async def turn_on(_input):
        await set_state(True)

    async def turn_off(_input):
        await set_state(False)

    async def toggle(_input):
        await set_state(not relay.get())

    thing.on_read("on", read_on)
    thing.on_write("on", write_on)
    thing.on_action("turnOn", turn_on)
    thing.on_action("turnOff", turn_off)
    thing.on_action("toggle", toggle)

    try:
        await run_device(cfg, [thing])
    finally:
        relay.set(False)  # fail safe: fan off when the service stops


if __name__ == "__main__":
    asyncio.run(main())
