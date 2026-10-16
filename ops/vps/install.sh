#!/bin/bash
# Install Datasetto on a plain VPS (OVH, Hetzner, any KVM box with a public IPv4)
# running Debian 13 (the tested primary target), Debian 12, Ubuntu 24.04 or 26.04.
# Run as root. Idempotent: re-run it any time to update the checkout, the
# configuration, the firewall and the containers.
#
#   install.sh --env /root/datasetto.env --ref productionize-rewrite
#
# Options
#   --env FILE          prepared ops/.env (copy of ops/.env.example, filled in); copied to
#                       /opt/datasetto/ops/.env with mode 600. May be omitted on re-runs.
#   --ref REF           git branch, tag or commit to deploy (default: main)
#   --repo URL          repository to clone (default: https://github.com/FilippoLeone/datasetto.git)
#   --dir PATH          checkout location (default: /opt/datasetto)
#   --ssh-port N        SSH port to keep open; detected from sshd when omitted
#   --egress-guard      install the monthly egress guard (ops/common/egress-guard.sh);
#                       only useful on hosts that meter outgoing traffic
#   --no-egress-guard   remove the egress guard installed by an earlier run
#   --no-firewall       leave ufw alone (you manage the firewall yourself)
#   --no-backup         do not install the daily SQLite backup timer
#   -h, --help          this text
#
# What it does, skipping anything already in place:
#   1. 2 GB swap file when the machine has less than 3 GB RAM and no swap
#      (skipped on a 4 GB plan such as OVH VPS-1)
#   2. packages: ca-certificates curl git ufw unattended-upgrades (rclone when
#      BACKUP_RCLONE_REMOTE is set in the env file)
#   3. Docker Engine and the compose plugin from get.docker.com
#   4. clone or update the repository and check out --ref
#   5. copy --env to ops/.env (mode 600, CRLF stripped) and sanity-check it
#   6. firewall: rate-limited SSH, 80, 443 tcp+udp, 1935, 1936, and the TURN ports
#      only when COMPOSE_PROFILES contains "turn"; everything else denied
#   7. docker compose pull (or build); a VAPID key pair for Web Push notifications
#      is generated into ops/.env with the app image when PUSH_VAPID_* is empty;
#      up -d; systemd unit datasetto.service so the stack starts on boot
#   8. daily SQLite backup (ops/vps/backup.sh) from a systemd timer; 14 copies
#      kept in /var/backups/datasetto, optional upload to an rclone remote
#   9. the egress guard, only with --egress-guard
#
# Log: /var/log/datasetto-install.log
set -euo pipefail

APP_DIR=/opt/datasetto
REPO=https://github.com/FilippoLeone/datasetto.git
REPO_GIVEN=0
REF=main
ENV_FILE=""
SSH_PORT=""
FIREWALL=1
BACKUP=1
EGRESS_GUARD=""   # "" leave as is, 1 install, 0 remove
LOG=/var/log/datasetto-install.log

usage() { sed -n '2,/^set -euo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

while (( $# )); do
  case "$1" in
    --env) ENV_FILE="${2:?--env needs a file}"; shift 2 ;;
    --env=*) ENV_FILE="${1#*=}"; shift ;;
    --ref) REF="${2:?--ref needs a value}"; shift 2 ;;
    --ref=*) REF="${1#*=}"; shift ;;
    --repo) REPO="${2:?--repo needs a URL}"; REPO_GIVEN=1; shift 2 ;;
    --repo=*) REPO="${1#*=}"; REPO_GIVEN=1; shift ;;
    --dir) APP_DIR="${2:?--dir needs a path}"; shift 2 ;;
    --dir=*) APP_DIR="${1#*=}"; shift ;;
    --ssh-port) SSH_PORT="${2:?--ssh-port needs a port}"; shift 2 ;;
    --ssh-port=*) SSH_PORT="${1#*=}"; shift ;;
    --egress-guard) EGRESS_GUARD=1; shift ;;
    --no-egress-guard) EGRESS_GUARD=0; shift ;;
    --no-firewall) FIREWALL=0; shift ;;
    --no-backup) BACKUP=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $1" >&2; echo >&2; usage >&2; exit 2 ;;
  esac
done

export APP_DIR
die() { echo "error: $*" >&2; exit 1; }
warn() { echo "    warning: $*" >&2; }
step() { echo; echo "==> $*"; }

