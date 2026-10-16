# Operations

Everything needed to run Datasetto: locally with Docker, and on one small
Google Cloud VM for roughly 10 to 15 EUR a month.

## Layout

```
ops/
  docker-compose.yml        the stack (web, app, rtmp, optional turn)
  docker-compose.local.yml  overrides for http://localhost:8080
  .env.example              configuration template -> copy to .env
  caddy/                    web image: builds the client, serves it with Caddy, TLS, reverse proxy
  rtmp/                     nginx-rtmp image: OBS ingest (RTMP, RTMPS) -> HLS
  turn/entrypoint.sh        coturn settings (ephemeral credentials)
  gcp/                      create-vm.sh, deploy.sh, destroy.sh, VM-side startup/update/backup
```

```
Internet
  |-- 80/443 ----> web (Caddy) --/api,/socket.io,/health--> app (Node, SQLite in volume app_data)
  |                          \--/hls/*------------------> rtmp (nginx-rtmp, HLS in RAM)
  |-- 1935 ------> rtmp  (OBS publish, plain RTMP; key checked by app via /internal/stream/publish)
  |-- 1936 ------> rtmp  (OBS publish over TLS: nginx stream module with Caddy's certificate -> 1935)
  '-- 3478 + UDP range ----> turn (coturn, host network, only with COMPOSE_PROFILES=turn)
```

Voice, camera and screenshare media go peer to peer over WebRTC; the server
only signals. TURN is a fallback relay for friends behind strict NATs.

## Run locally

```bash
cp ops/.env.example ops/.env          # set REGISTRATION_MODE=open for a quick local test
docker compose -f ops/docker-compose.yml -f ops/docker-compose.local.yml up --build -d
```

Open <http://localhost:8080/app>, register (the first account is admin), open a
second browser profile to see presence and chat. Stream to it with OBS or ffmpeg:

```bash
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 \
  -t 60 -c:v libx264 -preset veryfast -b:v 2500k -g 60 -c:a aac -f flv "rtmp://localhost/live/main-stream?key=<TOKEN>"
```

The stream key shown in the channel's key dialog is `main-stream?key=<TOKEN>`:
nginx-rtmp keeps `main-stream` as the stream name and hands `key` to the app for
validation, so playback URLs (`/hls/main-stream/index.m3u8`) never contain the token.

Client development with hot reload against the Docker stack:

```bash
cd client && npm install && npm run dev      # http://localhost:5173, proxies /api,/socket.io,/hls to :8080
```

Server development without Docker:

```bash
cd server && npm install && cp .env.example .env && npm run dev   # http://localhost:4000
npm test
```

## Streaming: RTMP and RTMPS

OBS publishes to the `rtmp` container, which asks the app whether the key is
valid and remuxes the stream to HLS. Two ingest ports are open:

| Port | OBS server URL | Use |
| --- | --- | --- |
| 1936 | `rtmps://chat.example.com:1936/live` | Default in the key dialog (`PUBLIC_RTMP_URL`). TLS, so the stream key never crosses the internet in clear. |
| 1935 | `rtmp://chat.example.com/live` | Plain RTMP: the local stack, machines on the server's own LAN, encoders without TLS. |

RTMPS reuses the certificate Caddy obtains for `SITE_ADDRESS`. The `caddy_data`
volume is mounted read-only into the rtmp container at `/caddy`, and
`ops/rtmp/entrypoint.sh` copies the newest
`/caddy/caddy/certificates/<issuer>/<host>/<host>.crt` + `.key` pair for that
host to `/etc/nginx/certs` (Caddy keeps them root-only, which is why the
entrypoint starts as root; nginx itself runs as the `nginx` user). It then
writes the TLS listener to `/etc/nginx/rtmps/rtmps.conf`: nginx's `stream`
module, TLS 1.2+, forwarding to the rtmp server over loopback with a PROXY
protocol header so the publisher's real address still reaches the logs and the
app's rate limiter. Without a certificate (`SITE_ADDRESS=:80`, or the first
minutes after a deploy while Caddy waits for DNS) the listener is left out:
nginx starts normally and only plain RTMP answers. The entrypoint re-checks
every 10 minutes (`RTMPS_CERT_CHECK_SECONDS`) and reloads nginx when the
certificate appears or Let's Encrypt renews it, so nothing ever needs a restart.
An existing GCP VM needs the new firewall rule: re-run `ops/gcp/create-vm.sh` once
(idempotent, it only adds what is missing) before `ops/gcp/deploy.sh`.

