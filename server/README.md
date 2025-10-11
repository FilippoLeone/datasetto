# 🚀 Datasetto Backend

Modern, modular Node.js backend for Datasetto with WebSocket (Socket.IO) and REST API support.

## ✨ Features

### Architecture
- **Modular Design** - Organized into models, services, utils, and configuration layers
- **Type Safety** - ES6 modules with proper encapsulation
- **Separation of Concerns** - Clear boundaries between business logic and transport
- **Production Ready** - Error handling, logging, rate limiting, and monitoring

### Core Features
- 🔌 **WebSocket Real-time Communication** - Socket.IO with automatic reconnection
- 📡 **REST API Endpoints** - Health checks, stats, and management APIs
- 👤 **User Management** - Registration, authentication, roles, and permissions
- 💬 **Channel System** - Text, voice, and stream channels with groups
- 📝 **Message History** - In-memory chat history with rate limiting
- 🧠 **Pluggable Message Store** - Memory-first with optional JSON persistence
- 🎥 **Stream Management** - Secure stream keys, live status tracking
- 🔐 **Role-Based Access Control** - Superuser, admin, moderator, streamer, user roles
- 📊 **Monitoring** - Built-in stats, health checks, and structured logging
- 🛡️ **Security** - Rate limiting, input validation, connection limits

## 📁 Project Structure

```
server/
├── src/
│   ├── config/
│   │   └── index.js           # Configuration management
│   ├── models/
│   │   ├── ChannelManager.js  # Channel operations
│   │   ├── UserManager.js     # User operations
│   │   └── MessageManager.js  # Message operations
│   ├── utils/
│   │   ├── helpers.js         # Utility functions
│   │   └── logger.js          # Logging utility
│   └── index.js               # Main server entry point
├── .env.example               # Environment variables template
├── package.json
└── README.md                  # This file
```

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd server
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
nano .env  # Edit configuration
```

**Important:** Change `SUPERUSER_SECRET` to a secure value:
```bash
openssl rand -base64 32
```

### 3. Start Server

**Development (with auto-reload):**
```bash
npm run dev
```

**Production:**
```bash
npm start
```

The server will start on `http://localhost:4000` (or your configured PORT).

## ⚙️ Configuration

All configuration is managed through environment variables. See `.env.example` for all available options.

### Essential Configuration

```bash
# Security - MUST change in production
SUPERUSER_SECRET=your-secure-secret-here

# Server
PORT=4000
NODE_ENV=production

# CORS - Allow your frontend domain
CORS_ORIGIN=https://yourdomain.com

# Streaming
HLS_PATH=/tmp/hls
HLS_BASE_URL=http://yourdomain.com/hls
```

### Security Configuration

```bash
# Rate limiting
RATE_LIMIT_WINDOW_MS=60000          # 1 minute window
RATE_LIMIT_MAX_REQUESTS=100         # Max 100 requests per window
MAX_CONNECTIONS_PER_IP=10           # Max concurrent connections per IP

# Message limits
MAX_MESSAGES_PER_MINUTE=30          # Max messages per user per minute
MAX_MESSAGE_LENGTH=1000             # Max characters per message
```

### Channel Configuration

```bash
MAX_CHANNELS=50                     # Maximum channels
MAX_USERS_PER_CHANNEL=50            # Maximum users per channel
MAX_MESSAGES_PER_CHANNEL=100        # Message history per channel
```

### Storage Configuration

```bash
# Select the message store driver: memory (default) or file
MESSAGE_STORE_DRIVER=memory

# When using the file driver, define where JSON snapshots are saved
MESSAGE_STORE_PATH=./storage/messages.json

# Debounce window (ms) before flushing to disk when using file driver
MESSAGE_STORE_FLUSH_DEBOUNCE_MS=500
```

> **Tip:** The default `memory` driver keeps all chat history in RAM and wipes it automatically
> whenever the process restarts or you redeploy. Switching to the `file` driver preserves
> messages across restarts while keeping the same API.

## 📡 API Endpoints

### Health Check
```bash
GET /health
```

**Response:**
```json
{
  "status": "healthy",
  "uptime": 12345.67,
  "timestamp": 1696502400000,
  "env": "production"
}
```

### Statistics
```bash
GET /api/stats
```

**Response:**
```json
{
  "channels": 10,
  "users": 25,
  "messages": 1500,
  "uptime": 12345.67,
  "memory": { ... },
  "timestamp": 1696502400000
}
```

## 🔌 Socket.IO Events

### Client → Server Events

#### User Management
- `register` - Register user with username
- `auth:superuser` - Authenticate as superuser

#### Channel Operations
- `channel:join` - Join a text/stream channel
- `voice:join` - Join a voice channel
- `voice:leave` - Leave voice channel

#### Messaging
- `chat` - Send chat message
- `chat:delete` - Delete a message (moderators+)

#### Streaming
- `stream:getKey` - Get stream key for channel
- `stream:regenerateKey` - Regenerate stream key (admin+)

#### WebRTC Signaling
- `voice:signal` - Forward WebRTC signaling data

### Server → Client Events

#### System
- `registered` - User registration confirmation with initial data
- `error` - Error message with code
- `auth:success` - Authentication successful

#### Channels
- `channels:update` - Channel list updated
- `channel:joined` - Successfully joined channel

#### Users
- `user:update` - User list updated for channel

#### Messaging
- `chat` - New chat message
- `chat:history` - Message history on channel join
- `chat:messageDeleted` - Message was deleted

#### Voice
- `voice:joined` - Successfully joined voice channel
- `voice:peer-join` - New peer joined voice channel
- `voice:peer-leave` - Peer left voice channel
- `voice:signal` - WebRTC signaling data

