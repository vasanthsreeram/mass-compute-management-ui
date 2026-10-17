#!/bin/sh
# gpu-proxy-agent — runs on a rented VM and keeps the member's workspace in the desk's R2 backups (restic).
#
#   gpu-proxy-agent enroll <token>     one-time setup, run by the launch command (needs root or sudo)
#   gpu-proxy save [--tag task-end]    back up the workspace now
#   gpu-proxy restore [snapshot]       restore the latest (or a given) snapshot into the work dir
#   gpu-proxy-agent run                the service loop (systemd starts it)
#   gpu-proxy-agent shutdown-backup    last incremental backup at shutdown (best effort)
#
# The enrollment token is single-use and expires in 10 minutes. The VM only ever holds a credential bound
# to this machine; it stops working when the VM is terminated. Nothing here is printed or logged.

set -f   # no globbing: the exclude patterns below are passed to restic as-is
DESK="__GPU_PROXY_URL__"
CONF_DIR=/etc/gpu-proxy
CONF="$CONF_DIR/agent.env"
BIN=/usr/local/bin/gpu-proxy-agent
STATE=/var/lib/gpu-proxy
LOG=/var/log/gpu-proxy-agent.log
RESTIC_VERSION=0.17.3
EXCLUDES="--exclude .cache --exclude .venv --exclude venv --exclude node_modules --exclude __pycache__ --exclude *.pyc"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" >> "$LOG" 2>/dev/null; printf '%s\n' "$*" >&2; }
jstr() { sed -n 's/.*"'"$1"'":"\([^"]*\)".*/\1/p' | head -n1; }
jnum() { sed -n 's/.*"'"$1"'":\([0-9][0-9]*\).*/\1/p' | head -n1; }
need_root() {
  [ "$(id -u)" = 0 ] && return 0
  command -v sudo >/dev/null 2>&1 || { echo "Run as root (or install sudo)." >&2; exit 1; }
  return 1
}
load() {
  [ -r "$CONF" ] || { echo "Not enrolled on this machine (no $CONF)." >&2; exit 2; }
  # shellcheck disable=SC1090
  . "$CONF"
  export RESTIC_REPOSITORY RESTIC_PASSWORD
}

install_restic() {
  command -v restic >/dev/null 2>&1 && return 0
  arch=$(uname -m); case "$arch" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; esac
  tmp=$(mktemp)
  if curl -fsSL "https://github.com/restic/restic/releases/download/v$RESTIC_VERSION/restic_${RESTIC_VERSION}_linux_${arch}.bz2" -o "$tmp" \
     && bunzip2 -c "$tmp" > /usr/local/bin/restic 2>/dev/null; then
    chmod 755 /usr/local/bin/restic
  elif command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq restic >/dev/null 2>&1
  fi
  rm -f "$tmp"
  command -v restic >/dev/null 2>&1 || { echo "Could not install restic." >&2; exit 1; }
}

# ---- backup / restore ------------------------------------------------------------------------------------------

post() { # post <path> <json>
  curl -fsS -m 30 -X POST "$DESK$1" -H "Authorization: Bearer $CRED" -H 'Content-Type: application/json' --data "$2"
}

do_backup() { # do_backup <tag>   -> reports to the desk, prints the snapshot id
  tag=${1:-periodic}
  mkdir -p "$STATE" 2>/dev/null
  lock="$STATE/backup.lock"
  i=0
  while ! mkdir "$lock" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -gt 60 ] && { rmdir "$lock" 2>/dev/null; return 1; }
    sleep 2
  done
  out=$(restic backup --host "$HOST_TAG" --pack-size 32 --exclude-caches $EXCLUDES --tag "$tag" --json "$WORK_DIR" 2>>"$LOG")
  rc=$?
  rmdir "$lock" 2>/dev/null
  summary=$(printf '%s\n' "$out" | grep '"message_type":"summary"' | tail -n1)
  snap=$(printf '%s' "$summary" | jstr snapshot_id)
  [ $rc -eq 0 ] && [ -n "$snap" ] || { log "backup ($tag) failed rc=$rc"; return 1; }
  added=$(printf '%s' "$summary" | jnum data_added); total=$(printf '%s' "$summary" | jnum total_bytes_processed)
  post /api/agent/backup "{\"snapshot_id\":\"$snap\",\"bytes_added\":${added:-0},\"total_bytes\":${total:-0},\"tag\":\"$tag\"}" >/dev/null 2>&1 \
    || log "could not report snapshot $snap"
  printf '%s' "$snap" > "$STATE/last_snapshot"
  printf '%s' "${total:-0}" > "$STATE/last_bytes"
  printf '%s' "$snap"
}