[[ $EUID -eq 0 ]] || die "run as root: sudo $0 $*"
if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"
  ENV_FILE="$(readlink -f "$ENV_FILE")"
elif [[ ! -f "$APP_DIR/ops/.env" ]]; then
  die "no --env given and $APP_DIR/ops/.env does not exist yet. Copy ops/.env.example, fill it in and pass it with --env."
fi

mkdir -p "$(dirname "$LOG")"
exec > >(tee -a "$LOG") 2>&1
trap 'echo; echo "install failed at line $LINENO (log: $LOG)" >&2' ERR
echo "=== datasetto install $(date -Is): ref=$REF dir=$APP_DIR ==="

# ---- OS ----------------------------------------------------------------------
OS_ID=""; OS_VERSION=""
if [[ -r /etc/os-release ]]; then
  # shellcheck source=/dev/null
  . /etc/os-release
  OS_ID="${ID:-}"; OS_VERSION="${VERSION_ID:-}"
fi
case "$OS_ID:$OS_VERSION" in
  debian:13*|debian:12*|ubuntu:24.04|ubuntu:26.04) echo "OS: ${PRETTY_NAME:-$OS_ID $OS_VERSION}" ;;
  debian:*|ubuntu:*) warn "tested on Debian 13 and 12 and Ubuntu 24.04 and 26.04; this is ${PRETTY_NAME:-$OS_ID $OS_VERSION}, continuing" ;;
  *) warn "this script expects a Debian or Ubuntu host (apt, systemd, ufw); found '${OS_ID:-unknown}', continuing" ;;
esac
command -v systemctl >/dev/null 2>&1 || die "systemd is required"

# ---- helpers to read the configuration --------------------------------------
# The file the values come from: the one passed in now, else the installed copy.
ENV_SRC="${ENV_FILE:-$APP_DIR/ops/.env}"
env_value_from() {
  grep -E "^$2=" "$1" 2>/dev/null | tail -n1 | cut -d= -f2- | tr -d '\r' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" || true
}
env_value() { env_value_from "$ENV_SRC" "$1"; }
# Set KEY=VALUE in the installed ops/.env, replacing the line when the key exists.
set_env_value() {
  local key="$1" value="$2" target="$APP_DIR/ops/.env" escaped
  escaped="$(printf '%s' "$value" | sed -e 's/[|&\\]/\\&/g')"
  if grep -qE "^$key=" "$target"; then
    sed -i "s|^$key=.*|$key=$escaped|" "$target"
  else
    printf '%s=%s\n' "$key" "$value" >> "$target"
  fi
}
PROFILES="$(env_value COMPOSE_PROFILES)"
RCLONE_REMOTE="$(env_value BACKUP_RCLONE_REMOTE)"
TURN_PORT="$(env_value TURN_PORT)"; TURN_PORT="${TURN_PORT:-3478}"
TURN_MIN_PORT="$(env_value TURN_MIN_PORT)"; TURN_MIN_PORT="${TURN_MIN_PORT:-49152}"
TURN_MAX_PORT="$(env_value TURN_MAX_PORT)"; TURN_MAX_PORT="${TURN_MAX_PORT:-49400}"
WANT_TURN=0; [[ "$PROFILES" == *turn* ]] && WANT_TURN=1

# ---- 1. swap -----------------------------------------------------------------
ensure_swap() {
  step "Swap"
  local mem_kb swap_kb meminfo="${MEMINFO:-/proc/meminfo}"
  mem_kb="$(awk '/^MemTotal:/ {print $2}' "$meminfo")"
  swap_kb="$(awk '/^SwapTotal:/ {print $2}' "$meminfo")"
  if (( mem_kb >= 3 * 1024 * 1024 )); then
    echo "    $(( mem_kb / 1024 )) MB RAM, no swap file needed"
    return
  fi
  if (( swap_kb >= 1024 * 1024 )); then
    echo "    $(( swap_kb / 1024 )) MB swap already present"
    return
  fi
  if [[ ! -f /swapfile ]]; then
    fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048 status=none
    chmod 600 /swapfile
    mkswap -q /swapfile
  fi
  if swapon /swapfile 2>/dev/null; then
    grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
    echo 'vm.swappiness=10' > /etc/sysctl.d/90-datasetto.conf
    sysctl -q -p /etc/sysctl.d/90-datasetto.conf || true
    echo "    2 GB swap file enabled ($(( mem_kb / 1024 )) MB RAM)"
  else
    warn "could not enable /swapfile on this host; continuing without swap"
    rm -f /swapfile
  fi
}

