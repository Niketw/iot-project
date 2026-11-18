#!/usr/bin/env bash
# =============================================================================
#  WoT Smart-Building Gateway - one-shot installer for Raspberry Pi OS
#  (Bookworm or Trixie, 32- or 64-bit). Run from the project folder:
#
#      bash install.sh                 # everything (recommended)
#      bash install.sh --adafruit-dht  # read the DHT22 with the Adafruit library instead of the kernel driver
#      bash install.sh --no-overlay    # do not touch /boot/firmware/config.txt
#      bash install.sh --no-start      # install but do not start the services
#
#  Safe to re-run (idempotent).
# =============================================================================
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER="${SUDO_USER:-$(id -un)}"
RUN_GROUP="$(id -gn "$RUN_USER")"
ADAFRUIT=0; OVERLAY=1; START=1
for a in "$@"; do
  case "$a" in
    --adafruit-dht) ADAFRUIT=1; OVERLAY=0 ;;
    --no-overlay)   OVERLAY=0 ;;
    --no-start)     START=0 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option $a"; exit 1 ;;
  esac
done

SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
as_user() { if [ "$(id -un)" = "$RUN_USER" ]; then "$@"; else sudo -u "$RUN_USER" -H "$@"; fi; }
step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }

cd "$PROJECT_DIR"
echo "Project: $PROJECT_DIR    service user: $RUN_USER"

# --- 0. normalise line endings (files copied from Windows) --------------------
step "Preparing files"
find "$PROJECT_DIR" -path "$PROJECT_DIR/node_modules" -prune -o -path "$PROJECT_DIR/.venv" -prune -o \
     -type f \( -name '*.sh' -o -name '*.py' -o -name '*.js' -o -name '*.json' -o -name '*.env*' -o -name 'wotctl' \) \
     -exec sed -i 's/\r$//' {} +
chmod +x "$PROJECT_DIR/wotctl" "$PROJECT_DIR/install.sh" "$PROJECT_DIR"/devices/*.py "$PROJECT_DIR"/bench/*.py 2>/dev/null || true
ok "line endings normalised, scripts executable"

# --- 1. system packages -------------------------------------------------------
step "Installing system packages (apt)"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq mosquitto mosquitto-clients python3 python3-venv python3-pip \
      python3-psutil python3-matplotlib python3-numpy curl ca-certificates >/dev/null
for pkg in python3-gpiozero python3-lgpio; do       # Raspberry Pi specific; optional elsewhere
  $SUDO apt-get install -y -qq "$pkg" >/dev/null 2>&1 && ok "$pkg" || warn "$pkg not available (fine if this is not a Pi)"
done
ok "mosquitto, python3, psutil, matplotlib"

node_major() { command -v node >/dev/null 2>&1 && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [ "$(node_major)" -lt 18 ]; then
  $SUDO apt-get install -y -qq nodejs npm >/dev/null 2>&1 || true
fi
if [ "$(node_major)" -lt 18 ]; then
  warn "distribution Node.js is older than 18 - installing Node.js 20 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO -E bash - >/dev/null
  $SUDO apt-get install -y -qq nodejs >/dev/null
fi
command -v npm >/dev/null 2>&1 || $SUDO apt-get install -y -qq npm >/dev/null
ok "Node.js $(node -v), npm $(npm -v)"

# --- 2. MQTT broker -----------------------------------------------------------
step "Configuring Mosquitto (MQTT broker)"
$SUDO tee /etc/mosquitto/conf.d/wot-gateway.conf >/dev/null <<'EOF'
# WoT gateway lab setup - anonymous access on the isolated lab network only.
listener 1883
allow_anonymous true
EOF
$SUDO systemctl enable --now mosquitto >/dev/null 2>&1
$SUDO systemctl restart mosquitto
ok "mosquitto listening on :1883"

# --- 3. configuration ---------------------------------------------------------
step "Configuration"
if [ ! -f config/wot.env ]; then
  cp config/wot.env.example config/wot.env
  ok "created config/wot.env (edit it to change pins, threshold, ports)"
else
  ok "keeping existing config/wot.env"
fi
setcfg() { if grep -q "^$1=" config/wot.env; then sed -i "s|^$1=.*|$1=$2|" config/wot.env; else echo "$1=$2" >> config/wot.env; fi; }
[ "$ADAFRUIT" = 1 ] && setcfg DHT_BACKEND adafruit
cfg() { local v; v=$(grep -E "^$1=" config/wot.env | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*//' | xargs); echo "${v:-$2}"; }
DHT_GPIO=$(cfg DHT_GPIO 4)
chown -R "$RUN_USER:$RUN_GROUP" "$PROJECT_DIR"

# --- 4. Python environment ----------------------------------------------------
step "Python virtual environment (.venv)"
as_user python3 -m venv --system-site-packages .venv
as_user .venv/bin/pip install -q --upgrade pip >/dev/null
as_user .venv/bin/pip install -q -r devices/requirements.txt
if [ "$ADAFRUIT" = 1 ]; then
  $SUDO apt-get install -y -qq libgpiod2 >/dev/null 2>&1 || true
  as_user .venv/bin/pip install -q adafruit-circuitpython-dht
  ok "adafruit-circuitpython-dht installed"
