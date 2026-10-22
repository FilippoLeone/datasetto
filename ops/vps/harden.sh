# shellcheck shell=bash
# Host hardening for a Datasetto VPS. ops/vps/install.sh sources this file right after
# the checkout, so every redeploy applies the version it just checked out. Each harden_*
# function is one installer step: idempotent (it rewrites its own files only when their
# content changes and restarts a service only then), reported in the step output and in
# the summary, and switched off by its own installer flag. A step that fails warns and
# the run goes on; nothing here stops the deploy.
#
# SSH is the one step that could lock the owner out, so it switches password logins off
# only when the admin user has a key sshd will accept, validates the result with
# `sshd -t` and `sshd -T` before a reload (open sessions stay up), and puts the previous
# file back on any failure.
#
# The variables below are install.sh's options (its usage header documents them). The
# defaults let a test source this file on its own:
#   source ops/vps/harden.sh && harden_ssh

: "${HARDEN:=1}" "${HARDEN_SSH:=1}" "${KEEP_SSH_PASSWORDS:=0}" "${HARDEN_UPDATES:=1}"
: "${AUTO_REBOOT:=1}" "${REBOOT_TIME:=04:30}" "${HARDEN_DOCKER:=1}" "${HARDEN_FAIL2BAN:=1}"
: "${HARDEN_RESOLVER:=1}" "${HARDEN_SYSCTL:=1}" "${STACK_HEALTHY:=1}" "${APP_DIR:=/opt/datasetto}"

declare -F step >/dev/null || step() { echo; echo "==> $*"; }
declare -F warn >/dev/null || warn() { echo "    warning: $*" >&2; }
say() { printf '    %s\n' "$*"; }

# The flag that switched an area off, for the messages: its own, or --no-harden.
optout() { if (( HARDEN )); then echo "$1"; else echo "--no-harden"; fi; }

# One line per area for the installer's summary.
HARDEN_SUMMARY=()
harden_note() { HARDEN_SUMMARY+=("$(printf '%-12s: %s' "$1" "$2")"); }

# write_if_changed FILE CONTENT [MODE]: returns 0 when the file was (re)written, 1 when it
# already had exactly this content.
write_if_changed() {
  local file="$1" content="$2" mode="${3:-0644}"
  if [[ -f "$file" && "$(cat "$file")" == "$content" ]]; then
    return 1
  fi
  mkdir -p "$(dirname "$file")"
  printf '%s\n' "$content" > "$file.datasetto-new" \
    && chmod "$mode" "$file.datasetto-new" \
    && mv -f "$file.datasetto-new" "$file"
}

# remove_if_present FILE: returns 0 when a file was removed.
remove_if_present() {
  [[ -e "$1" ]] || return 1
  rm -f "$1"
}

# ---- SSH ------------------------------------------------------------------------
SSH_DROPIN=/etc/ssh/sshd_config.d/10-datasetto.conf
# sshd -T for a connection from an outside address, so Match blocks apply as they would
# for the owner. 203.0.113.0/24 is a documentation range nobody connects from.
SSH_CHECK_SPEC="host=datasetto-check.invalid,addr=203.0.113.10"

sshd_effective() { sshd -T -C "user=$1,$SSH_CHECK_SPEC" 2>/dev/null; }
# eff_value "SSHD -T OUTPUT" KEYWORD
eff_value() { awk -v k="$2" '$1 == k { $1 = ""; sub(/^ /, ""); print; exit }' <<< "$1"; }

user_has_sudo() {
  [[ "$1" == root ]] && return 0
  command -v sudo >/dev/null 2>&1 || return 1
  # "(ALL) NOPASSWD: ALL", "(ALL : ALL) ALL" and the like: full root, not a command list.
  sudo -n -l -U "$1" 2>/dev/null \
    | grep -qE '^[[:space:]]+\((ALL|root)([[:space:]]*:[[:space:]]*[^)]*)?\)[[:space:]]+([A-Z_]+:[[:space:]]*)*ALL[[:space:]]*$'
}

# Prints "USER HOW": the account the owner logs in with. The sudo caller first; then the
# user of the login session (the audit loginuid survives "sudo su -", which drops
# SUDO_USER); then the first sudo-capable user with a home; root as the last resort.
ssh_admin_user() {
  local u uid home shell
  if [[ -n "${SUDO_USER:-}" && "$SUDO_USER" != root ]] && id "$SUDO_USER" >/dev/null 2>&1; then
    echo "$SUDO_USER sudo"
    return
  fi
  uid="$(cat /proc/self/loginuid 2>/dev/null || true)"
  if [[ "$uid" =~ ^[0-9]+$ && "$uid" != 4294967295 ]]; then
    u="$(getent passwd "$uid" | cut -d: -f1)"
    if [[ -n "$u" ]]; then
      echo "$u login"
      return
    fi
  fi
  while IFS=: read -r u _ uid _ _ home shell; do
    (( uid >= 1000 && uid < 60000 )) || continue
    [[ -d "$home" ]] || continue
    case "$shell" in */nologin|*/false|"") continue ;; esac
    if user_has_sudo "$u"; then
      echo "$u first-sudo-user"
      return
    fi
  done < <(getent passwd | sort -t: -k3,3n)
  echo "root none"
}

