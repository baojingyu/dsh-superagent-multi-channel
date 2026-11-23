#!/bin/sh
# Start the iLink Bot (WeChat "ClawBot") sidecar on a POSIX host - macOS and Linux.
#
# This is the same launcher as start-weixin-ilink.cmd, for the platforms the iLink backend actually runs on: the sidecar is
# plain Node with no third-party dependency, so nothing about it needs Windows. The plugin starts this script through
# `/bin/sh` (an executable bit is not guaranteed on a file unpacked from a tarball) and hands it three environment variables:
#
#   WXBRIDGE_PORT        Port to bind. "0" asks the OS for a free one; empty means the default 9300.
#   WXBRIDGE_PORT_FILE   File to write the port actually bound to, so the panel can read a random port back.
#   WXBRIDGE_TOKEN_FILE  Bearer-token file. The plugin creates it 0600 before starting this script.
#
# Two facts must hold before the bridge is usable, and the script says which one is missing instead of failing silently:
#   1. An iLink credential exists - `node server.mjs login` was run once and the QR was scanned.
#   2. The token file exists and is readable only by this account.
#
# Everything the sidecar prints goes to ilink-bridge.log next to this file.
set -eu

# Resolve this script's own directory, following symlinks, so the log and the default paths sit beside the real file.
SELF=$0
while [ -L "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case $LINK in
    /*) SELF=$LINK ;;
    *) SELF=$(dirname "$SELF")/$LINK ;;
  esac
done
HERE=$(cd "$(dirname "$SELF")" && pwd)

NODE=${NODE:-node}
SERVER=$HERE/weixin-ilink-bridge/server.mjs
LOG=$HERE/ilink-bridge.log

PORT=${WXBRIDGE_PORT:-9300}
[ -n "$PORT" ] || PORT=9300

# The plugin passes its own path; the fallback keeps a hand-run script working, in the plugin's state directory layout.
TOKEN_FILE=${WXBRIDGE_TOKEN_FILE:-${XDG_STATE_HOME:-$HOME/.dsh/state}/dsh-superagent-multi-channel/secrets/weixin-personal-bridge.token}
AUTH_FILE=${ILINK_BRIDGE_AUTH_FILE:-$HERE/weixin-ilink-bridge/data/weixin-ilink-auth.json}

log() { printf '[ilink-bridge] %s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG"; }

if [ ! -f "$SERVER" ]; then
  log "server not found: $SERVER"
  echo "[ilink-bridge] server not found: $SERVER" >&2
  exit 1
fi
if ! command -v "$NODE" >/dev/null 2>&1; then
  log "node not found on PATH; install Node 18+ or set NODE=/path/to/node"
  echo "[ilink-bridge] node not found on PATH; install Node 18+ or set NODE=/path/to/node" >&2
  exit 1
fi
if [ ! -f "$TOKEN_FILE" ]; then
  # The plugin writes this file before starting the script; reaching here means it was run by hand without one.
  log "token file not found: $TOKEN_FILE"
  echo "[ilink-bridge] token file not found: $TOKEN_FILE" >&2
  echo "[ilink-bridge] create it with a random string and restrict it: umask 077; openssl rand -base64 32 >\"$TOKEN_FILE\"" >&2
  exit 1
fi
if [ ! -f "$AUTH_FILE" ]; then
  log "credential file not found: $AUTH_FILE"
  echo "[ilink-bridge] credential file not found: $AUTH_FILE" >&2
  echo "[ilink-bridge] run first: \"$NODE\" \"$SERVER\" login --auth-file \"$AUTH_FILE\"" >&2
  exit 1
fi

log "starting iLink backend on http://127.0.0.1:$PORT (token file: $TOKEN_FILE)"
# The token reaches the sidecar as a path, never as a value: it is read from the file by the sidecar itself, so it never
# appears in a process listing, a shell history, or this log.
exec "$NODE" "$SERVER" run --port "$PORT" --host 127.0.0.1 --token-file "$TOKEN_FILE" --auth-file "$AUTH_FILE" >>"$LOG" 2>&1
