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
  rtmp/                     nginx-rtmp image: OBS ingest -> HLS
  turn/entrypoint.sh        coturn settings (ephemeral credentials)
  gcp/                      create-vm.sh, deploy.sh, destroy.sh, VM-side startup/update/backup
```

```
Internet
  |-- 80/443 ----> web (Caddy) --/api,/socket.io,/health--> app (Node, SQLite in volume app_data)
  |                          \--/hls/*------------------> rtmp (nginx-rtmp, HLS in RAM)
  |-- 1935 ------> rtmp  (OBS publish; key checked by app via /internal/stream/publish)
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
   - `PUBLIC_RTMP_URL=rtmp://chat.example.com/live`
   - optional TURN: `COMPOSE_PROFILES=turn`, `TURN_SECRET`, `TURN_REALM`, `TURN_URLS=turn:chat.example.com:3478`
2. Create the VM (idempotent):
   ```bash
   BUDGET_AMOUNT=15EUR BACKUP_BUCKET=datasetto-backups-<something-unique> ops/gcp/create-vm.sh
   ```
   This enables the Compute API, opens 80/443/1935 (and TURN ports when enabled),
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

## Cost (europe-west1, approximate, October 2026 list prices)

| Item | Monthly |
| --- | --- |
| e2-micro VM, 730 h | about 7 EUR |
| 10 GB pd-balanced boot disk | about 1 EUR |
| External IPv4 address in use (ephemeral or static) | about 3 EUR |
| Egress, Standard tier, around 0.08 EUR/GB | 2 to 4 EUR for 25 to 50 GB |
| Cloud Logging, GCS backups (a few MB) | 0 |

Total: roughly 13 to 15 EUR with a few streaming evenings a month. Chat, voice
and screenshare cost nearly nothing in egress because media is peer to peer.
Streaming is the only variable: every viewer downloads the full stream bitrate
from the VM, so a 4 Mbps stream watched by 4 people for 2 hours is about 14 GB.
Keep OBS at 2500 to 4000 kbps and the bill stays inside the budget.

Alternative within the Always Free tier: `REGION=us-central1 ZONE=us-central1-a
ops/gcp/create-vm.sh` makes the VM itself free (one e2-micro per month in
us-west1/us-central1/us-east1, 30 GB standard disk, 1 GB egress). Only the IP
address and egress are billed, roughly 4 to 7 EUR, at the price of 100 ms
extra latency to Europe for signaling (voice still goes peer to peer). Verify
current prices in the Google Cloud pricing calculator before relying on these
numbers.

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
- **Firewall**: only 80, 443, 1935 and (optionally) TURN ports are open. The
  `/internal/*` stream callbacks are not routed by Caddy and are reachable only
  from the Docker network.