# ssh_key_files USER HOME: the AuthorizedKeysFile paths sshd uses for USER.
ssh_key_files() {
  local user="$1" home="$2" uid spec f
  uid="$(id -u "$user")"
  spec="$(eff_value "$(sshd_effective "$user")" authorizedkeysfile)"
  local -a paths=()
  read -r -a paths <<< "$spec"
  for f in "${paths[@]}"; do
    [[ "$f" == none ]] && continue
    f="${f//\%\%/$'\001'}"; f="${f//\%h/$home}"; f="${f//\%u/$user}"; f="${f//\%U/$uid}"; f="${f//$'\001'/%}"
    [[ "$f" == /* ]] || f="$home/$f"
    printf '%s\n' "$f"
  done
}

# ssh_usable_keys FILE: fingerprints of the keys in FILE that give a shell login. Lines
# with a forced command are left out: cloud images put one on root's key that only
# prints "log in as debian" and disconnects.
ssh_usable_keys() {
  local line opts
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
    opts="${line%% AAAA*}"
    [[ "$opts" == *command=* ]] && continue
    printf '%s\n' "$line" | ssh-keygen -l -f /dev/stdin 2>/dev/null || true
  done < "$1"
}

# ssh_path_ok FILE UID HOME: sshd's StrictModes check. The file and every directory up
# to the home directory must belong to the user or root and not be group or world writable.
ssh_path_ok() {
  local path uid="$2" home owner mode
  path="$(readlink -f "$1")" || return 1
  home="$(readlink -f "$3")" || return 1
  [[ -f "$path" ]] || return 1
  while :; do
    read -r owner mode < <(stat -c '%u %a' "$path") || return 1
    (( owner == 0 || owner == uid )) || return 1
    (( (8#$mode & 8#022) == 0 )) || return 1
    [[ "$path" == "$home" || "$path" == / ]] && return 0
    path="$(dirname "$path")"
  done
}

ssh_unit() {
  local u
  for u in ssh.service sshd.service; do
    if systemctl cat "$u" >/dev/null 2>&1; then
      echo "$u"
      return 0
    fi
  done
  return 1
}

# ssh_reload UNIT: SIGHUP, so sshd re-executes itself with the new files and open sessions
# stay up. A unit that is not running (socket activation on Ubuntu) reads the files when
# it starts, so it is left alone.
ssh_reload() {
  systemctl is-active --quiet "$1" || return 0
  systemctl reload "$1"
}

# ssh_alive UNIT: after a reload of a running sshd, the unit is active again and sshd
# listens (it re-executes on SIGHUP, and a broken config would make it exit).
ssh_alive() {
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if systemctl is-active --quiet "$1" && ss -Hltnp 2>/dev/null | grep -q '"sshd'; then
      return 0
    fi
    sleep 1
  done
  return 1
}

# The methods sshd offers on loopback, as the client sees them ("publickey" or
# "publickey,password"); empty when the probe cannot run.
ssh_offered_methods() {
  local user="$1" port="$2" out
  command -v ssh >/dev/null 2>&1 || return 0
  out="$(timeout 10 ssh -n -o BatchMode=yes -o PreferredAuthentications=none \
    -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
    -o ConnectTimeout=5 -p "$port" "$user@127.0.0.1" true 2>&1 || true)"
  sed -n 's/.*Permission denied (\([^)]*\)).*/\1/p' <<< "$out" | head -n1
}

# ssh_restore BACKUP: put the previous drop-in back (an empty BACKUP means there was none).
ssh_restore() {
  if [[ -n "$1" && -f "$1" ]]; then
    mv -f "$1" "$SSH_DROPIN"
  else
    rm -f "$SSH_DROPIN"
  fi
}

# ssh_apply_dropin CONTENT ADMIN NEEDS_PUBKEY: write (or with empty CONTENT remove) the
# drop-in, validate, reload; any failure restores the previous file.
ssh_apply_dropin() {
  local content="$1" admin="$2" needs_pubkey="$3" backup="" err eff unit was_active=0
  unit="$(ssh_unit)" || { warn "no ssh or sshd systemd unit found; sshd left alone"; return 1; }
  systemctl is-active --quiet "$unit" && was_active=1
  if [[ -f "$SSH_DROPIN" ]]; then
    backup="$(mktemp)"
    cp -p "$SSH_DROPIN" "$backup"
  fi
  if [[ -n "$content" ]]; then
    mkdir -p "$(dirname "$SSH_DROPIN")"
    if ! { printf '%s\n' "$content" > "$SSH_DROPIN.datasetto-new" \
        && chmod 0644 "$SSH_DROPIN.datasetto-new" \
        && mv -f "$SSH_DROPIN.datasetto-new" "$SSH_DROPIN"; }; then
      rm -f "$SSH_DROPIN.datasetto-new"
      ssh_restore "$backup"
      warn "could not write $SSH_DROPIN; sshd left as it was"
      return 1
    fi
  else
    rm -f "$SSH_DROPIN"
  fi
  if ! err="$(sshd -t 2>&1)"; then
    ssh_restore "$backup"
    warn "sshd -t rejected the new settings (${err//$'\n'/ }); the previous configuration is back"
    return 1
  fi
  eff="$(sshd_effective "$admin")"
  if (( needs_pubkey )) && [[ "$(eff_value "$eff" pubkeyauthentication)" != yes ]]; then
    ssh_restore "$backup"
    warn "another sshd file switches key logins off for $admin, so password logins cannot go; the previous configuration is back (grep -ri pubkeyauthentication /etc/ssh/)"
    return 1
  fi
  if ! ssh_reload "$unit"; then
    ssh_restore "$backup"
    ssh_reload "$unit" || true
    warn "reloading sshd failed; the previous configuration is back"
    return 1
  fi
  if (( was_active )) && ! ssh_alive "$unit"; then
    ssh_restore "$backup"
    systemctl restart "$unit" || true
    warn "sshd did not come back after the reload; the previous configuration is back and sshd was restarted"
    return 1
  fi
  [[ -z "$backup" ]] || rm -f "$backup"
  return 0
}

ssh_password_notice() {
  local admin="$1" fps="$2" files="$3" seen="$4" line
  echo
  echo "    ************************************************************************"
  echo "    *  SSH PASSWORD LOGINS ARE BEING SWITCHED OFF ON THIS SERVER            *"
  echo "    ************************************************************************"
  echo "    From now on $admin logs in over SSH with one of these keys only"
  echo "    (from $files):"
  while IFS= read -r line; do echo "      $line"; done <<< "$fps"
  echo "    The password from the provider's email, or any other password, stops"
  echo "    working for SSH. The provider's web console (OVH: KVM) still takes it."
  if [[ -n "$seen" ]]; then
    echo "    The journal shows a password login for $admin recently:"
    echo "      $seen"
    echo "    That device needs a key now."
  fi
  echo "    To keep passwords, re-run with --keep-ssh-passwords (or put"
  echo "    DATASETTO_KEEP_SSH_PASSWORDS=yes in ops/.env). Lost your key? See"
  echo "    ops/README.md, \"Locked out of SSH\"."
  echo
}

harden_ssh() {
  step "SSH ($SSH_DROPIN)"
  if (( ! HARDEN_SSH )); then
    if [[ -f "$SSH_DROPIN" ]]; then
      if ssh_apply_dropin "" root 0; then
        say "removed the drop-in ($(optout --no-harden-ssh)); sshd is back to the system's own settings"
      fi
    else
      say "left alone ($(optout --no-harden-ssh))"
    fi
    harden_note SSH "left alone ($(optout --no-harden-ssh))"
    return 0
  fi
  if ! command -v sshd >/dev/null 2>&1; then
    say "no OpenSSH server on this host; nothing to do"
    harden_note SSH "no OpenSSH server"
    return 0
  fi
  if ! grep -qsE '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/\*\.conf' /etc/ssh/sshd_config; then
    warn "/etc/ssh/sshd_config does not include /etc/ssh/sshd_config.d/*.conf; sshd left alone"
    harden_note SSH "left alone: sshd_config has no Include for sshd_config.d"
    return 1
  fi

  local admin how home uid eff f found fps="" files="" nkeys=0 problem="" strict
  read -r admin how < <(ssh_admin_user)
  home="$(getent passwd "$admin" | cut -d: -f6)"
  uid="$(id -u "$admin")"
  eff="$(sshd_effective "$admin")"
  if [[ -z "$eff" ]]; then
    warn "sshd -T fails on the current configuration ($(sshd -t 2>&1 | head -n1)); sshd left alone"
    harden_note SSH "left alone: the current sshd configuration does not validate"
    return 1
  fi
  strict="$(eff_value "$eff" strictmodes)"
  while IFS= read -r f; do
    [[ -s "$f" ]] || continue
    found="$(ssh_usable_keys "$f")"
    [[ -n "$found" ]] || continue
    if [[ "$strict" != no ]] && ! ssh_path_ok "$f" "$uid" "$home"; then
      problem="$f (or a directory above it) belongs to someone else or is writable by others, so sshd ignores it (fix: chmod go-w; chown $admin)"
      continue
    fi
    fps+="${fps:+$'\n'}$found"
    files+="${files:+, }$f"
  done < <(ssh_key_files "$admin" "$home")
  [[ -z "$fps" ]] || nkeys="$(wc -l <<< "$fps")"

  local how_text
  case "$how" in
    sudo) how_text="ran the installer with sudo" ;;
    login) how_text="logged-in user" ;;
    first-sudo-user) how_text="first sudo user; run the installer with sudo to pick yourself" ;;
    *) how_text="no other admin user" ;;
  esac
  say "admin login: $admin ($how_text); usable SSH keys: $nkeys${files:+ in $files}"

  # Password logins go only when a key login is certain to work.
  local pw_off=1 why="" hint="" lists
  lists="$(grep -E '^(allowusers|allowgroups|denyusers|denygroups) ' <<< "$eff" | cut -d' ' -f1 | tr '\n' ' ' || true)"
  if (( KEEP_SSH_PASSWORDS )); then
    pw_off=0; why="kept on request (--keep-ssh-passwords)"
  elif [[ -n "$problem" ]] && (( nkeys == 0 )); then
    pw_off=0; why="$problem"; hint=" Fix it and re-run to switch them off."
  elif (( nkeys == 0 )); then
    pw_off=0; why="$admin has no usable key in $(ssh_key_files "$admin" "$home" | head -n1)"
    hint=" Add one (ops/vps/install-ssh-key.ps1 from Windows, ssh-copy-id elsewhere) and re-run to switch them off."
  elif [[ "$(eff_value "$eff" authenticationmethods)" != any ]]; then
    pw_off=0; why="AuthenticationMethods is set to '$(eff_value "$eff" authenticationmethods)'; change it by hand"
  elif [[ -n "$lists" ]]; then
    pw_off=0; why="${lists% } restrict who may log in; check them by hand"
  fi

  # Root logs in no more once a sudo user can do everything root does; with root as the
  # only admin it keeps key logins.
  local root_line=""
  if [[ "$admin" != root ]] && user_has_sudo "$admin" && { [[ "$how" != first-sudo-user ]] || (( nkeys > 0 )); }; then
    root_line="PermitRootLogin no"
  elif [[ "$admin" == root ]] && (( pw_off )); then
    root_line="PermitRootLogin prohibit-password"
  fi

  local content
  content="# Written by ops/vps/install.sh (Datasetto) on every run; --no-harden-ssh removes it.
