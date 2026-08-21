#!/usr/bin/env bash
# Stop one instance or every instance started from this folder.
#   bash stop.sh
#   bash stop.sh --all
#   bash stop.sh 8082
#   bash stop.sh --list
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
RUN="$ROOT/run"
mkdir -p "$RUN"

list_instances() {
  local found=0
  shopt -s nullglob
  for f in "$RUN"/*.pid; do
    local port pid
    port="$(basename "$f" .pid)"
    pid="$(cat "$f" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "port=$port pid=$pid"
      found=1
    else
      rm -f "$f"
    fi
  done
  if [[ "$found" -eq 0 ]]; then
    echo "no running instances"
  fi
}

stop_one() {
  local port="$1"
  local f="$RUN/${port}.pid"
  if [[ ! -f "$f" ]]; then
    echo "no instance on :$port"
    return 0
  fi
  local pid
  pid="$(cat "$f" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 0.4
    kill -9 "$pid" 2>/dev/null || true
    echo "stopped port=$port pid=$pid"
  else
    echo "stale pid file for :$port"
  fi
  rm -f "$f"
}

valid_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

if [[ $# -eq 0 || "${1:-}" == "--all" ]]; then
  shopt -s nullglob
  files=("$RUN"/*.pid)
  if [[ ${#files[@]} -eq 0 ]]; then
    echo "no running instances"
    exit 0
  fi
  for f in "${files[@]}"; do
    stop_one "$(basename "$f" .pid)"
  done
  exit 0
fi

case "$1" in
  --list|-l) list_instances ;;
  --help|-h)
    echo "usage: bash stop.sh [port] | --all | --list"
    ;;
  *)
    if ! valid_port "$1"; then
      echo "invalid port: $1" >&2
      exit 2
    fi
    stop_one "$1"
    ;;
esac