OBS verifies the certificate like a browser does, so RTMPS needs the real
certificate of a deployed server. To exercise the TLS path on the local stack,
put a self-signed pair where Caddy would keep one, start the rtmp container with
that host and publish with ffmpeg (which can skip verification):

```bash
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 7 \
  -subj /CN=localhost -keyout localhost.key -out localhost.crt
for f in crt key; do
  docker run --rm -i -v datasetto_caddy_data:/data alpine sh -c \
    "mkdir -p /data/caddy/certificates/local/localhost && cat > /data/caddy/certificates/local/localhost/localhost.$f" < localhost.$f
done
SITE_ADDRESS=localhost docker compose -f ops/docker-compose.yml -f ops/docker-compose.local.yml up -d rtmp
docker compose -f ops/docker-compose.yml -f ops/docker-compose.local.yml logs rtmp | grep RTMPS   # "RTMPS on 1936 with certificate ..."
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i sine=frequency=440 -t 30 \
  -c:v libx264 -preset veryfast -b:v 2500k -g 60 -c:a aac -tls_verify 0 \
  -f flv "rtmps://localhost:1936/live/main-stream?key=<TOKEN>"
```

`docker compose ... up -d rtmp` without `SITE_ADDRESS=localhost` puts the
container back to plain RTMP only.

## Deploy to Google Cloud

Prerequisites: `gcloud` authenticated, a project with billing (the scripts default
to project `datasetto`), a domain you control, and Docker images published by
the GitHub Actions workflow (`.github/workflows/images.yml`, pushed to GHCR on
every push to `main`).
After the first workflow run, set the three `datasetto-*` packages to public
(GitHub profile > Packages > package > Package settings > Change visibility) so the
VM can pull them without credentials. If a pull fails, the startup script falls
back to building the images on the VM, which is slow on an e2-micro but works
thanks to the swap file.

1. Fill in `ops/.env`:
   - `SITE_ADDRESS=chat.example.com`, `CORS_ORIGINS=https://chat.example.com`
   - `REGISTRATION_MODE=invite` and a long `REGISTRATION_INVITE_CODE`
   - `ADMIN_EMAILS=you@example.com`
   - `PUBLIC_RTMP_URL=rtmps://chat.example.com:1936/live` (see "Streaming: RTMP and RTMPS")
   - optional TURN: `COMPOSE_PROFILES=turn`, `TURN_SECRET`, `TURN_REALM`, `TURN_URLS=turn:chat.example.com:3478`
2. Create the VM (idempotent):
   ```bash
   BUDGET_AMOUNT=15EUR BACKUP_BUCKET=datasetto-backups-<something-unique> ops/gcp/create-vm.sh
   ```
   This enables the Compute API, opens 80/443/1935/1936 (and TURN ports when enabled),
   creates an `e2-micro` in `europe-west1` with a 10 GB balanced disk on the
   Standard network tier, and passes `ops/.env` to the VM as instance metadata.
   The startup script installs Docker, adds 2 GB swap, clones the repo and runs
   `docker compose up -d`. Optionally it creates a billing budget with alerts at
   50/90/100 percent and a 30-day-lifecycle backup bucket.
3. Point a DNS `A` record for your domain at the printed IP. Caddy fetches a
   Let's Encrypt certificate on the first request.
4. Open `https://chat.example.com/app`, register with your admin email.