#### Streaming
- `stream:key` - Stream key for channel

## 🎭 Role System

### Role Hierarchy (highest to lowest)

1. **Superuser** - Full system access
2. **Admin** - Manage channels, users, moderate
3. **Moderator** - Moderate messages, create channels
4. **Streamer** - Can stream to assigned channels
5. **User** - Basic chat and voice access

### Permissions Matrix

| Permission | Superuser | Admin | Moderator | Streamer | User |
|------------|-----------|-------|-----------|----------|------|
| Create Channels | ✅ | ✅ | ✅ | ❌ | ❌ |
| Delete Channels | ✅ | ✅ | ❌ | ❌ | ❌ |
| Edit Channels | ✅ | ✅ | ❌ | ❌ | ❌ |
| Manage Users | ✅ | ✅ | ❌ | ❌ | ❌ |
| Assign Roles | ✅ | ❌ | ❌ | ❌ | ❌ |
| Regenerate Keys | ✅ | ✅ | ❌ | ❌ | ❌ |
| Stream Anywhere | ✅ | ✅ | ❌ | ❌ | ❌ |
| Moderate | ✅ | ✅ | ✅ | ❌ | ❌ |
| View All Keys | ✅ | ✅ | ❌ | ❌ | ❌ |
| Delete Any Message | ✅ | ✅ | ✅ | ❌ | ❌ |
| Ban Users | ✅ | ✅ | ❌ | ❌ | ❌ |
| View Logs | ✅ | ❌ | ❌ | ❌ | ❌ |

## 📊 Logging

The server uses a custom logger with multiple log levels:

- **error** - Critical errors
- **warn** - Warnings
- **info** - Informational messages (default)
- **debug** - Detailed debugging information
- **trace** - Very verbose tracing

### Log Configuration

```bash
# Set log level
LOG_LEVEL=info              # error|warn|info|debug|trace

# Log format
LOG_FORMAT=json             # json|pretty

# Output
LOG_CONSOLE=true            # Console logging
LOG_FILE=false              # File logging (optional)
LOG_FILE_PATH=./logs        # Log file directory
```

### Example Logs

**Development (pretty format):**
```
2025-10-05T12:00:00.000Z INFO  🚀 Datasetto Server started
2025-10-05T12:00:05.123Z INFO  User connected: Alice {"userId":"abc123"}
2025-10-05T12:00:06.456Z DEBUG User Alice joined channel general
```

**Production (JSON format):**
```json
{"timestamp":"2025-10-05T12:00:00.000Z","level":"INFO","message":"Server started","port":4000}
{"timestamp":"2025-10-05T12:00:05.123Z","level":"INFO","message":"User connected","userId":"abc123"}
```

## 🛡️ Security Features

### Input Validation
- Username validation (2-32 characters, sanitized)
- Channel name validation (2-32 characters, alphanumeric + hyphen/underscore)
- Message validation (max length, sanitization)
- XSS protection (strip dangerous characters)

### Rate Limiting
- Connection limits per IP
- Message rate limits per user (30 messages/minute default)
- API rate limiting on REST endpoints

### Authentication
- Superuser secret authentication
- Role-based permissions
- User banning system with expiration support

### Stream Key Security
- Secure random generation (24 alphanumeric characters)
- Format: `channelName+ABC123xyz456...`
- Permission-based access control

## 🔧 Maintenance

### View Logs
```bash
npm run dev  # Auto-reloads on changes
```

### Monitor Stats
```bash
curl http://localhost:4000/api/stats
```

### Check Health
```bash
curl http://localhost:4000/health
```

## 🐛 Troubleshooting

### Server Won't Start

**Check port availability:**
```bash
# Windows
netstat -an | findstr :4000

# Linux/Mac
lsof -i :4000
```

**Check environment variables:**
```bash
# Verify .env file exists and is readable
cat .env
```

### High Memory Usage

The in-memory stores will grow with usage. Limits:
- **Messages:** 100 per channel × number of channels
- **Users:** Active connections only
- **Rate Limits:** Cleaned up every minute

**Monitor memory:**
```bash
# Check stats endpoint
curl http://localhost:4000/api/stats | jq '.memory'
```

### Connection Issues

**Check CORS:**
```bash
# Verify CORS_ORIGIN matches your frontend URL
echo $CORS_ORIGIN
```

**Check firewall:**
```bash
# Ensure port 4000 is open
sudo ufw status
```

## 📝 Development

### Code Style
- ES6 modules with `import/export`
- Async/await for asynchronous operations
- Descriptive variable and function names
- JSDoc comments for complex functions
- Error handling with try/catch
- Structured logging for debugging

### Adding New Features

1. **Models** - Add data management in `src/models/`
2. **Utils** - Add helpers in `src/utils/`
3. **Config** - Add settings in `src/config/`
4. **Socket Events** - Add handlers in `src/index.js`
5. **REST Routes** - Add endpoints in Express app

### Testing

```bash
# Start in development mode
npm run dev

# Use the old backend for comparison
npm run start:old
```

## 📄 License

MIT License - See root LICENSE file

## 🎉 Migration from Old Backend

The new modular backend is backward-compatible with the old `index.js`. Key improvements:

- ✅ Cleaner code organization
- ✅ Better error handling
- ✅ Comprehensive logging
- ✅ Input validation
- ✅ Rate limiting built-in
- ✅ Easier to extend and maintain
- ✅ Production-ready configuration
- ✅ Health and stats monitoring

To migrate:
```bash
# Install new dependencies
npm install dotenv

# Create .env file
cp .env.example .env

# Update scripts (already done in package.json)
# Run new backend
npm start
```

---

**Ready to go!** 🚀

For questions or issues, check the logs with `LOG_LEVEL=debug`.