cmd_save() {
  tag=manual
  while [ $# -gt 0 ]; do case "$1" in --tag) tag=$2; shift ;; esac; shift; done
  load
  snap=$(do_backup "$tag") && echo "Backed up ($tag): snapshot $snap" || { echo "Backup failed. See $LOG" >&2; exit 1; }
}

restore_into() { # restore_into <snapshot|latest>
  snap=${1:-latest}
  restic snapshots --host "$HOST_TAG" --json 2>/dev/null | grep -q '"id"' || { echo "No snapshots yet; nothing to restore."; return 0; }
  old=$(restic snapshots "$snap" --host "$HOST_TAG" --json 2>/dev/null | sed -n 's/.*"paths":\["\([^"]*\)".*/\1/p' | tail -n1)
  mkdir -p "$WORK_DIR"
  if [ "$old" = "$WORK_DIR" ] || [ -z "$old" ]; then
    restic restore "$snap" --host "$HOST_TAG" --target / --include "$WORK_DIR" >/dev/null 2>>"$LOG"
  else
    # Home directory differs from the machine that made the snapshot: restore aside, then move in.
    tmp="$WORK_DIR.restore.$$"; mkdir -p "$tmp"
    restic restore "$snap" --host "$HOST_TAG" --target "$tmp" --include "$old" >/dev/null 2>>"$LOG" \
      && cp -a "$tmp$old/." "$WORK_DIR/"
    rm -rf "$tmp"
  fi
  [ -n "$WORK_OWNER" ] && chown -R "$WORK_OWNER" "$WORK_DIR" 2>/dev/null
  echo "Restored $snap into $WORK_DIR"
}

cmd_restore() { load; restore_into "${1:-latest}"; }

# ---- enroll ------------------------------------------------------------------------------------------------------

cmd_enroll() {
  token=${1:?usage: enroll <token>}
  # Piped from curl there is no script file to re-run, so fetch it again under sudo.
  if ! need_root; then exec sudo -E sh -c "curl -fsSL '$DESK/gpu-proxy-agent.sh' | sh -s -- enroll '$token'"; fi
  mkdir -p "$CONF_DIR" "$STATE"; touch "$LOG"; chmod 600 "$LOG"
  resp=$(curl -fsS -m 30 -X POST "$DESK/api/agent/enroll" -H 'Content-Type: application/json' \
    --data "{\"token\":\"$token\",\"hostname\":\"$(hostname 2>/dev/null)\"}") || { log "enroll failed (token used or expired?)"; exit 1; }
  repo=$(printf '%s' "$resp" | jstr repository); pw=$(printf '%s' "$resp" | jstr password)
  cred=$(printf '%s' "$resp" | jstr credential); work=$(printf '%s' "$resp" | jstr work_dir)
  hb=$(printf '%s' "$resp" | jnum heartbeat_seconds); every=$(printf '%s' "$resp" | jnum backup_seconds)
  tagname=$(printf '%s' "$resp" | jstr host_tag)
  [ -n "$repo" ] && [ -n "$pw" ] && [ -n "$cred" ] || { log "unexpected enroll response"; exit 1; }

  # The work dir belongs to the login user, not root: SUDO_USER, else the first real home directory.
  owner=${SUDO_USER:-$(ls /home 2>/dev/null | head -n1)}
  home=$(getent passwd "${owner:-root}" 2>/dev/null | cut -d: -f6); [ -n "$home" ] || home=${HOME:-/root}
  work=$(printf '%s' "${work:-~/work}" | sed "s#^~#$home#")
  install_restic

  ( umask 077
    cat > "$CONF" <<EOF
DESK='$DESK'
CRED='$cred'
RESTIC_REPOSITORY='$repo'
RESTIC_PASSWORD='$pw'
WORK_DIR='$work'
WORK_OWNER='${owner:-}'
HOST_TAG='${tagname:-workspace}'
HEARTBEAT=${hb:-45}
BACKUP_EVERY=${every:-300}
EOF
  )
  [ -n "$owner" ] && chown "$owner" "$CONF"   # the member can run `gpu-proxy save` without sudo

  curl -fsSL "$DESK/gpu-proxy-agent.sh" -o "$BIN" && chmod 755 "$BIN"
  [ -e /usr/local/bin/gpu-proxy ] || ln -s "$BIN" /usr/local/bin/gpu-proxy
  load
  restic cat config >/dev/null 2>&1 || restic init >/dev/null 2>>"$LOG" || { log "restic init failed"; exit 1; }
  restore_into latest

  if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
    cat > /etc/systemd/system/gpu-proxy-agent.service <<EOF
[Unit]
Description=gpu-proxy backup agent
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=$BIN run
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
EOF
    cat > /etc/systemd/system/gpu-proxy-shutdown.service <<EOF
[Unit]
Description=gpu-proxy final backup at shutdown
After=network-online.target gpu-proxy-agent.service
Wants=network-online.target
[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/true
ExecStop=$BIN shutdown-backup
TimeoutStopSec=110
[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload && systemctl enable --now gpu-proxy-agent.service gpu-proxy-shutdown.service >/dev/null 2>&1
  else
    nohup "$BIN" run >/dev/null 2>&1 &
  fi
  log "enrolled; backing up $work every ${every:-300}s"
  echo "gpu-proxy backups are on: $work is restored and will be backed up."
}

# ---- service -----------------------------------------------------------------------------------------------------

heartbeat_loop() {
  while :; do
    bytes=$(cat "$STATE/last_bytes" 2>/dev/null || echo 0); snap=$(cat "$STATE/last_snapshot" 2>/dev/null)
    r=$(post /api/agent/heartbeat "{\"bytes\":${bytes:-0},\"last_snapshot\":\"$snap\"}" 2>/dev/null)
    case "$r" in *'"final_backup":true'*) touch "$STATE/final" ;; esac
    case "$r" in *'"backup_now":true'*) touch "$STATE/now" ;; esac
    sleep "${HEARTBEAT:-45}"
  done
}

cmd_run() {
  load; mkdir -p "$STATE" "$WORK_DIR"
  rm -f "$STATE/final" "$STATE/now"
  heartbeat_loop &
  hb=$!
  trap 'kill $hb 2>/dev/null; exit 0' TERM INT
  last=$(date +%s); forgot=$last
  while :; do
    sleep 5
    now=$(date +%s)
    if [ -e "$STATE/final" ]; then
      rm -f "$STATE/final" "$STATE/now"
      snap=$(do_backup final) && post /api/agent/final-done "{\"snapshot_id\":\"$snap\"}" >/dev/null 2>&1
      last=$now
    elif [ -e "$STATE/now" ]; then
      rm -f "$STATE/now"; do_backup on-demand >/dev/null; last=$now
    elif [ $((now - last)) -ge "${BACKUP_EVERY:-300}" ]; then
      do_backup periodic >/dev/null; last=$(date +%s)
      # Keep the repo (and the member's quota) from growing forever: daily, newest 30 snapshots.
      if [ $((last - forgot)) -ge 86400 ]; then restic forget --host "$HOST_TAG" --keep-last 30 --prune >/dev/null 2>>"$LOG"; forgot=$last; fi
    fi
  done
}

cmd_shutdown_backup() {
  load
  # Best effort: systemd gives this unit about 110 s.
  if command -v timeout >/dev/null 2>&1; then timeout 100 "$BIN" save --tag shutdown; else "$BIN" save --tag shutdown; fi
  exit 0
}

case "$1" in
  enroll) shift; cmd_enroll "$@" ;;
  save|backup) shift; cmd_save "$@" ;;
  restore) shift; cmd_restore "$@" ;;
  run) cmd_run ;;
  shutdown-backup) cmd_shutdown_backup ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