# ---- 2. packages -------------------------------------------------------------
ensure_packages() {
  step "Packages"
  export DEBIAN_FRONTEND=noninteractive
  local pkgs=(ca-certificates curl git unattended-upgrades iproute2)
  (( FIREWALL )) && pkgs+=(ufw)
  [[ -n "$RCLONE_REMOTE" ]] && pkgs+=(rclone)
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends "${pkgs[@]}"
  # Security updates install themselves; reboots stay manual.
  if ! grep -qs 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/20auto-upgrades; then
    cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
  fi
  systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
  echo "    ${pkgs[*]}; unattended security upgrades on"
}

# ---- 3. docker ---------------------------------------------------------------
ensure_docker() {
  step "Docker"
  if ! command -v docker >/dev/null 2>&1; then
    curl -fsSL https://get.docker.com | sh
  fi
  systemctl enable --now docker >/dev/null
  if ! docker compose version >/dev/null 2>&1; then
    apt-get install -y -qq docker-compose-plugin
  fi
  echo "    $(docker --version), $(docker compose version --short)"
}

# ---- 4. code -----------------------------------------------------------------
sync_repo() {
  step "Code in $APP_DIR (ref $REF)"
  if [[ ! -d "$APP_DIR/.git" ]]; then
    git clone --quiet "$REPO" "$APP_DIR"
  elif (( REPO_GIVEN )) && [[ "$(git -C "$APP_DIR" remote get-url origin)" != "$REPO" ]]; then
    git -C "$APP_DIR" remote set-url origin "$REPO"
  fi
  cd "$APP_DIR"
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    die "$APP_DIR has local changes to tracked files; commit, stash or discard them (git -C $APP_DIR status)"
  fi
  git fetch --quiet --tags --force origin
  if git show-ref --verify --quiet "refs/remotes/origin/$REF"; then
    # A branch: track the remote exactly, so a re-run deploys what the branch has now.
    git checkout --quiet -B "$REF" "origin/$REF"
  else
    # A tag or a commit.
    git checkout --quiet --detach "$REF"
  fi
  echo "    at $(git rev-parse --short HEAD): $(git log -1 --format=%s)"
}

# ---- 5. configuration --------------------------------------------------------
write_env() {
  step "Configuration ops/.env"
  local target="$APP_DIR/ops/.env" key kept
  local -A keep=()
  if [[ -n "$ENV_FILE" ]]; then
    if [[ "$ENV_FILE" != "$(readlink -f "$target" 2>/dev/null || true)" ]]; then
      # Push keys generated here by an earlier run survive a new --env file that lacks them:
      # a new pair would silently orphan every browser subscribed to the old one.
      for key in PUSH_VAPID_PUBLIC_KEY PUSH_VAPID_PRIVATE_KEY PUSH_VAPID_SUBJECT; do
        keep[$key]="$(env_value_from "$target" "$key")"
      done
      install -m 0600 -o root -g root "$ENV_FILE" "$target"
    fi
  fi
  chmod 600 "$target"
  sed -i 's/\r$//' "$target"
  ENV_SRC="$target"
  kept=""
  for key in "${!keep[@]}"; do
    if [[ -n "${keep[$key]}" && -z "$(env_value "$key")" ]]; then
      set_env_value "$key" "${keep[$key]}"
      kept="$kept $key"
    fi
  done
  [[ -z "$kept" ]] || echo "    kept from the previous ops/.env:${kept} (copy them into your local env file)"

  local site mode code secret ext_ip
  site="$(env_value SITE_ADDRESS)"
  mode="$(env_value REGISTRATION_MODE)"
  code="$(env_value REGISTRATION_INVITE_CODE)"
  if [[ -z "$site" || "$site" == ":80" ]]; then
    warn "SITE_ADDRESS is '${site:-empty}': plain HTTP on port 80, no certificate. Set it to your domain for HTTPS."
  elif [[ "$site" == *example.com* ]]; then
    warn "SITE_ADDRESS still points at example.com"
  fi
  if [[ "$mode" == "invite" ]]; then
    [[ -n "$code" ]] || die "REGISTRATION_MODE=invite needs REGISTRATION_INVITE_CODE"
    [[ "$code" != "change-me" ]] || warn "REGISTRATION_INVITE_CODE is still 'change-me'"
  fi
  if (( WANT_TURN )); then
    secret="$(env_value TURN_SECRET)"
    [[ -n "$secret" && "$secret" != "change-me-too" ]] || die "COMPOSE_PROFILES=turn needs a real TURN_SECRET"
    ext_ip="$(env_value TURN_EXTERNAL_IP)"
    [[ -n "$ext_ip" ]] || warn "TURN_EXTERNAL_IP is empty; coturn will ask api.ipify.org for the public IP. Set it to this server's IPv4 to be safe."
  fi
  echo "    site ${site:-:80}, registration ${mode:-open}, profiles '${PROFILES:-none}'"
}

