#!/usr/bin/env bash
# Start one instance. Same folder can run many instances on different ports.
#   bash start.sh
#   bash start.sh 8082
#   bash start.sh --port 9000
#   ZCODE_PROXY_PORT=9001 bash start.sh
#   bash start.sh --list
#   bash start.sh --isolated 8083    # own credential dir
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"
RUN="$ROOT/run"
mkdir -p "$RUN"

usage() {
  cat <<EOF
usage:
  bash start.sh [port]
  bash start.sh --port <port>
  bash start.sh --isolated [port]
  bash start.sh --list
  bash stop.sh [port] | --all | --list

env:
  ZCODE_PROXY_PORT          listen port (overrides config.yaml)
  ZCODE_CAPTCHA_CDP_PORT    captcha browser debug port (default 10000+listen)
  ZCODE_PROXY_STORE_DIR     credential dir (default $ROOT/.credentials)
  ZCODE_PROXY_API_KEY       proxy client key for this instance
EOF
}

yaml_port() {
  awk '
    /^[[:space:]]*port:[[:space:]]*/ {
      gsub(/[^0-9]/, "", $2)
      if ($2 != "") { print $2; exit }
    }
  ' "$ROOT/config.yaml" 2>/dev/null || true
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

port_listening() {
  local p="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -E ":${p}([[:space:]]|$)" >/dev/null
    return $?
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1
    return $?
  fi
  return 1
}

list_instances() {
  local found=0
  shopt -s nullglob
  for f in "$RUN"/*.pid; do
    local port
    port="$(basename "$f" .pid)"
    local pid
    pid="$(cat "$f" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "port=$port pid=$pid webui=http://127.0.0.1:${port}/webui openai=http://127.0.0.1:${port}/v1"
      found=1
    else
      rm -f "$f"
    fi
  done
  if [[ "$found" -eq 0 ]]; then
    echo "no running instances"
  fi
}

PORT="${ZCODE_PROXY_PORT:-}"
ISOLATED=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --list|-l) list_instances; exit 0 ;;
    --isolated) ISOLATED=1; shift ;;
    --port|-p)
      PORT="${2:-}"
      if [[ -z "$PORT" ]]; then
        echo "--port needs a number" >&2
        exit 2
      fi
      shift 2
      ;;
    --port=*|-p=*)
      PORT="${1#*=}"
      shift
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
    *)
      if [[ -z "$PORT" ]] && valid_port "$1"; then
        PORT="$1"
        shift
      else
        echo "unexpected argument: $1" >&2
        usage >&2
        exit 2
      fi
      ;;
  esac
done

if [[ -z "$PORT" ]]; then
  PORT="$(yaml_port)"
fi
if [[ -z "$PORT" ]]; then
  PORT=10100
fi
if ! valid_port "$PORT"; then
  echo "invalid port: $PORT" >&2
  exit 2
fi

BIN=""
for candidate in zcode-proxy-login zcode-proxy-login-linux-x64 zcode-proxy-login-linux-arm64; do
  if [[ -f "$ROOT/$candidate" ]]; then
    BIN="$ROOT/$candidate"
    break
  fi
done
if [[ -z "$BIN" ]]; then
  echo "missing zcode-proxy-login binary" >&2
  exit 1
fi
chmod +x "$BIN" || true

PIDFILE="$RUN/${PORT}.pid"
if [[ -f "$PIDFILE" ]]; then
  old="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "$old" ]] && kill -0 "$old" 2>/dev/null; then
    echo "already running on :$PORT pid=$old  http://127.0.0.1:${PORT}/webui"
    exit 0
  fi
  rm -f "$PIDFILE"
fi

if port_listening "$PORT"; then
  echo "port $PORT is already in use" >&2
  exit 1
fi

export ZCODE_PROXY_PORT="$PORT"
if [[ -z "${ZCODE_CAPTCHA_CDP_PORT:-}" ]]; then
  cdp=$((10000 + PORT))
  if [[ "$cdp" -gt 65535 ]]; then
    cdp=$((20000 + PORT % 40000))
  fi
  export ZCODE_CAPTCHA_CDP_PORT="$cdp"
fi
if [[ "$ISOLATED" -eq 1 ]]; then
  export ZCODE_PROXY_STORE_DIR="${ZCODE_PROXY_STORE_DIR:-$ROOT/.credentials-$PORT}"
else
  export ZCODE_PROXY_STORE_DIR="${ZCODE_PROXY_STORE_DIR:-$ROOT/.credentials}"
fi

nohup "$BIN" serve "$ROOT/config.yaml" >>"$RUN/${PORT}.log" 2>&1 &
echo $! > "$PIDFILE"
echo "started pid=$! port=$PORT cdp=$ZCODE_CAPTCHA_CDP_PORT store=$ZCODE_PROXY_STORE_DIR"
echo "ui     http://127.0.0.1:${PORT}/"
echo "webui  http://127.0.0.1:${PORT}/webui"
echo "openai http://127.0.0.1:${PORT}/v1"
echo "stop   bash stop.sh $PORT"
