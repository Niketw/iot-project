#!/usr/bin/env python3
"""Check that the fan follows the software, using the RELAY_ACTIVE_HIGH you have configured.

Run on the Pi from the project folder, with the wot-relay service STOPPED (it owns the GPIO pin):

    sudo systemctl stop wot-relay
    .venv/bin/python devices/relay_polarity_test.py

It drives the relay ON for 5 s, then OFF for 5 s, twice, and prints the pin level.
Watch the fan (or the relay's LED) while it runs:
  - fan spins during ON and stops during OFF          -> RELAY_ACTIVE_HIGH is correct
  - fan is ON during OFF (or OFF during ON)           -> flip RELAY_ACTIVE_HIGH in config/wot.env
Then start the service again:  sudo systemctl start wot-relay

This script only needs gpiozero. It reads config/wot.env itself, so it does not import the
rest of the project (that import is what failed before).
"""
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read_settings():
    """config/wot.env if present, otherwise config/wot.env.example, otherwise built-in defaults."""
    values = {"RELAY_GPIO": "17", "RELAY_ACTIVE_HIGH": "false"}
    for name in ("wot.env.example", "wot.env"):
        f = ROOT / "config" / name
        if not f.exists():
            continue
        for raw in f.read_text(encoding="utf-8", errors="replace").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            values[key.strip()] = val.split(" #", 1)[0].strip().strip("\"'")
    return values


def main():
    try:
        from gpiozero import OutputDevice
    except ImportError:
        print("gpiozero is not available to this Python:", sys.executable)
        print("On the Pi run it with the project's venv:  .venv/bin/python devices/relay_polarity_test.py")
        print("If the venv lacks it:  sudo apt install python3-gpiozero python3-lgpio")
        return 1

    settings = read_settings()
    pin_no = int(settings["RELAY_GPIO"])
    active_high = settings["RELAY_ACTIVE_HIGH"].lower() in ("1", "true", "yes", "on")

    def pin_level(on):
        # active-high board: relay energised when pin is HIGH; active-low: when LOW
        return "HIGH" if on == active_high else "LOW"

    print(f"Python: {sys.executable}")
    print(f"GPIO{pin_no}, RELAY_ACTIVE_HIGH={str(active_high).lower()} (from config/wot.env)")
    try:
        dev = OutputDevice(pin_no, active_high=active_high, initial_value=False)
    except Exception as exc:
        print(f"Cannot open GPIO{pin_no}: {exc}")
        print("Check that the service is stopped and that this user is in the 'gpio' group.")
        return 1
    try:
        for _ in range(2):
            for on in (True, False):
                dev.value = on
                print(f"  relay {'ON ' if on else 'OFF'}  pin {pin_level(on)}  (watch the fan for 5 s)", flush=True)
                time.sleep(5)
    finally:
        dev.off()
        dev.close()
    print("Done. If the fan did not follow ON/OFF, change RELAY_ACTIVE_HIGH and run this again.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