# ---- 6. firewall -------------------------------------------------------------
detect_ssh_ports() {
  local ports=""
  if [[ -n "$SSH_PORT" ]]; then
    echo "$SSH_PORT"
    return
  fi
  if command -v sshd >/dev/null 2>&1; then
    ports="$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2}' || true)"
  fi
  if command -v ss >/dev/null 2>&1; then
    ports="$ports $(ss -Hltnp 2>/dev/null | awk '/"sshd"/ {print $4}' | sed 's/.*://' || true)"
  fi
  # shellcheck disable=SC2086
  ports="$(printf '%s\n' $ports | grep -E '^[0-9]+$' | sort -un | tr '\n' ' ')"
  echo "${ports:-22}"
}

configure_firewall() {
  step "Firewall (ufw)"
  local ssh_ports p ssh_mode out
  ssh_ports="$(detect_ssh_ports)"
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  # "limit" needs the xt_recent kernel module. Every Debian and Ubuntu kernel has
  # it, but if ufw cannot insert the rule it drops it silently; with deny-by-default
  # that would lock you out, so the rule is checked after enabling and a plain
  # allow is used as the fallback.
  ssh_mode="rate limited"
  out=""
  for p in $ssh_ports; do
    out="$out $(ufw limit "$p/tcp" 2>&1 || true)"
  done
  ufw --force enable >/dev/null
  for p in $ssh_ports; do
    if ! ufw status | grep -qE "^$p/tcp +(LIMIT|ALLOW)"; then
      warn "ufw did not accept 'limit $p/tcp' (${out# }); allowing it without rate limiting"
      ufw allow "$p/tcp" >/dev/null
      ssh_mode="open, not rate limited"
    fi
  done
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
  ufw allow 1935/tcp >/dev/null
  ufw allow 1936/tcp >/dev/null
  if (( WANT_TURN )); then
    ufw allow "$TURN_PORT/tcp" >/dev/null
    ufw allow "$TURN_PORT/udp" >/dev/null
    ufw allow "$TURN_MIN_PORT:$TURN_MAX_PORT/udp" >/dev/null
  else
    ufw delete allow "$TURN_PORT/tcp" >/dev/null 2>&1 || true
    ufw delete allow "$TURN_PORT/udp" >/dev/null 2>&1 || true
    ufw delete allow "$TURN_MIN_PORT:$TURN_MAX_PORT/udp" >/dev/null 2>&1 || true
  fi
  ufw --force enable >/dev/null
  echo "    ssh ($ssh_mode) on tcp ${ssh_ports% }; open: 80/tcp 443/tcp 443/udp 1935/tcp 1936/tcp$( (( WANT_TURN )) && echo " $TURN_PORT/tcp $TURN_PORT/udp $TURN_MIN_PORT:$TURN_MAX_PORT/udp")"
  ufw status | sed 's/^/    /'
}

