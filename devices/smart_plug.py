#!/usr/bin/env python3
"""Software-simulated HTTP smart plug (powers a virtual 1.5 kW heater).

Protocol comes from things/smart-plug.td.json (HTTP by default).
"""
import asyncio
import os
import random

from wotdev import ThingRuntime, load_config, load_td, now_ms, run_device, setup_logging

log = setup_logging("smart-plug")


async def main():
    cfg = load_config()
    td = load_td(os.environ.get("PLUG_TD", "things/smart-plug.td.json"), cfg)
    thing = ThingRuntime(td)
    state = {"on": True, "seq": 0}   # heater starts ON

    def power():
        return round(1500 + random.uniform(-25, 25), 1) if state["on"] else round(random.uniform(0.3, 0.6), 2)

    async def set_state(on):
        on = bool(on)
        if on != state["on"]:
            state["on"] = on
            state["seq"] += 1
            log.info("plug %s", "ON" if on else "OFF")
            await thing.property_changed("on")
            thing.emit_event("stateChanged", {"on": on, "ts": now_ms(), "seq": state["seq"]})

    async def read_on():
        return state["on"]

    async def read_power():
        return power()

    async def write_on(v):
        await set_state(v)

    async def turn_on(_):
        await set_state(True)

    async def turn_off(_):
        await set_state(False)

    async def toggle(_):
        await set_state(not state["on"])

    thing.on_read("on", read_on)
    thing.on_read("power", read_power)
    thing.on_write("on", write_on)
    thing.on_action("turnOn", turn_on)
    thing.on_action("turnOff", turn_off)
    thing.on_action("toggle", toggle)

    async def meter_loop():
        while True:
            await asyncio.sleep(2)
            await thing.property_changed("power")

    await run_device(cfg, [thing], background=[meter_loop()])


if __name__ == "__main__":
    asyncio.run(main())
