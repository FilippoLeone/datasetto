<img width="1918" height="946" alt="image" src="https://github.com/user-attachments/assets/4fb05e34-bf73-4565-a85c-e51144aec7fb" />

# 🎮 Datasetto

A modern, self-hosted streaming platform with RTMP streaming, voice chat, and text chat.

[![Docker](https://img.shields.io/badge/Docker-Ready-blue)](https://www.docker.com/)
[![Node.js](https://img.shields.io/badge/Node.js-20+-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)

**Perfect for small self-hosted communities**

## ✨ Features

### Core Features
- 🎮 **RTMP Streaming** - OBS integration with HLS playback (inline theater mode + popout window)
- 🎤 **WebRTC Voice Chat** - P2P voice communication with echo cancellation & noise suppression
- 💬 **Text Chat** - Real-time messaging with per-channel history (100 messages in-memory)
- 🎬 **Video Player Controls** - Play/pause, volume, fullscreen, keyboard shortcuts (Space/F/M/C/Arrows)
- 👥 **Multi-Channel** - Separate text, voice, and stream channels 
- 🔐 **Role System** - Superuser, admin, moderator, streamer, and user roles
- 📱 **Responsive Design** - Mobile-friendly interface
---

## 🚀 Quick Start

### Local Development

```bash
cd ops
docker compose up -d
```

### Production Deployment

#### VPS Deployment (Ubuntu/Debian)
```bash
chmod +x deploy-vps.sh
sudo ./deploy-vps.sh
```

#### GCP Deployment
```bash
chmod +x deploy-gcp.sh
./deploy-gcp.sh
```

#### Manual Deployment
```bash
# 1. Install Docker
curl -fsSL https://get.docker.com | sudo sh
sudo apt install -y docker-compose-plugin

# 2. Clone/upload your code
cd /opt/datasetto

# 3. Configure environment
cd ops
cp .env.example .env
nano .env  # Edit SERVER_URL, HLS_BASE_URL, SUPERUSER_SECRET

# 4. Deploy
docker compose -f docker-compose.prod.yml up -d
```

**Server Requirements (few users + streamer):**
- 2 vCPU, 2-4GB RAM, 10-40GB SSD

---

## 🏗️ Architecture

**Stack:** nginx-rtmp → Node.js (Express + Socket.IO) → TypeScript (Vite + HLS.js + WebRTC)
---

## 🖥️ Desktop App (Electron)

Prefer a native-feeling desktop window? Check out the new Electron workspace under `desktop/`.

```bash
cd desktop
npm install
npm run dev     # launches Vite + Electron side-by-side
npm run build   # packages production installers (requires client build)
```

See `desktop/README.md` for full details on development and packaging.

---

## 🎮 How to Use

### 1. Stream with OBS
1. Open OBS Studio → Settings → Stream
2. **Service:** Custom
3. **Server:** `rtmp://YOUR_SERVER/hls`
4. **Stream Key:** Get from web interface (e.g., `main-stream+ABC123xyz456...`)
5. Start Streaming

### 2. Watch & Chat
1. Open web interface
2. Enter your display name
3. Click on a stream channel (📺)
4. Click "Theater Mode" to watch inline or "Pop Out" for resizable window
5. Use chat to talk with viewers

### 3. Voice Chat
1. Click on a voice channel (🔊)
2. Click "Join Voice"
3. Adjust settings in the sidebar:
   - Mute/Deafen controls
   - Push-to-talk (optional)
   - Echo cancellation, noise suppression
   - Mic/speaker device selection

### Video Player Controls
- **Space/K** - Play/Pause
- **F** - Fullscreen
- **M** - Mute/Unmute
- **C** - Toggle Chat
- **↑/↓** - Volume ±10%

---

### Firewall Ports
```bash
sudo ufw allow 80,443/tcp    # HTTP/HTTPS (includes HLS)
sudo ufw allow 1935/tcp      # RTMP
sudo ufw allow 4000/tcp      # Backend API
```

---

### Monitoring
```bash
# View logs
docker compose -f ops/docker-compose.prod.yml logs -f

# Resource usage
docker stats

# Check stream health
curl http://localhost/hls/CHANNEL_NAME.m3u8
```

### Backup & Updates
```bash
# Backup environment
cp /opt/datasetto/ops/.env ~/backup/.env.backup

# Update application
cd /opt/datasetto
git pull
docker compose -f ops/docker-compose.prod.yml build --no-cache
docker compose -f ops/docker-compose.prod.yml up -d
```

---

## 📄 License

 GNU AGPLv3 - See root LICENSE file

---

## 🚀 Ready to Deploy?

```bash
# Quick production deployment on Ubuntu/Debian VPS
chmod +x deploy-vps.sh
sudo ./deploy-vps.sh

# Or for Google Cloud Platform
chmod +x deploy-gcp.sh
./deploy-gcp.sh
```