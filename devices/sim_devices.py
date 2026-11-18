#!/usr/bin/env python3
"""Spawn N simulated WoT devices spread round-robin over HTTP, CoAP and MQTT.

Every device has its own TD (from things/templates/sim-device.<proto>.td.json),
registered in the Thing Directory, so the gateway proxies them like real devices.

    python devices/sim_devices.py --count 30 --tick 5 --prefix scale-a
    python devices/sim_devices.py --count 3 --tick 0.25 --prefix lat      # latency test

Each device offers: property `value`, action `ping`, event `tick` {value, ts, seq}.
"""
import argparse
import asyncio
import random

from wotdev import ThingRuntime, load_config, load_td, now_ms, run_device, setup_logging

log = setup_logging("sim-devices")


def build(cfg, idx, proto, prefix, port_offset=0):
    sim_id = f"{prefix}-{proto}-{idx}"
    td = load_td(f"things/templates/sim-device.{proto}.td.json", cfg, {
        "SIM_ID": sim_id,
        "SIM_HTTP_PORT": cfg.int("SIM_HTTP_PORT", 8092) + port_offset,
        "SIM_COAP_PORT": cfg.int("SIM_COAP_PORT", 5684) + port_offset,
    })
    thing = ThingRuntime(td)
    state = {"value": round(random.uniform(18, 26), 2), "seq": 0}

    async def read_value():
        return state["value"]

    async def ping(_input):
        return None

    thing.on_read("value", read_value)
    thing.on_action("ping", ping)
    return thing, state


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=10)
    ap.add_argument("--tick", type=float, default=5.0, help="seconds between tick events per device (0 = none)")
    ap.add_argument("--prefix", default="sim")
    ap.add_argument("--protocols", default="http,coap,mqtt")
    ap.add_argument("--port-offset", type=int, default=0,
                    help="added to SIM_HTTP_PORT / SIM_COAP_PORT so several sim processes can run at once")
    args = ap.parse_args()

    cfg = load_config()
    protos = [p.strip() for p in args.protocols.split(",") if p.strip()]
    things = []
    for i in range(args.count):
        things.append(build(cfg, i, protos[i % len(protos)], args.prefix, args.port_offset))
    log.info("starting %d simulated devices (%s), tick=%.2fs", args.count, ",".join(protos), args.tick)

    async def tick_loop(thing, state, offset):
        await asyncio.sleep(offset)
        while True:
            state["value"] = round(state["value"] + random.uniform(-0.2, 0.2), 2)
            state["seq"] += 1
            await thing.property_changed("value")
            thing.emit_event("tick", {"value": state["value"], "ts": now_ms(), "seq": state["seq"]})
            await asyncio.sleep(args.tick)

    background = []
    if args.tick > 0:
        for i, (thing, state) in enumerate(things):
            background.append(tick_loop(thing, state, (i / max(1, len(things))) * args.tick))
    await run_device(cfg, [t for t, _ in things], background=background)


if __name__ == "__main__":
    asyncio.run(main())