# ---- 7. containers and boot unit --------------------------------------------
# Web Push needs a VAPID key pair. Without Node on the host, the app image (which ships
# the web-push package) generates it; the pair goes into ops/.env and stays there.
ensure_vapid_keys() {
  step "Push notifications (VAPID keys)"
  local pub priv subject json site admin
  pub="$(env_value PUSH_VAPID_PUBLIC_KEY)"
  priv="$(env_value PUSH_VAPID_PRIVATE_KEY)"
  if [[ -n "$pub" && -n "$priv" ]]; then
    echo "    key pair present in ops/.env"
    return
  fi
  if [[ -n "$pub$priv" ]]; then
    warn "only one of PUSH_VAPID_PUBLIC_KEY / PUSH_VAPID_PRIVATE_KEY is set; the app refuses to start like that. Clear both to get a new pair."
    return
  fi
  subject="$(env_value PUSH_VAPID_SUBJECT)"
  if [[ -z "$subject" ]]; then
    site="$(env_value SITE_ADDRESS)"
    admin="$(env_value ADMIN_EMAILS | cut -d, -f1 | tr -d '[:space:]')"
    if [[ -n "$site" && "$site" != :* && "$site" != *example.com* ]]; then
      subject="https://${site#*://}"
    elif [[ -n "$admin" && "$admin" != *example.com* ]]; then
      subject="mailto:$admin"
    else
      warn "no PUSH_VAPID_SUBJECT and nothing to derive it from (SITE_ADDRESS is not a domain, ADMIN_EMAILS is empty); push notifications stay off. Set PUSH_VAPID_SUBJECT=mailto:you@example.com and re-run."
      return
    fi
  fi
  json="$(cd "$APP_DIR/ops" && docker compose run --rm --no-deps --entrypoint node app -e 'const w=require("web-push");console.log(JSON.stringify(w.generateVAPIDKeys()))')" || json=""
  pub="$(printf '%s' "$json" | sed -n 's/.*"publicKey":"\([^"]*\)".*/\1/p')"
  priv="$(printf '%s' "$json" | sed -n 's/.*"privateKey":"\([^"]*\)".*/\1/p')"
  if [[ -z "$pub" || -z "$priv" ]]; then
    warn "could not generate VAPID keys with the app image; push notifications stay off. Set PUSH_VAPID_* in ops/.env by hand (docker run --rm node:24-slim npx -y web-push generate-vapid-keys)."
    return
  fi
  set_env_value PUSH_VAPID_PUBLIC_KEY "$pub"
  set_env_value PUSH_VAPID_PRIVATE_KEY "$priv"
  set_env_value PUSH_VAPID_SUBJECT "$subject"
  echo "    generated a key pair into ops/.env, subject $subject"
  echo "    keep the pair (browsers subscribe to the public key); copy PUSH_VAPID_* into your local env file"
}

compose_up() {
  step "Containers"
  cd "$APP_DIR/ops"
  if ! docker compose pull --quiet; then
    warn "image pull failed; building the images from source (a few minutes on a small VPS)"
    docker compose build
  fi
  ensure_vapid_keys
  cd "$APP_DIR/ops"
  docker compose up -d --remove-orphans || docker compose up -d --build --remove-orphans
  if (( ! WANT_TURN )); then
    # A service whose profile is no longer active is not an orphan to compose, so a
    # relay left over from an earlier COMPOSE_PROFILES=turn has to go explicitly.
    docker compose --profile turn rm -sf turn >/dev/null 2>&1 || true
  fi
  docker compose ps
}

install_boot_unit() {
  step "Boot unit datasetto.service"
  local docker_bin
  docker_bin="$(command -v docker)"
  cat > /etc/systemd/system/datasetto.service <<UNIT
[Unit]
Description=Datasetto (docker compose stack in $APP_DIR/ops)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$APP_DIR/ops
ExecStart=$docker_bin compose up -d --remove-orphans
# compose stop honours each service's stop_grace_period (app: 15 s for its graceful shutdown);
# four containers in a row stay well inside this.
ExecStop=$docker_bin compose stop
TimeoutStartSec=900
TimeoutStopSec=90

[Install]
WantedBy=multi-user.target
UNIT
  systemctl daemon-reload
  systemctl enable --now datasetto.service >/dev/null
  echo "    enabled; systemctl status datasetto / systemctl stop datasetto"
}

wait_for_app() {
  step "Waiting for the app to report healthy"
  local cid status i
  cid="$(cd "$APP_DIR/ops" && docker compose ps -q app)"
  for i in $(seq 1 45); do
    status="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo unknown)"
    if [[ "$status" == "healthy" ]]; then
      echo "    app healthy after about $(( i * 2 )) s"
      return 0
    fi
    sleep 2
  done
  warn "app is '$status' after 90 s; check: cd $APP_DIR/ops && docker compose logs app"
  return 0
}

# ---- 8. backups ----------------------------------------------------------------
install_backup() {
  step "Daily backup"
  if (( ! BACKUP )); then
    if [[ -f /etc/systemd/system/datasetto-backup.timer ]]; then
      systemctl disable --now datasetto-backup.timer >/dev/null 2>&1 || true
      rm -f /etc/systemd/system/datasetto-backup.timer /etc/systemd/system/datasetto-backup.service
      systemctl daemon-reload
    fi
    echo "    disabled (--no-backup)"
    return
  fi
  cat > /etc/systemd/system/datasetto-backup.service <<UNIT
[Unit]
Description=Datasetto daily SQLite backup
Requires=docker.service
After=docker.service datasetto.service

[Service]
Type=oneshot
Environment=APP_DIR=$APP_DIR
ExecStart=/bin/bash $APP_DIR/ops/vps/backup.sh
StandardOutput=append:/var/log/datasetto-backup.log
StandardError=inherit
UNIT
  cat > /etc/systemd/system/datasetto-backup.timer <<'UNIT'
[Unit]
Description=Run the Datasetto backup every night

[Timer]
OnCalendar=*-*-* 04:00:00
RandomizedDelaySec=30min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
  systemctl daemon-reload
  systemctl enable --now datasetto-backup.timer >/dev/null
  if [[ -n "$RCLONE_REMOTE" ]]; then
    local remote_name="${RCLONE_REMOTE%%:*}"
    if [[ "$RCLONE_REMOTE" == *:* ]] && ! rclone listremotes 2>/dev/null | grep -qx "$remote_name:"; then
      warn "rclone remote '$remote_name' is not configured yet; run 'rclone config' as root. Backups stay local until then."
    else
      echo "    copies also go to rclone remote $RCLONE_REMOTE"
    fi
  fi
  if systemctl start datasetto-backup.service; then
    echo "    first backup written: $(find /var/backups/datasetto -maxdepth 1 -name 'datasetto-*.db.gz' -printf '%T@ %p
' 2>/dev/null | sort -rn | head -n1 | cut -d' ' -f2-)"
  else
    warn "first backup failed; see /var/log/datasetto-backup.log"
  fi
  echo "    nightly at 04:00 (timer datasetto-backup.timer), 14 copies in /var/backups/datasetto"
}

# ---- 9. egress guard (optional) ---------------------------------------------
configure_egress_guard() {
  case "$EGRESS_GUARD" in
    1) step "Egress guard"; bash "$APP_DIR/ops/common/egress-guard-install.sh" | sed 's/^/    /' ;;
    0) step "Egress guard"; bash "$APP_DIR/ops/common/egress-guard-install.sh" --remove | sed 's/^/    /' ;;
    *) ;;
  esac
}

summary() {
  local site ip host push
  site="$(env_value SITE_ADDRESS)"
  host="${site#:}"; [[ "$host" == "80" ]] && host=""
  ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "src") print $(i + 1)}' | head -n1)"
  push="off (no PUSH_VAPID_* keys)"
  [[ -n "$(env_value PUSH_VAPID_PRIVATE_KEY)" ]] && push="on (VAPID keys in ops/.env; needs https for browsers to subscribe)"
  cat <<EOF

