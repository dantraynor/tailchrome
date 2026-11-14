#!/usr/bin/env bash
set -euo pipefail

# Bounded browser Flatpak native-host smoke test for a native Linux CI runner.
# This deliberately tests the helper's framed protocol inside the sandbox, not
# the store extension, browser login, or browser routing. It never installs a
# Flatpak, adds filesystem overrides, or stops an app instance it did not start.
#
# Usage: scripts/test-flatpak.sh [chrome|firefox]   (default: chrome)
repo_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
browser=${1:-chrome}
case "$browser" in
chrome)
	app_id=com.google.Chrome
	browser_name=Chrome
	manifest_rel=config/google-chrome/NativeMessagingHosts/com.tailscale.browserext.chrome.json
	;;
firefox)
	app_id=org.mozilla.firefox
	browser_name=Firefox
	manifest_rel=.mozilla/native-messaging-hosts/com.tailscale.browserext.firefox.json
	;;
*)
	echo "ERROR: unknown browser '$browser'; use chrome or firefox" >&2
	exit 2
	;;
esac
app_dir="${HOME}/.var/app/${app_id}"
manifest_path="${app_dir}/${manifest_rel}"
host_path="${app_dir}/tailchrome/host/tailchrome"
receipt_path="${app_dir}/tailchrome/install.json"
log_path="${repo_dir}/.context/flatpak-smoke-${browser}.log"
tmp_dir=$(mktemp -d)
helper_path="${tmp_dir}/tailchrome"
install_completed=0
flatpak_started=0

cleanup() {
	status=$?
	if [[ "$flatpak_started" == 1 ]]; then
		if flatpak ps --columns=application | awk -v id="$app_id" '$0 == id { found=1 } END { exit found ? 0 : 1 }'; then
			if ! flatpak kill "$app_id" >>"$log_path" 2>&1; then
				if [[ "$status" == 0 ]]; then
					status=1
				fi
				echo "ERROR: Flatpak smoke could not stop the $browser_name instance it started; see $log_path" >&2
			else
				for _ in {1..40}; do
					if ! flatpak ps --columns=application | awk -v id="$app_id" '$0 == id { found=1 } END { exit found ? 0 : 1 }'; then
						break
					fi
					sleep 0.25
				done
				if flatpak ps --columns=application | awk -v id="$app_id" '$0 == id { found=1 } END { exit found ? 0 : 1 }'; then
					if [[ "$status" == 0 ]]; then
						status=1
					fi
					echo "ERROR: $browser_name Flatpak remained active after smoke cleanup; see $log_path" >&2
				fi
			fi
		fi
	fi
	if [[ "$install_completed" == 1 ]]; then
		if ! "$helper_path" uninstall "--${browser}-flatpak" >>"$log_path" 2>&1; then
			if [[ "$status" == 0 ]]; then
				status=1
			fi
			echo "ERROR: Flatpak smoke cleanup could not uninstall the helper; see $log_path" >&2
		fi
	fi
	rm -rf "$tmp_dir"
	exit "$status"
}
trap cleanup EXIT

require_command() {
	command -v "$1" >/dev/null 2>&1 || {
		echo "ERROR: required command not found: $1" >&2
		exit 1
	}
}

require_command flatpak
require_command go
require_command python3
flatpak_scope=()
if flatpak --user info "$app_id" >/dev/null 2>&1; then
	flatpak_scope=(--user)
elif flatpak --system info "$app_id" >/dev/null 2>&1; then
	flatpak_scope=(--system)
else
	echo "ERROR: Flatpak app $app_id is not installed for either the user or system scope" >&2
	exit 1
fi
[[ -d "$app_dir" ]] || {
	echo "ERROR: launch $app_id once so $app_dir exists" >&2
	exit 1
}
ps_output=$(flatpak ps --columns=application) || {
	echo "ERROR: cannot determine whether $app_id is active" >&2
	exit 1
}
if awk -v id="$app_id" '$0 == id { found=1 } END { exit found ? 0 : 1 }' <<<"$ps_output"; then
	echo "ERROR: close $browser_name Flatpak before running this smoke test" >&2
	exit 1
fi
for path in "$manifest_path" "$host_path" "$receipt_path"; do
	if [[ -e "$path" || -L "$path" ]]; then
		echo "ERROR: refusing to overwrite pre-existing Tailchrome Flatpak artifact: $path" >&2
		exit 1
	fi
done

mkdir -p "$(dirname "$log_path")"
: >"$log_path"
(cd "$repo_dir/host" && go build -trimpath -o "$helper_path" .) >>"$log_path" 2>&1
"$helper_path" install "--${browser}-flatpak" >>"$log_path" 2>&1
install_completed=1

[[ -x "$host_path" ]] || { echo "ERROR: staged helper is missing or not executable; see $log_path" >&2; exit 1; }
[[ -f "$manifest_path" ]] || { echo "ERROR: Flatpak native-messaging manifest is missing; see $log_path" >&2; exit 1; }

export TAILCHROME_SMOKE_APP_ID="$app_id"
export TAILCHROME_SMOKE_HELPER="$host_path"
export TAILCHROME_SMOKE_LOG="$log_path"
export TAILCHROME_SMOKE_FLATPAK_SCOPE="${flatpak_scope[0]}"
flatpak_started=1
python3 - <<'PY'
import json
import os
import select
import signal
import struct
import subprocess
import time

app_id = os.environ["TAILCHROME_SMOKE_APP_ID"]
helper = os.environ["TAILCHROME_SMOKE_HELPER"]
log_path = os.environ["TAILCHROME_SMOKE_LOG"]
scope = os.environ["TAILCHROME_SMOKE_FLATPAK_SCOPE"]
command = ["flatpak", scope, "run", "--command=" + helper, app_id]
deadline_seconds = 15.0

def read_frame(stream, deadline):
    fd = stream.fileno()
    def read_exact(size):
        data = bytearray()
        while len(data) < size:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
                raise TimeoutError("timed out waiting for native-host frame")
            chunk = os.read(fd, size - len(data))
            if not chunk:
                raise RuntimeError("native host exited before completing a frame")
            data.extend(chunk)
        return bytes(data)
    length = struct.unpack("<I", read_exact(4))[0]
    if length == 0 or length > 1024 * 1024:
        raise RuntimeError(f"invalid native-host frame length {length}")
    return json.loads(read_exact(length))

proc = None
try:
    with open(log_path, "ab", buffering=0) as log:
        proc = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=log, start_new_session=True)
        deadline = time.monotonic() + deadline_seconds
        first = read_frame(proc.stdout, deadline)
        if not isinstance(first, dict) or "procRunning" not in first:
            raise RuntimeError(f"expected procRunning frame, got {first!r}")
        running = first["procRunning"]
        if not isinstance(running, dict) or not isinstance(running.get("port"), int) or running["port"] <= 0:
            raise RuntimeError(f"invalid procRunning payload: {running!r}")
        payload = json.dumps({"cmd": "ping"}, separators=(",", ":")).encode()
        proc.stdin.write(struct.pack("<I", len(payload)) + payload)
        proc.stdin.flush()
        reply = read_frame(proc.stdout, deadline)
        if not isinstance(reply, dict) or "pong" not in reply:
            raise RuntimeError(f"expected pong frame, got {reply!r}")
finally:
    if proc is not None:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            proc.wait(timeout=3)
PY

echo "$browser_name Flatpak native-host procRunning/pong smoke passed; store extension, login, and routing remain untested."