Updates after a push to `main` (new images on GHCR): `ops/gcp/deploy.sh`.
It re-sends `ops/.env`, then on the VM pulls the git ref, pulls images and
recreates changed containers. Rollback by setting `IMAGE_TAG=<commit sha>` in
`ops/.env` and running `deploy.sh` again.

Useful commands:

```bash
gcloud compute ssh datasetto --zone europe-west1-b                       # shell on the VM
gcloud compute ssh datasetto --zone europe-west1-b -- \
  'cd /opt/datasetto/ops && sudo docker compose ps && sudo docker compose logs --tail 100'
sudo tail -f /var/log/datasetto-startup.log                              # first boot progress (on the VM)
ops/gcp/destroy.sh                                                       # delete VM + firewall rules
```

## Cost (europe-west1, list prices read from the Cloud Billing catalog on 2026-10-16)

| Item | Monthly |
| --- | --- |
| e2-micro VM, 730 h (0.25 vCPU at 0.0211 EUR/h + 1 GiB at 0.0028 EUR/h) | 5.92 EUR |
| 10 GB pd-balanced boot disk (0.088 EUR/GB) | 0.88 EUR |
| External IPv4 address in use (Google lists 0.005 USD/h) | about 3.40 EUR |
| Egress, Standard tier: first 200 GB per month free, then about 0.075 EUR/GB | 0 EUR up to 200 GB |
| Cloud Logging, GCS backups (a few MB) | about 0 |

Fixed total: about 10.20 EUR per month. Ingress (OBS uploading, people talking)
is free. Chat, voice and screenshare cost nothing in egress because media goes
peer to peer; the optional TURN relay is the only exception and is capped (see
below). Streaming is the one variable: every viewer downloads the publisher's
bitrate from the VM.

| OBS bitrate | Per viewer-hour | 4 viewers, 2 h session | Sessions per month inside the free 200 GB |
| --- | --- | --- | --- |
| 2500 kbps | 1.1 GB | 9 GB | about 22 |
| 4000 kbps | 1.8 GB | 14 GB | about 14 |
| 6000 kbps (the default cap) | 2.7 GB | 22 GB | about 9 |

Above the free allowance, each extra 4-viewer 2-hour session at 4000 kbps costs
about 1.10 EUR. With the default guards the bill cannot run away: the app stops
streaming at `STREAM_MONTHLY_EGRESS_GB` (150, inside the free allowance), and
the VM throttles everything at `EGRESS_SOFT_LIMIT_GB` (190) and stops the
stream and relay containers at `EGRESS_HARD_LIMIT_GB` (230). Worst case the
egress line is 30 GB x 0.075 EUR, so the monthly bill stays under about 13 EUR
even if someone tries to abuse the server.

Cheapest option: `REGION=us-central1 ZONE=us-central1-a ops/gcp/create-vm.sh`.
The Always Free tier covers one e2-micro and a 30 GB standard disk in
us-west1, us-central1 and us-east1, and the 200 GB Standard tier egress
allowance applies there too, so only the IP address is billed: about 3.50 EUR
per month. The price is 100 ms more latency to Europe for signalling; voice
still goes peer to peer. Check the Google Cloud pricing calculator before
relying on any of these numbers.

## Keeping the bill small: abuse protection

Everything that can cost money is gated or capped. The knobs live in
`ops/.env` (see `.env.example`, "cost controls").

- **Nothing anonymous reaches media.** HLS playlists and segments are only
  served to viewers holding a signed ticket: Caddy asks the app
  (`/internal/hls/auth`) on every request, and tickets are issued to signed-in
  accounts that may view the channel, bound to that channel, and expire after
  10 minutes (the player renews them). A leaked stream URL serves nothing.
- **Viewer cap.** `STREAM_MAX_VIEWERS` (10) tickets per live stream; beyond that
  the player shows "stream is full".