=== datasetto install done $(date -Is) ===

  Server IPv4 : ${ip:-unknown}
  Site        : ${host:-http://${ip:-<ip>}/ (no domain configured)}
  Checkout    : $APP_DIR ($REF)
  Push        : $push
  Backups     : /var/backups/datasetto (nightly, 14 copies)${RCLONE_REMOTE:+ + rclone $RCLONE_REMOTE}
  Logs        : cd $APP_DIR/ops && docker compose logs -f --tail 100
  Install log : $LOG

Next:
  1. DNS: A record ${host:-<your domain>} -> ${ip:-<server ip>} (Caddy fetches the certificate on the first request)
  2. Open https://${host:-<your domain>}/app and register with an ADMIN_EMAILS address
  3. OBS: server rtmp://${host:-<your domain>}/live, key from the channel's key dialog

Update later: re-run this script with the same --ref, or
  cd $APP_DIR && git pull && cd ops && docker compose pull && docker compose up -d --remove-orphans
EOF
}

ensure_swap
ensure_packages
ensure_docker
sync_repo
write_env
if (( FIREWALL )); then configure_firewall; else step "Firewall"; echo "    skipped (--no-firewall)"; fi
compose_up
install_boot_unit
wait_for_app
install_backup
configure_egress_guard
summary
