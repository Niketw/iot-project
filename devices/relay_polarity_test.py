#!/usr/bin/env python3
"""Check that the fan follows the software, using the RELAY_ACTIVE_HIGH you have configured.

Run on the Pi with the wot-relay service STOPPED (it owns the GPIO pin):

    sudo systemctl stop wot-relay
    .venv/bin/python devices/relay_polarity_test.py

It drives the relay ON for 5 s, then OFF for 5 s, twice, and prints the pin level.
Watch the fan (or the relay's LED) while it runs:
  - fan spins during ON and stops during OFF          -> RELAY_ACTIVE_HIGH is correct
  - fan is ON during OFF (or OFF during ON)           -> flip RELAY_ACTIVE_HIGH in config/wot.env
Then start the service again:  sudo systemctl start wot-relay
"""
import time

from gpiozero import OutputDevice

from wotdev.config import load_config

cfg = load_config()
pin_no = cfg.int("RELAY_GPIO", 17)
active_high = cfg.bool("RELAY_ACTIVE_HIGH", False)


def pin_level(on: bool) -> str:
    # active-high board: relay energised when the pin is HIGH; active-low: when LOW
    return "HIGH" if on == active_high else "LOW"


print(f"GPIO{pin_no}, RELAY_ACTIVE_HIGH={str(active_high).lower()} (from config/wot.env)")
dev = OutputDevice(pin_no, active_high=active_high, initial_value=False)
try:
    for _ in range(2):
        for on in (True, False):
            dev.value = on  # gpiozero: value True = relay ON for the configured polarity
            print(f"  relay {'ON ' if on else 'OFF'}  pin {pin_level(on)}  (watch the fan for 5 s)")
            time.sleep(5)
finally:
    dev.off()
    dev.close()
print("Done. If the fan did not follow ON/OFF, change RELAY_ACTIVE_HIGH and run this again.")