- **Bitrate cap.** The app polls nginx-rtmp every 15 s and drops a publisher
  that sends more than `STREAM_MAX_BITRATE_KBPS` (6000) twice in a row, with a
  toast in the channel telling them to lower it in OBS.
- **Monthly budget.** The app estimates egress as publisher bitrate x viewers
  and stores it per month in SQLite. At `STREAM_MONTHLY_EGRESS_GB` (150) it
  drops publishers, refuses new publishes and stops issuing tickets until the
  next month.
- **VM backstop.** `ops/gcp/egress-guard.sh` runs from a systemd timer every
  5 minutes, counts bytes sent on the public interface per month, shapes all
  egress to 1 Mbit/s at `EGRESS_SOFT_LIMIT_GB` and stops the rtmp and turn
  containers at `EGRESS_HARD_LIMIT_GB`. It lifts both automatically on the
  first run of the next month. `datasetto-egress-guard --status` prints the
  month-to-date figure; `/var/log/datasetto-egress.log` has the history.
- **RTMP.** Only publishers with a valid `channel?key=token` get through
  (`on_publish` callback); nobody can pull RTMP; idle publishers are dropped
  after 10 s; at most 32 connections and 16 streams; publish attempts are rate
  limited per IP. The stat and control endpoints are not reachable from outside.
- **TURN.** Credentials are only sent to signed-in users over the socket (the
  public `/api/config` carries STUN only) and expire after 12 h. coturn is
  capped at 1.5 Mbit/s per session, 20 Mbit/s in total, 40 sessions, 6 per
  user, and refuses to relay to private, link-local and metadata addresses.
- **HTTP and sockets.** Helmet headers, strict CORS, 256 KB JSON bodies, 256 KB
  socket messages, 20 sockets per IP, 300 API requests per IP per minute, and
  per-event buckets for chat, signalling, games and auth. Registration is
  invite-only by default.
- **VM.** Standard network tier, no public SSH: port 22 is only open to the
  Identity-Aware Proxy range (`gcloud compute ssh --tunnel-through-iap`),
  unattended security upgrades, a billing budget with alerts, and only ports
  80/443/1935/1936 (plus 3478 and the relay range with the `turn` profile) open.

What this does not do: it will not stop a determined volumetric attack from
saturating the VM's link (that costs you nothing extra, ingress is free) or
from making the site slow while it lasts. If that ever matters, put Cloudflare
in front of ports 80/443; RTMP and TURN would stay direct.

## Operations notes

- **Data**: a single SQLite file at `/data/datasetto.db` in the `app_data`
  volume (accounts, sessions, channels, messages, bans, leaderboards). Backups:
  `/etc/cron.daily/datasetto-backup` writes a consistent copy to
  `/var/backups/datasetto` and, when configured, to the GCS bucket.
  Restore: stop the stack, copy the file over the volume's `datasetto.db`, start.
- **Importing the old JSON stores**: `cd server && npm run import-legacy -- /path/to/old/storage`
  (reads `accounts.json` and `messages.json`; password hashes carry over).
- **Secrets**: `ops/.env` lives on your machine and in instance metadata (visible
  to anyone with project access). Rotate `REGISTRATION_INVITE_CODE` and
  `TURN_SECRET` by editing `.env` and running `deploy.sh`.
- **Logs**: `docker compose logs` on the VM (JSON lines, rotated at 3 x 10 MB per
  container). Set `LOG_LEVEL=debug` in `.env` for socket-level detail.
- **Memory**: the compose file caps containers (web 128 MB, app 320 MB, rtmp 192 MB,
  turn 96 MB) so a leak cannot take the 1 GB VM down; the swap file covers image
  pulls. Move to `MACHINE_TYPE=e2-small` if voice rooms get large.
- **Firewall**: only 80, 443, 1935, 1936 and (optionally) TURN ports are open. The
  `/internal/*` stream callbacks are not routed by Caddy and are reachable only
  from the Docker network.