# sshd keeps the first value it reads for each keyword, and sshd_config includes this
# directory at its top, so these lines win over sshd_config itself and over drop-ins
# that sort later, such as 50-cloud-init.conf.
PubkeyAuthentication yes"
  if (( pw_off )); then
    content+=$'\n'"PasswordAuthentication no"$'\n'"KbdInteractiveAuthentication no"
  fi
  [[ -z "$root_line" ]] || content+=$'\n'"$root_line"
  content+=$'\n'"X11Forwarding no"$'\n'"AllowAgentForwarding no"$'\n'"MaxAuthTries 3"$'\n'"LoginGraceTime 30"

  if [[ -f "$SSH_DROPIN" && "$(cat "$SSH_DROPIN")" == "$content" ]]; then
    say "drop-in unchanged"
  else
    if (( pw_off )) && [[ "$(eff_value "$eff" passwordauthentication)" != no ]]; then
      local seen
      seen="$(journalctl --since "-30 days" -o short-iso --no-pager -q _COMM=sshd _COMM=sshd-session 2>/dev/null \
        | grep -E "Accepted (password|keyboard-interactive/pam) for $admin from" | tail -n1 || true)"
      ssh_password_notice "$admin" "$fps" "$files" "$seen"
    fi
    if ! ssh_apply_dropin "$content" "$admin" "$pw_off"; then
      harden_note SSH "FAILED, previous configuration kept (see the SSH step above)"
      return 1
    fi
    say "drop-in written, validated with sshd -t and loaded with a reload (open sessions stay up)"
  fi

  # What sshd uses now, compared with what the drop-in asks for.
  local kw want got mismatch=""
  eff="$(sshd_effective "$admin")"
  while read -r kw want; do
    [[ -z "$kw" || "$kw" == \#* ]] && continue
    got="$(eff_value "$eff" "${kw,,}")"
    [[ "$want" == prohibit-password && "$got" == without-password ]] && got=prohibit-password
    [[ "${got,,}" == "${want,,}" ]] || mismatch+=" $kw=$got (wanted $want)"
  done <<< "$content"
  if [[ -n "$mismatch" ]]; then
    warn "an earlier file or a Match block overrides:${mismatch}; look with: grep -ri <keyword> /etc/ssh/sshd_config /etc/ssh/sshd_config.d/"
  fi
  local port methods
  port="$(eff_value "$eff" port)"
  methods="$(ssh_offered_methods "$admin" "${port:-22}")"
  say "now: password logins $(eff_value "$eff" passwordauthentication), keyboard-interactive $(eff_value "$eff" kbdinteractiveauthentication), root login $(eff_value "$eff" permitrootlogin), X11 forwarding $(eff_value "$eff" x11forwarding), agent forwarding $(eff_value "$eff" allowagentforwarding), MaxAuthTries $(eff_value "$eff" maxauthtries), LoginGraceTime $(eff_value "$eff" logingracetime)${methods:+; offered on loopback: $methods}"
  if (( ! pw_off )) && (( ! KEEP_SSH_PASSWORDS )); then
    warn "password logins stay ON: $why.$hint"
    harden_note SSH "passwords still on ($why); root login $(eff_value "$eff" permitrootlogin)"
  elif (( ! pw_off )); then
    harden_note SSH "passwords on (--keep-ssh-passwords); root login $(eff_value "$eff" permitrootlogin); no X11 or agent forwarding"
  else
    harden_note SSH "keys only ($admin: $nkeys key(s)); root login $(eff_value "$eff" permitrootlogin); no X11 or agent forwarding"
  fi
  [[ -z "$mismatch" ]]
}

# ---- updates --------------------------------------------------------------------
UU_CONF=/etc/apt/apt.conf.d/51datasetto-unattended-upgrades
NEEDRESTART_CONF=/etc/needrestart/conf.d/50-datasetto.conf

harden_updates() {
  step "Updates (unattended-upgrades, needrestart, reboots)"
  if (( ! HARDEN_UPDATES )); then
    local removed=""
    remove_if_present "$UU_CONF" && removed+=" $UU_CONF"
    remove_if_present "$NEEDRESTART_CONF" && removed+=" $NEEDRESTART_CONF"
    say "left alone ($(optout --no-harden-updates))${removed:+; removed$removed}"
    harden_note Updates "security updates only, as Debian ships them ($(optout --no-harden-updates))"
    return 0
  fi
  local docker_origin="" content reboot_text
  if grep -rqs 'download\.docker\.com' /etc/apt/sources.list /etc/apt/sources.list.d/; then
    # Docker's Release file has a Suite but no Codename, so match the archive.
    docker_origin=$'\n'"// Docker's own repository (download.docker.com), which get.docker.com set up."$'\n'"Unattended-Upgrade::Origins-Pattern {"$'\n'"        \"origin=Docker,archive=\${distro_codename},label=Docker CE\";"$'\n'"};"
  fi
  content="// Written by ops/vps/install.sh (Datasetto) on every run; --no-harden-updates removes it.
// Adds to 50unattended-upgrades (lists add up, and later files win for single values).${docker_origin}
// Reboot when an update needs it (a new kernel, libc), at a quiet hour (server time).
// --no-auto-reboot sets false, --reboot-time HH:MM moves it.
Unattended-Upgrade::Automatic-Reboot \"$( (( AUTO_REBOOT )) && echo true || echo false)\";
Unattended-Upgrade::Automatic-Reboot-WithUsers \"true\";
Unattended-Upgrade::Automatic-Reboot-Time \"$REBOOT_TIME\";"
  local changed=""
  write_if_changed "$UU_CONF" "$content" && changed+=" $UU_CONF"
  if command -v needrestart >/dev/null 2>&1; then
    write_if_changed "$NEEDRESTART_CONF" "# Written by ops/vps/install.sh (Datasetto) on every run; --no-harden-updates removes it.
# Restart services that still run old libraries after an update, without asking
# (unattended-upgrades runs with nobody at the keyboard). Docker is on needrestart's
# own skip list; its package restarts it, and live-restore keeps the containers up.
\$nrconf{restart} = 'a';" && changed+=" $NEEDRESTART_CONF"
  else
    warn "needrestart is not installed; services keep old libraries until they restart"
  fi
  if ! systemctl is-enabled --quiet apt-daily-upgrade.timer 2>/dev/null; then
    systemctl enable --now apt-daily.timer apt-daily-upgrade.timer >/dev/null 2>&1 || warn "could not enable the apt-daily timers"
  fi
  if (( AUTO_REBOOT )); then
    reboot_text="reboot at $REBOOT_TIME when an update needs one"
  else
    reboot_text="no automatic reboots"
  fi
  local origins
  origins="$(apt-config dump 2>/dev/null | grep -cE '^Unattended-Upgrade::(Origins-Pattern|Allowed-Origins):: ' || true)"
  say "${changed:+written:$changed; }${docker_origin:+Docker CE packages included; }$origins origin patterns in effect; $reboot_text"
  harden_note Updates "${OS_ID:+${OS_ID^} }security updates${docker_origin:+ + Docker CE}, needrestart restarts services, $reboot_text"
}

# ---- Docker daemon --------------------------------------------------------------
DOCKER_DAEMON_JSON=/etc/docker/daemon.json

# docker_daemon_merge SRC DST: merges the hardening keys into SRC's settings and writes
# DST. Exit 0 = DST written (it differs), 3 = SRC already has them, other = error.
docker_daemon_merge() {
  python3 - "$1" "$2" <<'PY'
import json, os, sys
src, dst = sys.argv[1], sys.argv[2]
cur = {}
if os.path.exists(src):
    with open(src, encoding="utf-8") as f:
        text = f.read()
    if text.strip():
        try:
            cur = json.loads(text)
        except ValueError as e:
            sys.exit("not valid JSON (%s)" % e)
if not isinstance(cur, dict):
    sys.exit("not a JSON object")
new = json.loads(json.dumps(cur))
driver = new.get("log-driver", "json-file")
if driver == "json-file":
    new["log-driver"] = "json-file"
    opts = dict(new.get("log-opts") or {})
    opts.update({"max-size": "10m", "max-file": "5"})
    new["log-opts"] = opts
else:
    print("log-driver %s kept; log rotation is up to that driver" % driver)
new["live-restore"] = True
new["no-new-privileges"] = True
if new == cur:
    sys.exit(3)
with open(dst, "w", encoding="utf-8") as f:
    json.dump(new, f, indent=2, sort_keys=True)
    f.write("\n")
PY
}

docker_daemon_state() {
  local lr drv nnp
  lr="$(docker info -f '{{.LiveRestoreEnabled}}' 2>/dev/null || echo '?')"
  drv="$(docker info -f '{{.LoggingDriver}}' 2>/dev/null || echo '?')"
  if docker info -f '{{range .SecurityOptions}}{{.}} {{end}}' 2>/dev/null | grep -q 'no-new-privileges'; then nnp=on; else nnp=off; fi
  echo "live-restore $lr, log driver $drv, no-new-privileges default $nnp"
}

docker_wait_up() {
  for _ in $(seq 1 30); do
    docker info >/dev/null 2>&1 && return 0
    sleep 2
  done
  return 1
}

harden_docker_daemon() {
  step "Docker daemon ($DOCKER_DAEMON_JSON)"
  if (( ! HARDEN_DOCKER )); then
    say "left alone ($(optout --no-harden-docker)); settings an earlier run wrote stay until you edit the file"
    harden_note Docker "left alone ($(optout --no-harden-docker)): $(docker_daemon_state)"
    return 0
  fi
  if ! command -v python3 >/dev/null 2>&1; then
    warn "python3 is missing, so $DOCKER_DAEMON_JSON cannot be merged; left alone"
    harden_note Docker "left alone: no python3"
    return 1
  fi
  local tmp rc=0 prev="" msg
  tmp="$(mktemp)"
  msg="$(docker_daemon_merge "$DOCKER_DAEMON_JSON" "$tmp" 2>&1)" || rc=$?
  if (( rc == 3 )); then
    rm -f "$tmp"
    [[ -z "$msg" ]] || say "$msg"
    say "unchanged: $(docker_daemon_state)"
    harden_note Docker "logs 10m x 5, live-restore, no-new-privileges by default"
    return 0
  elif (( rc != 0 )); then
    rm -f "$tmp"
    warn "$DOCKER_DAEMON_JSON is ${msg:-unreadable}; left alone"
    harden_note Docker "left alone: $DOCKER_DAEMON_JSON does not parse"
    return 1
  fi
  [[ -z "$msg" ]] || say "$msg"
  if (( ! STACK_HEALTHY )); then
    rm -f "$tmp"
    warn "the containers are not all healthy, so Docker is not restarted with new settings now; fix the stack and re-run"
    harden_note Docker "not applied: the stack was not healthy"
    return 1
  fi
  if dockerd --help 2>/dev/null | grep -q -- '--validate'; then
    local err
    if ! err="$(dockerd --validate --config-file "$tmp" 2>&1)"; then
      rm -f "$tmp"
      warn "dockerd rejects the merged settings (${err//$'\n'/ }); $DOCKER_DAEMON_JSON left alone"
      harden_note Docker "left alone: dockerd rejected the merged file"
      return 1
    fi
  fi
  if [[ -f "$DOCKER_DAEMON_JSON" ]]; then
    prev="$(mktemp)"
    cp -p "$DOCKER_DAEMON_JSON" "$prev"
    [[ -f "$DOCKER_DAEMON_JSON.before-datasetto" ]] || cp -p "$DOCKER_DAEMON_JSON" "$DOCKER_DAEMON_JSON.before-datasetto"
  fi
  mkdir -p "$(dirname "$DOCKER_DAEMON_JSON")"
  install -m 0644 "$tmp" "$DOCKER_DAEMON_JSON"
  rm -f "$tmp"

  # live-restore can be switched on with a reload; once it is on, the restart that the
  # other settings need leaves the containers running.
  if [[ "$(docker info -f '{{.LiveRestoreEnabled}}' 2>/dev/null)" != true ]]; then
    systemctl reload docker >/dev/null 2>&1 || true
    sleep 2
  fi
  if [[ "$(docker info -f '{{.LiveRestoreEnabled}}' 2>/dev/null)" == true ]]; then
    say "live-restore is on, so restarting Docker leaves the containers running"
  else
    say "live-restore could not be switched on first: the containers stop and start again with Docker"
  fi
  say "restarting Docker to load the new settings"
  if ! systemctl restart docker || ! docker_wait_up; then
    if [[ -n "$prev" ]]; then mv -f "$prev" "$DOCKER_DAEMON_JSON"; else rm -f "$DOCKER_DAEMON_JSON"; fi
    systemctl reset-failed docker >/dev/null 2>&1 || true
    systemctl restart docker || true
    docker_wait_up || true
    warn "Docker did not come back with the new settings; the previous $DOCKER_DAEMON_JSON is back (journalctl -u docker)"
    harden_note Docker "FAILED, previous settings restored"
    return 1
  fi
  [[ -z "$prev" ]] || rm -f "$prev"
  say "now: $(docker_daemon_state)"
  # The stack is still what it was before the restart (install.sh's stack_state).
  if declare -F stack_state >/dev/null; then
    local pending=""
    for _ in $(seq 1 30); do
      pending="$(stack_state)"
      [[ -n "$pending" ]] || break
      sleep 2
    done
    if [[ -n "$pending" ]]; then
      warn "after the Docker restart these services are not healthy: $pending (cd $APP_DIR/ops && docker compose ps)"
      harden_note Docker "settings applied, but after the restart: $pending"
      return 1
    fi
    say "all services still up after the restart"
  fi
  harden_note Docker "logs 10m x 5, live-restore, no-new-privileges by default"
}

# ---- fail2ban -------------------------------------------------------------------
FAIL2BAN_JAIL=/etc/fail2ban/jail.d/datasetto.local

harden_fail2ban() {
  step "fail2ban (SSH brute force)"
  if (( ! HARDEN_FAIL2BAN )); then
    if remove_if_present "$FAIL2BAN_JAIL"; then
      systemctl try-reload-or-restart fail2ban >/dev/null 2>&1 || true
      say "removed $FAIL2BAN_JAIL ($(optout --no-fail2ban)); fail2ban itself stays installed (apt purge fail2ban removes it)"
    else
      say "left alone ($(optout --no-fail2ban))"
    fi
    harden_note fail2ban "not configured ($(optout --no-fail2ban))"
    return 0
  fi
  if ! command -v fail2ban-client >/dev/null 2>&1; then
    warn "fail2ban is not installed (the package step should have installed it)"
    harden_note fail2ban "MISSING"
    return 1
  fi
  local ports unit content changed=0 status
  ports="$(detect_ssh_ports | xargs | tr ' ' ',')"
  unit="$(ssh_unit || echo ssh.service)"
  # OpenSSH 9.8+ logs from sshd-session, which fail2ban's default journal match
  # (_COMM=sshd) misses; every sshd process runs in the unit, so match on that.
  content="# Written by ops/vps/install.sh (Datasetto) on every run; --no-fail2ban removes it.
# ufw already drops an address that opens more than 6 SSH connections in 30 s (the
# \"limit\" rule); this jail bans an address that fails to log in 5 times in 10 minutes,
# for an hour, doubling for repeat offenders up to a day. Bans are nftables rules on
# the SSH port. Unban: fail2ban-client set sshd unbanip <address>
[sshd]
enabled = true
backend = systemd
journalmatch = _SYSTEMD_UNIT=$unit
port = ${ports:-22}
banaction = nftables[type=multiport]
banaction_allports = nftables[type=allports]
mode = normal
maxretry = 5
findtime = 10m
bantime = 1h
bantime.increment = true
bantime.maxtime = 1d"
  write_if_changed "$FAIL2BAN_JAIL" "$content" && changed=1
  systemctl enable fail2ban >/dev/null 2>&1 || true
  if (( changed )) || ! systemctl is-active --quiet fail2ban; then
    systemctl restart fail2ban || true
  fi
  status=""
  for _ in $(seq 1 15); do
    status="$(fail2ban-client status sshd 2>/dev/null || true)"
    [[ -n "$status" ]] && break
    sleep 1
  done
  if [[ -z "$status" ]]; then
    warn "fail2ban does not answer for the sshd jail (journalctl -u fail2ban; fail2ban-client -t)"
    harden_note fail2ban "FAILED to start"
    return 1
  fi
  say "$( ((changed)) && echo "jail written; " )sshd jail on port ${ports:-22}: $(sed -n 's/.*Currently banned:[[:space:]]*/currently banned /p' <<< "$status"), $(sed -n 's/.*Total failed:[[:space:]]*/failed logins seen /p' <<< "$status" | head -n1)"
  harden_note fail2ban "sshd jail on port ${ports:-22}: 5 failures in 10 min, 1 h ban (growing)"
}

# ---- resolver -------------------------------------------------------------------
RESOLVED_CONF=/etc/systemd/resolved.conf.d/10-datasetto.conf

harden_resolver() {
  step "Resolver (LLMNR and multicast DNS)"
  if (( ! HARDEN_RESOLVER )); then
    if remove_if_present "$RESOLVED_CONF"; then
      systemctl try-restart systemd-resolved >/dev/null 2>&1 || true
      say "removed $RESOLVED_CONF ($(optout --no-harden-resolver))"
    else
      say "left alone ($(optout --no-harden-resolver))"
    fi
    harden_note Resolver "left alone ($(optout --no-harden-resolver))"
    return 0
  fi
  if ! systemctl is-active --quiet systemd-resolved; then
    say "systemd-resolved is not running; nothing answers LLMNR or mDNS"
    harden_note Resolver "systemd-resolved not running"
    return 0
  fi
  if write_if_changed "$RESOLVED_CONF" "# Written by ops/vps/install.sh (Datasetto) on every run; --no-harden-resolver removes it.
# A server needs neither name lookups by broadcast on the local network (LLMNR,
# port 5355 on every interface) nor multicast DNS (5353). Unicast DNS is unchanged.
[Resolve]
LLMNR=no
MulticastDNS=no"; then
    systemctl restart systemd-resolved || warn "could not restart systemd-resolved"
    say "LLMNR and multicast DNS switched off"
  else
    say "unchanged: LLMNR and multicast DNS off"
  fi
  sleep 1
  if ss -Hlnu 'sport = :5355' 2>/dev/null | grep -q . || ss -Hlnt 'sport = :5355' 2>/dev/null | grep -q .; then
    warn "something still listens on port 5355: $(ss -Hlntup 'sport = :5355' 2>/dev/null | head -n2 | tr -s ' ' | tr '\n' ';')"
    harden_note Resolver "LLMNR off in resolved, but port 5355 still open"
    return 1
  fi
  harden_note Resolver "LLMNR and multicast DNS off"
}

# ---- kernel settings ------------------------------------------------------------
SYSCTL_CONF=/etc/sysctl.d/60-datasetto-hardening.conf

harden_sysctl() {
  step "Kernel settings ($SYSCTL_CONF)"
  if (( ! HARDEN_SYSCTL )); then
    if remove_if_present "$SYSCTL_CONF"; then
      say "removed $SYSCTL_CONF ($(optout --no-harden-sysctl)); the kernel defaults return at the next boot"
    else
      say "left alone ($(optout --no-harden-sysctl))"
    fi
    harden_note Kernel "left alone ($(optout --no-harden-sysctl))"
    return 0
  fi
  local content changed=0 key want got bad="" absent="" n=0 err
  content="# Written by ops/vps/install.sh (Datasetto) on every run; --no-harden-sysctl removes it.
# Docker routes between its bridge networks and the internet, so forwarding stays on.
net.ipv4.ip_forward = 1
# No ICMP redirects or source-routed packets: a server takes its routes from its own
# configuration, not from the network.
net.ipv4.conf.all.accept_redirects = 0
net.ipv4.conf.default.accept_redirects = 0
net.ipv4.conf.all.secure_redirects = 0
net.ipv4.conf.default.secure_redirects = 0
net.ipv4.conf.all.send_redirects = 0
net.ipv4.conf.default.send_redirects = 0
net.ipv6.conf.all.accept_redirects = 0
net.ipv6.conf.default.accept_redirects = 0
net.ipv4.conf.all.accept_source_route = 0
net.ipv4.conf.default.accept_source_route = 0
net.ipv6.conf.all.accept_source_route = 0
net.ipv6.conf.default.accept_source_route = 0
# Log packets with impossible source addresses; drop those that arrive on an interface
# the reply would not leave by (strict reverse-path filter).
net.ipv4.conf.all.log_martians = 1
net.ipv4.conf.default.log_martians = 1
net.ipv4.conf.all.rp_filter = 1
net.ipv4.conf.default.rp_filter = 1
net.ipv4.icmp_echo_ignore_broadcasts = 1
net.ipv4.icmp_ignore_bogus_error_responses = 1
net.ipv4.tcp_syncookies = 1
# Links and files in world-writable directories (/tmp) cannot be used against others.
fs.protected_symlinks = 1
fs.protected_hardlinks = 1
fs.protected_fifos = 2
fs.protected_regular = 2
fs.suid_dumpable = 0
# Kernel addresses and the kernel log are for root only; no BPF for unprivileged users.
kernel.kptr_restrict = 2
kernel.dmesg_restrict = 1
kernel.unprivileged_bpf_disabled = 1
net.core.bpf_jit_harden = 2"
  write_if_changed "$SYSCTL_CONF" "$content" && changed=1
  # -e: a key this kernel does not have (no BPF JIT, say) is skipped, not an error.
  err="$(sysctl -e -q -p "$SYSCTL_CONF" 2>&1 >/dev/null || true)"
  [[ -z "$err" ]] || warn "some settings could not be applied: ${err//$'\n'/; }"
  while IFS='=' read -r key want; do
    key="${key//[[:space:]]/}"; want="${want//[[:space:]]/}"
    [[ -z "$key" || "$key" == \#* ]] && continue
    if [[ ! -e "/proc/sys/${key//./\/}" ]]; then
      absent+=" $key"
      continue
    fi
    n=$(( n + 1 ))
    got="$(sysctl -n "$key" 2>/dev/null || echo unreadable)"
    [[ "$got" == "$want" ]] || bad+=" $key=$got"
  done <<< "$content"
  if [[ -n "$bad" ]]; then
    warn "not in effect:$bad"
    harden_note Kernel "$n settings, some not in effect:$bad"
    return 1
  fi
  say "$( ((changed)) && echo "written and applied" || echo "unchanged" ): $n settings in effect (redirects and source routes off, strict rp_filter, protected links, kptr/dmesg restricted, no unprivileged BPF)${absent:+; not in this kernel:$absent}"
  harden_note Kernel "$n sysctl settings in effect${absent:+ (not in this kernel:$absent)}"
}

# ---- time -----------------------------------------------------------------------
harden_time() {
  step "Time sync"
  local s active="" synced
  for s in chrony chronyd systemd-timesyncd ntpsec ntp openntpd; do
    if systemctl is-active --quiet "$s" 2>/dev/null; then active="$s"; break; fi
  done
  if [[ -z "$active" ]]; then
    if systemd-detect-virt --quiet --container 2>/dev/null; then
      say "in a container: the host keeps the clock"
      harden_note Time "container, the host's clock"
      return 0
    fi
    if ! systemctl cat systemd-timesyncd.service >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends systemd-timesyncd >/dev/null \
        || warn "could not install systemd-timesyncd"
    fi
    systemctl enable --now systemd-timesyncd >/dev/null 2>&1 || true
    systemctl is-active --quiet systemd-timesyncd && active=systemd-timesyncd
  fi
  if [[ -z "$active" ]]; then
    warn "no time sync service runs; TLS and logins need a correct clock (apt-get install chrony)"
    harden_note Time "NO time sync"
    return 1
  fi
  synced="$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)"
  say "$active active, synchronized: $synced"
  harden_note Time "$active (synchronized: $synced)"
}

# ---- all of it ------------------------------------------------------------------
harden_host() {
  if (( ! HARDEN )); then
    # --no-harden: every area as if its own --no-harden-* flag was given.
    HARDEN_SSH=0 HARDEN_UPDATES=0 HARDEN_DOCKER=0 HARDEN_FAIL2BAN=0 HARDEN_RESOLVER=0 HARDEN_SYSCTL=0
  fi
  local s
  # Docker first: it needs the stack state from the health check that just ran. SSH
  # last, so its note is the last thing before the summary.
  for s in harden_docker_daemon harden_updates harden_fail2ban harden_resolver harden_sysctl harden_time harden_ssh; do
    if (( ! HARDEN )) && [[ "$s" == harden_time ]]; then continue; fi
    "$s" || warn "the step above did not finish cleanly; the rest goes on"
  done
}