fi
ok "aiohttp, aiocoap, paho-mqtt installed"

# --- 5. Node.js packages ------------------------------------------------------
step "Node.js packages (node-wot)"
if [ -f package-lock.json ]; then as_user npm ci --omit=dev --no-audit --no-fund --loglevel=error
else as_user npm install --omit=dev --no-audit --no-fund --loglevel=error; fi
ok "node-wot $(node -p 'require("./node_modules/@node-wot/core/package.json").version') installed"

# --- 6. GPIO / DHT22 ----------------------------------------------------------
step "GPIO and DHT22"
REBOOT=0
getent group gpio >/dev/null && $SUDO usermod -aG gpio "$RUN_USER" && ok "$RUN_USER is in group gpio"
CONFIG_TXT=""
for f in /boot/firmware/config.txt /boot/config.txt; do [ -f "$f" ] && { CONFIG_TXT=$f; break; }; done
if [ "$OVERLAY" = 1 ] && [ -n "$CONFIG_TXT" ]; then
  if grep -qE '^[[:space:]]*dtoverlay=dht11' "$CONFIG_TXT"; then
    ok "DHT kernel overlay already present: $(grep -E '^[[:space:]]*dtoverlay=dht11' "$CONFIG_TXT")"
  else
    echo "dtoverlay=dht11,gpiopin=${DHT_GPIO}   # WoT gateway: DHT22 via kernel IIO driver" | $SUDO tee -a "$CONFIG_TXT" >/dev/null
    REBOOT=1
    ok "added dtoverlay=dht11,gpiopin=${DHT_GPIO} to $CONFIG_TXT (reboot required)"
  fi
elif [ "$OVERLAY" = 1 ]; then
  warn "no /boot/firmware/config.txt found - not a Raspberry Pi? DHT22 will fall back to simulation."
fi

# --- 7. systemd services ------------------------------------------------------
step "Installing systemd services"
NODE_BIN="$(command -v node)"
PY_BIN="$PROJECT_DIR/.venv/bin/python"
unit() {  # name, description, exec, extra-after
  $SUDO tee "/etc/systemd/system/wot-$1.service" >/dev/null <<EOF
[Unit]
Description=WoT gateway - $2
After=network-online.target mosquitto.service $4
Wants=network-online.target
PartOf=wot.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
SupplementaryGroups=gpio
WorkingDirectory=$PROJECT_DIR
Environment=PYTHONUNBUFFERED=1
Environment=NODE_ENV=production
ExecStart=$3
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=10

[Install]
WantedBy=wot.target
EOF
}
getent group gpio >/dev/null || SUPPRESS_GPIO=1
unit directory "Thing Description Directory + dashboard" "$NODE_BIN src/directory/server.js" ""
unit sensor    "DHT22 temperature sensor (MQTT)"         "$PY_BIN devices/temperature_sensor.py" "wot-directory.service"
unit relay     "Fan relay actuator (CoAP / MQTT)"        "$PY_BIN devices/relay_actuator.py" "wot-directory.service"
unit plug      "Simulated smart plug (HTTP)"             "$PY_BIN devices/smart_plug.py" "wot-directory.service"
unit gateway   "node-wot gateway (HTTP + WebSocket)"     "$NODE_BIN src/gateway/gateway.js" "wot-directory.service"
unit app       "Climate-control application"             "$NODE_BIN src/app/app.js" "wot-gateway.service"
if [ "${SUPPRESS_GPIO:-0}" = 1 ]; then $SUDO sed -i '/^SupplementaryGroups=gpio$/d' /etc/systemd/system/wot-*.service; fi
$SUDO tee /etc/systemd/system/wot.target >/dev/null <<'EOF'
[Unit]
Description=WoT Smart-Building Gateway (all services)
Wants=wot-directory.service wot-sensor.service wot-relay.service wot-plug.service wot-gateway.service wot-app.service

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable wot.target wot-directory wot-sensor wot-relay wot-plug wot-gateway wot-app >/dev/null 2>&1
ok "services installed and enabled at boot (wot.target)"

# --- 8. start -----------------------------------------------------------------
HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}'); HOST_IP=${HOST_IP:-127.0.0.1}
if [ "$START" = 1 ]; then
  step "Starting services"
  $SUDO systemctl restart wot.target
  sleep 8
  "$PROJECT_DIR/wotctl" status || true
fi

cat <<EOF

=============================================================================
 Installation complete.

   Dashboard          http://$HOST_IP:$(cfg DIRECTORY_PORT 8090)/
   Gateway (HTTP)     http://$HOST_IP:$(cfg GATEWAY_HTTP_PORT 8080)/
   Thing Directory    http://$HOST_IP:$(cfg DIRECTORY_PORT 8090)/things

   ./wotctl status          service overview
   ./wotctl logs gateway    follow a service log
   ./wotctl evaluate        run ALL evaluation experiments -> results/REPORT.md
EOF
if [ "$REBOOT" = 1 ]; then
cat <<EOF

 >>> REBOOT REQUIRED to load the DHT22 kernel driver:   sudo reboot
     (until then the sensor runs in simulation mode; everything starts
      automatically after the reboot)
EOF
fi
echo "============================================================================="
