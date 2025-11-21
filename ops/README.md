# 🐳 Operations & Deployment

## 🚀 Quick Deploy (Ubuntu VPS)

```bash
# On VPS
cd ~/rtmp-disc/ops
chmod +x deploy-vps.sh
./deploy-vps.sh
```

Then configure DNS:
1. Point an **A** record (e.g. `app.yourdomain.com`) to your VPS IP for the web UI (can sit behind a CDN)
2. If you want RTMPS behind Cloudflare (or another TLS proxy), create a Spectrum/ TCP proxy for port **1935** (or 443 if you terminate TLS separately) that forwards to your server. Otherwise point a second record (e.g. `rtmp.yourdomain.com`) directly to the VPS and leave the CDN disabled.
3. Visit: https://app.yourdomain.com

**See [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md) for full instructions.**

---

## Docker Compose Configurations

### Development (`docker-compose.yml`)
```bash
docker compose up -d
```

**Services:**
- `rtmp` - nginx-rtmp (port 1935 RTMP, internal HLS on 80)
- `server` - Node.js backend (port 4000)
- `client` - Vite dev server (port 5173)

**Access:** http://localhost:5173

### Production (`docker-compose.prod.yml`)
```bash
docker compose -f docker-compose.prod.yml up -d
```

- `turn` - self-built coturn relay (TCP/UDP 3478, UDP media relay range)
- `rtmp` - nginx-rtmp with custom build (RTMP on 1935, internal HLS on 80)
- `server` - Node.js with resource limits (4000)
- `client` - nginx serving static build (8081)

**Performance defaults:** On a 1 GB / 2‑core host, the RTMP container owns ~768 MB RAM and 1.4 vCPUs, while the supporting services stay tiny. If you upgrade the box you can safely raise the RTMP limits; just avoid starving it on smaller hardware—OBS will report dropped frames if the container runs out of CPU.

**Note:** Port 80 is used by host nginx reverse proxy for path-based routing. When the deployment script runs without a domain, it now sets `CADDY_AUTO_HTTPS="auto_https off"`, so the proxy serves plain HTTP on your LAN instead of forcing an invalid HTTPS cert for raw IPs.

**Multi-arch builds:** Both the `rtmp` (custom nginx-rtmp) and `turn` (coturn) images are now built locally, so `docker compose build --pull` works on either `linux/amd64` or `linux/arm64`. To publish prebuilt images for mixed clusters, run `docker buildx build --push --platform linux/amd64,linux/arm64 ...` inside the `ops/` directory and point the compose services at your registry tags.

## Configuration Files

- `nginx-rtmp.conf` - RTMP server configuration (transcoding, HLS settings)
- `nginx.dev.conf` - Development nginx config
- `nginx.conf` - Production nginx config (reverse proxy)
- `.env.example` - Environment variables template

## Useful Commands

```bash
# View logs
docker compose logs -f

# Restart services
docker compose restart

# Rebuild and restart
docker compose up --build -d

# Stop all services
docker compose down

# Check status
docker compose ps

# Monitor resources
docker stats
```

## 🎥 Streaming Performance Tips

- **OBS encoder settings**: Target a 2-second keyframe interval, constant bitrate (CBR), and a bitrate your uplink can sustain (e.g. 3500–5000 Kbps for 720p60, 6000 Kbps for 1080p60). Keep B-frames ≤ 2 and enable “Network Optimizations” (OBS 31+).
- **Monitor the stat endpoint**: Visit `http://your-server/stat` to confirm `bw_in` stays below your encoder bitrate and that GOP cache remains populated.
- **Container resources**: On a 1 GB / 2‑core VPS, leave the RTMP service at ~768 MB RAM and ~1.4 CPU, keeping the other services near 0.3 CPU and below. For bigger machines you can bump `deploy.resources.limits` in `docker-compose.prod.yml` (CPU/RAM) or isolate RTMP on a dedicated core when chasing jitter.
- **Disk vs RAM**: HLS chunks now live in RAM for low latency. If you need persistence for debugging, replace the `tmpfs` entry with a bind mount to fast SSD storage.

## Environment Variables

See `.env.example` for all available options. Key variables:

```bash
SUPERUSER_SECRET=your-secret-here
SERVER_URL=http://YOUR_IP:4000
API_BASE_URL=http://YOUR_IP:4000
HLS_BASE_URL=http://YOUR_IP/hls
```

### Deploying Behind a Domain / Cloudflare

When serving the app at `https://yourdomain.com` you typically want **two DNS records**:

- `app.yourdomain.com` (or root): can sit behind Cloudflare/another CDN and forwards HTTP traffic on port 80.
- `rtmp.yourdomain.com`: points to the RTMP container over **TCP 1935**. If you require TLS termination in front of the server, you can proxy RTMP through a service like Cloudflare Spectrum; otherwise keep it DNS-only and stream directly.

Firewall / networking checklist:

- Open ports **80** and **1935** on the host firewall / cloud security group.
- If you use a managed load balancer, add a TCP listener for 1935 that targets the RTMP container.
- From your laptop run `telnet rtmp.yourdomain.com 1935` (or `nc`) to verify the port is reachable before testing with OBS.

Once networking is set up, export these variables before running the production compose file (either in your shell or an `.env` file):

	```bash
	export SERVER_URL=https://app.yourdomain.com
	export API_BASE_URL=https://app.yourdomain.com
	export HLS_BASE_URL=https://app.yourdomain.com/hls
	export CORS_ORIGIN=https://app.yourdomain.com
	```

- Rebuild the client so that Socket.IO and API calls stay on the same origin (avoids mixed-content issues behind HTTPS proxies).
- Cloudflare forwards WebSocket traffic, so you can keep the orange cloud enabled on the **HTTP** record. For the RTMP record, either enable Spectrum (paid) to proxy TCP 1935 (or 443 if you prefer RTMPS) or leave it grey-clouded to pass traffic directly to the container.

### WebRTC / Voice Connectivity

If users are joining from restrictive networks you will need a TURN relay in addition to the bundled Google STUN servers. The production compose file now ships a `turn` service built from source on Alpine (multi-arch) listening on port **3478** (TCP+UDP) with relay ports **49160-49200/UDP**. Update your firewall or cloud security group to allow those ranges.

1. Copy `.env.example` → `.env` and set:
	- `TURN_REALM`, `TURN_USERNAME`, `TURN_PASSWORD`
	- Optional `TURN_EXTERNAL_IP` if the host sits behind NAT (e.g. cloud provider private IP with public elastic IP)
	- `VITE_TURN_URL`, `VITE_TURN_USERNAME`, `VITE_TURN_CREDENTIAL` (or `VITE_WEBRTC_ICE_SERVERS`) — keep these credentials identical to the TURN values above
2. Bring the stack up: `docker compose -f docker-compose.prod.yml up -d turn`
3. Verify the TURN service answers: `telnet yourdomain.com 3478` (TCP) and `traceroute -U -p 3478 yourdomain.com` (UDP)

Two ways to configure the frontend build (only one is required):

- Provide a full ICE server array as JSON (this overrides the defaults):

	```bash
	export VITE_WEBRTC_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:turn.yourdomain.com:3478","username":"user","credential":"pass"}]'
	```

- Or set the shorthand TURN variables (appends to the default STUN servers):

	```bash
	# Multiple TURN URLs allowed (comma or whitespace separated)
	export VITE_TURN_URL="turn:turn.yourdomain.com:3478 turn:backup.yourdomain.com:3478"
	export VITE_TURN_USERNAME=user
	export VITE_TURN_CREDENTIAL=pass
	```

- When no `transport` query parameter is supplied the client automatically
  adds both UDP and TCP variants, so you only need to list each host once.

Always rebuild the `client` image after changing these values so the generated SDP advertises your TURN relay. After deployment, open `chrome://webrtc-internals` (or Firefox `about:webrtc`) during a call and confirm that `relay` candidates appear and selected ICE servers reference your TURN hostname.

> **Tuning:** The voice service honours `VITE_VOICE_OPUS_*` variables for bitrate/PTIME defaults. Stick with the provided conservative speech profile (64 kbps mono, 20 ms packets) unless you need stereo music streams; higher bitrates demand more TURN bandwidth.
