"""Configuration loader shared by every Python device.

Values come from config/wot.env (same file systemd and the Node.js services use);
real environment variables override the file.
"""
import json
import os
import socket
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
ENV_FILE = PROJECT_ROOT / "config" / "wot.env"
ENV_EXAMPLE = PROJECT_ROOT / "config" / "wot.env.example"


def _parse_env_file(path: Path) -> dict:
    values = {}
    if not path.exists():
        return values
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        val = val.split(" #", 1)[0].strip().strip('"').strip("'")
        values[key.strip()] = val
    return values


def _detect_host() -> str:
    try:
        out = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=2).stdout.split()
        for addr in out:
            if ":" not in addr:          # prefer IPv4
                return addr
    except Exception:
        pass
    try:  # works when there is a default route; sends no packets
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        addr = s.getsockname()[0]
        s.close()
        return addr
    except Exception:
        return "127.0.0.1"


class Config(dict):
    def __getattr__(self, item):
        try:
            return self[item]
        except KeyError as exc:
            raise AttributeError(item) from exc

    def int(self, key, default=0):
        return int(float(self.get(key, default)))

    def float(self, key, default=0.0):
        return float(self.get(key, default))

    def bool(self, key, default=False):
        return str(self.get(key, default)).strip().lower() in ("1", "true", "yes", "on")


def load_config() -> Config:
    values = _parse_env_file(ENV_EXAMPLE)          # defaults
    values.update(_parse_env_file(ENV_FILE))       # user settings
    for key in list(values.keys()):
        if key in os.environ:
            values[key] = os.environ[key]
    for key, val in os.environ.items():            # extra overrides (e.g. WOT_HOST)
        if key.isupper() and key not in values and key.startswith(("WOT_", "SIM_", "MQTT_", "COAP_")):
            values[key] = val
    if values.get("WOT_HOST", "auto") in ("", "auto"):
        values["WOT_HOST"] = _detect_host()
    values.setdefault("DIRECTORY_URL", f"http://127.0.0.1:{values.get('DIRECTORY_PORT', '8090')}")
    return Config(values)


def load_td(path, cfg: Config, extra: dict | None = None) -> dict:
    """Load a TD (template) and fill {{PLACEHOLDERS}} from config + extra."""
    p = Path(path)
    if not p.is_absolute():
        p = PROJECT_ROOT / p
    text = p.read_text(encoding="utf-8")
    subs = dict(cfg)
    subs.update(extra or {})
    for key, val in subs.items():
        text = text.replace("{{" + key + "}}", str(val))
    if "{{" in text:
        start = text.index("{{")
        raise ValueError(f"Unfilled placeholder in {p}: {text[start:start + 40]}")
    return json.loads(text)
