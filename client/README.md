# Datasetto Client

Modern, modular frontend for Datasetto - A self-hosted streaming and voice collaboration platform with RTMP streaming and WebRTC voice chat.

## 🎯 Features

- **Live Streaming**: Watch RTMP streams via HLS with minimal latency
- **Voice Chat**: WebRTC-powered voice channels with:
  - Push-to-talk or open mic
  - Echo cancellation, noise suppression, auto-gain
  - Individual user volume control
  - Speaking indicators
  - Mic gain and output volume controls
- **Text Chat**: Real-time messaging per channel
- **Channel Management**: Create and join multiple channels
- **Responsive Design**: Works on desktop, tablet, and mobile
- **Accessibility**: ARIA labels, keyboard navigation, screen reader support

## 🏗️ Architecture

### Project Structure

```
client/
├── src/
│   ├── components/          # UI components
│   │   └── NotificationManager.ts
│   ├── services/           # Core business logic
│   │   ├── AudioService.ts    # Microphone & audio processing
│   │   ├── PlayerService.ts   # HLS video player
│   │   ├── SocketService.ts   # Socket.IO communication
│   │   └── VoiceService.ts    # WebRTC voice chat
│   ├── styles/            # CSS stylesheets
│   │   └── main.css
│   ├── types/             # TypeScript type definitions
│   │   └── index.ts
│   ├── utils/             # Utility functions
│   │   ├── EventEmitter.ts
│   │   ├── StateManager.ts
│   │   └── helpers.ts
│   ├── App.ts             # Main application controller
│   ├── main.ts            # Application entry point
│   └── vite-env.d.ts      # Vite environment types
├── index.html             # HTML template
├── vite.config.js         # Vite configuration
├── tsconfig.json          # TypeScript configuration
├── package.json
└── .env.example           # Environment variables template
```

### Architecture Highlights

- **Service-Oriented**: Separated concerns into specialized services
- **Event-Driven**: Services communicate via EventEmitter pattern
- **Type-Safe**: Full TypeScript with strict mode enabled
- **Modular**: Easy to extend and maintain
- **State Management**: Centralized state with persistence
- **Error Handling**: Graceful error recovery with user notifications

## 🚀 Getting Started

### Prerequisites

- Node.js 18+ and npm/yarn
- Running RTMP server (see `ops/` directory)
- Running backend server (see `server/` directory)

### Installation

```bash
# Install dependencies
npm install

# Copy environment file
cp .env.example .env

# Edit .env with your configuration
# VITE_SERVER_URL=http://localhost:4000
# VITE_API_BASE_URL=http://localhost:4000
# VITE_HLS_BASE_URL=http://localhost/hls
```

### Development

```bash
# Start development server
npm run dev

# Type check
npm run type-check

# Format code
npm run format
```

The client will be available at `http://localhost:5173`

### Production Build

```bash
# Build for production
npm run build

# Preview production build
npm run preview
```

## 🎮 Usage

### Joining a Channel

1. Enter your display name
2. Enter or select a channel name
3. Click "Join"

### Streaming (Broadcaster)

Configure OBS with:
- **Server**: `rtmp://your-domain/live?key=<TOKEN_FROM_APP>` (append the token shown in the dashboard)
- **Stream Key**: Use the channel name displayed in the app (e.g., `main-stream`)

### Voice Chat

1. Click "Join Voice" to connect your microphone
2. Use "Mute" to toggle your microphone
3. Use "Deafen" to mute all incoming audio
4. Adjust settings in the sidebar:
   - Mic gain, output volume
   - Echo cancellation, noise suppression
   - Push-to-talk mode

### Text Chat

Type messages in the chat input and press Enter or click Send.

## 🛠️ Configuration

### Environment Variables

Create a `.env` file from `.env.example`:

```bash
# Backend WebSocket server URL
VITE_SERVER_URL=http://localhost:4000

# HLS streaming base URL (nginx-rtmp)
VITE_HLS_BASE_URL=http://localhost/hls

# Optional: override RTMP ingest URL (shown in the UI)
VITE_RTMP_SERVER_URL=rtmp://your-domain:1935/live

# Optional: override ICE servers (JSON array)
# VITE_WEBRTC_ICE_SERVERS='[{"urls":"stun:stun.l.google.com:19302"}]'

# Optional: shorthand TURN credentials (appended to defaults)
#   - Multiple TURN URLs can be provided, separated by commas or whitespace
#   - TCP fallbacks are added automatically when no transport is specified
# VITE_TURN_URL=turn:turn.example.com:3478,turn:backup.example.com:3478
# VITE_TURN_USERNAME=turnuser
# VITE_TURN_CREDENTIAL=turnpass
```

> ℹ️ **Scope reminder:** The client always talks to the server defined by `VITE_SERVER_URL`.
> If you leave it pointed at your production VPS while developing locally, every message you
> send from `localhost` will appear in production. Set it to your local backend (or create
> a dedicated staging server) to keep environments isolated.

### Audio Settings

All settings are persisted in browser localStorage:

- **Echo Cancellation**: Reduces echo feedback
- **Noise Suppression**: Filters background noise
- **Auto Gain Control**: Normalizes mic volume
- **Mic Gain**: Manual microphone amplification (0-3x)
- **Output Volume**: Control remote audio volume
- **Push-to-Talk**: Bind a key for mic activation

## 🔧 Development

### Code Style

- Use Prettier for formatting: `npm run format`
- Follow TypeScript strict mode guidelines
- Write descriptive comments for complex logic
- Use meaningful variable and function names

### Adding Features

1. **New Service**: Create in `src/services/`
   - Extend `EventEmitter` for communication
   - Export from `src/services/index.ts`

2. **New Component**: Create in `src/components/`
   - Keep components focused and reusable
   - Use TypeScript interfaces for props

3. **New Types**: Add to `src/types/index.ts`

4. **State Changes**: Use `StateManager` in `App.ts`

### Testing

Connect multiple browser windows/tabs to test:
- Multi-user voice chat
- Text chat synchronization
- Channel switching
- Connection recovery

## 📝 Key Classes

### App
Main application controller that:
- Initializes all services
- Manages application lifecycle
- Handles UI events
- Coordinates service communication

### SocketService
Manages Socket.IO connection:
- Real-time messaging
- Channel presence
- WebRTC signaling relay

### AudioService
Handles microphone input:
- Device enumeration
- Audio constraints (echo cancel, etc.)
- Mic gain and visualization
- Stream management

### VoiceService
Manages WebRTC peer connections:
- Peer connection lifecycle
- Audio track management
- Speaking detection
- Output device selection

### PlayerService
HLS video player:
- HLS.js integration
- Error recovery
- Playback management

### StateManager
Centralized state with:
- LocalStorage persistence
- Event-driven updates
- Type-safe getters/setters

## 🐛 Troubleshooting

### Microphone Not Working

1. Check browser permissions
2. Ensure HTTPS or localhost
3. Try different audio device
4. Check browser console for errors

### Video Not Playing

1. Verify OBS is streaming to correct URL
2. Check HLS_BASE_URL in .env
3. Ensure nginx-rtmp is running
4. Check browser console for HLS errors

### Voice Chat Issues

1. Check firewall/NAT settings
2. Verify STUN servers are accessible
3. Test with localhost first
4. Check WebRTC compatibility

### Connection Problems

1. Verify backend server is running
2. Check CORS settings
3. Verify SERVER_URL in .env
4. Check browser console for errors

## 📚 Technologies

- **Vite**: Fast build tool and dev server
- **TypeScript**: Type-safe development
- **HLS.js**: HTTP Live Streaming playback
- **Socket.IO**: Real-time WebSocket communication
- **WebRTC**: Peer-to-peer voice communication
- **Web Audio API**: Audio processing and visualization

## 🤝 Contributing

1. Follow the existing code structure
2. Use TypeScript with strict mode
3. Format code with Prettier
4. Test thoroughly before committing
5. Document complex logic with comments

## 📄 License

See the main project README for license information.
