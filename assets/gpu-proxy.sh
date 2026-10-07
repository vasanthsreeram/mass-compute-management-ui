#!/bin/sh
# gpu-proxy — lets an AI agent use your GPU desk without ever seeing an API key.
#
#   gpu-proxy login               open the browser, approve, token is stored locally (0600)
#   gpu-proxy status              show who you are connected as
#   gpu-proxy api GET /api/me     call the proxy; the token is attached for you
#   gpu-proxy api POST /api/instances '{"productName":"gpu_1x_a6000"}'
#   gpu-proxy logout              forget the token
#
# The token is only ever written to the file below. It is never printed.

DEFAULT_URL="__GPU_PROXY_URL__"
DIR="${XDG_CONFIG_HOME:-$HOME/.config}/gpu-proxy"
URL_FILE="$DIR/url"
TOKEN_FILE="$DIR/token"

url() {
  if [ -n "$GPU_PROXY_URL" ]; then printf '%s' "$GPU_PROXY_URL"
  elif [ -f "$URL_FILE" ]; then cat "$URL_FILE"
  else printf '%s' "$DEFAULT_URL"; fi
}

jget() { sed -n 's/.*"'"$1"'":"\([^"]*\)".*/\1/p' | head -n1; }

open_browser() {
  if command -v open >/dev/null 2>&1; then open "$1" >/dev/null 2>&1 && return 0; fi
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 && return 0; fi
  return 1
}

cmd_login() {
  base=$(url)
  name=$(hostname 2>/dev/null || echo agent)
  resp=$(curl -fsS -X POST "$base/api/cli/start" -H 'Content-Type: application/json' \
    -d "{\"name\":\"$name\"}") || { echo "Could not reach $base" >&2; exit 1; }
  device=$(printf '%s' "$resp" | jget device_code)
  code=$(printf '%s' "$resp" | jget user_code)
  link=$(printf '%s' "$resp" | jget verify_url)
  [ -n "$device" ] || { echo "Unexpected response from $base" >&2; exit 1; }

  echo "Approve this agent in your browser:"
  echo "  $link"
  echo "Confirmation code: $code"
  open_browser "$link" || echo "(Could not open a browser here — open the link on your own machine.)"
  echo "Waiting for approval…"

  i=0
  while [ "$i" -lt 200 ]; do
    sleep 3
    i=$((i + 1))
    out=$(curl -fsS -X POST "$base/api/cli/poll" -H 'Content-Type: application/json' \
      -d "{\"device_code\":\"$device\"}") || continue
    case "$(printf '%s' "$out" | jget status)" in
      approved)
        token=$(printf '%s' "$out" | jget token)
        mkdir -p "$DIR" && chmod 700 "$DIR"
        ( umask 077; printf '%s' "$token" > "$TOKEN_FILE"; printf '%s' "$base" > "$URL_FILE" )
        echo "Connected as $(printf '%s' "$out" | jget email). Token expires $(printf '%s' "$out" | jget expires_at)."
        return 0 ;;
      denied) echo "Denied in the browser." >&2; exit 1 ;;
      expired) echo "Code expired. Run login again." >&2; exit 1 ;;
    esac
  done
  echo "Timed out waiting for approval." >&2
  exit 1
}

cmd_api() {
  [ -f "$TOKEN_FILE" ] || { echo "Not connected. Run: gpu-proxy login" >&2; exit 2; }
  method=${1:?method}; path=${2:?path}; body=$3
  if [ -n "$body" ]; then
    set -- -H 'Content-Type: application/json' --data "$body"
  else
    set --
  fi
  tmp=$(mktemp)
  status=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$(url)$path" \
    -H "Authorization: Bearer $(cat "$TOKEN_FILE")" "$@")
  cat "$tmp"; echo
  rm -f "$tmp"
  if [ "$status" = "401" ]; then echo "Token missing or expired. Run: gpu-proxy login" >&2; exit 2; fi
  [ "$status" -lt 400 ] || exit 1
}

case "$1" in
  login) cmd_login ;;
  status) cmd_api GET /api/me ;;
  api) shift; cmd_api "$@" ;;
  logout) rm -f "$TOKEN_FILE"; echo "Disconnected." ;;
  *) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
