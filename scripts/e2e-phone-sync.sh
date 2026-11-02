#!/bin/bash
# Phone ↔ desktop sync, for real: the Rust server (an ignored test) and the
# phone's TypeScript client + uploader (mobile/src/lib/e2e.test.ts) pair with a
# v1.2 QR (one-time token, X25519) and talk over
# localhost with real envelopes. Usage: scripts/e2e-phone-sync.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(mktemp -d "${TMPDIR:-/tmp}/hivo-e2e-XXXX")"
export HIVO_E2E_DIR="$DIR" HIVO_E2E_PORT="${HIVO_E2E_PORT:-48123}"
cargo test -q --manifest-path src-tauri/Cargo.toml e2e_server_for_the_phone_client -- --ignored > "$DIR/server.log" 2>&1 &
SERVER=$!
# Whatever happens (a failing client test included), stop the server and
# clean up: a leftover one would hold the port for the next run.
cleanup() {
  touch "$DIR/stop"
  kill "$SERVER" 2>/dev/null || true
  wait "$SERVER" 2>/dev/null || true
  rm -rf "$DIR"
}
trap cleanup EXIT
(cd mobile && npx vitest run src/lib/e2e.test.ts)
wait "$SERVER"
echo "server: ok"
