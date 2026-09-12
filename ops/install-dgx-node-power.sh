#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WOL_INTERFACE="${WOL_INTERFACE:-enP7s7}"
POWER_USER="${SPARK_POWER_USER:-${SUDO_USER:-}}"

[[ "$(id -u)" -eq 0 ]] || {
  printf 'install-dgx-node-power: run with sudo\n' >&2
  exit 1
}

install -m 0755 "$SCRIPT_DIR/spark-shutdown" /usr/local/bin/spark-shutdown
/usr/local/bin/spark-shutdown --check >/dev/null

[[ "$POWER_USER" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || {
  printf 'install-dgx-node-power: set SPARK_POWER_USER to the SSH account\n' >&2
  exit 1
}
id "$POWER_USER" >/dev/null 2>&1 || {
  printf 'install-dgx-node-power: user does not exist: %s\n' "$POWER_USER" >&2
  exit 1
}
sudoers_temp="$(mktemp)"
trap 'rm -f "$sudoers_temp"' EXIT
printf '%s ALL=(root) NOPASSWD: /usr/local/bin/spark-shutdown *\n' "$POWER_USER" > "$sudoers_temp"
chmod 0440 "$sudoers_temp"
visudo -cf "$sudoers_temp" >/dev/null
install -m 0440 "$sudoers_temp" /etc/sudoers.d/sparkdash-power
trap - EXIT

connection="$(nmcli -g GENERAL.CONNECTION device show "$WOL_INTERFACE")"
[[ -n "$connection" && "$connection" != "--" ]] || {
  printf 'install-dgx-node-power: no active NetworkManager connection on %s\n' "$WOL_INTERFACE" >&2
  exit 1
}
nmcli connection modify "$connection" 802-3-ethernet.wake-on-lan magic
nmcli device reapply "$WOL_INTERFACE" >/dev/null

wol="$(ethtool "$WOL_INTERFACE" | awk '/^[[:space:]]*Wake-on:/ {print $2}')"
[[ "$wol" == "g" ]] || {
  printf 'install-dgx-node-power: Wake-on-LAN read-back is %s, expected g\n' "$wol" >&2
  exit 1
}
printf 'installed shutdown helper for %s; %s Wake-on-LAN=magic\n' "$POWER_USER" "$WOL_INTERFACE"
