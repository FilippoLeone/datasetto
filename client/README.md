# Datasetto web client

Preact + TypeScript single page app. Signals hold the application state, the
media engines (WebRTC voice/video, HLS playback, screenshare) are plain
services, and components only read signals and call actions.

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api, /socket.io and /hls to the Docker stack on :8080
npm run build      # type-check + production bundle in dist/
npm run lint
npm test           # vitest unit tests for lib/ and state/
```

Set `VITE_DEV_PROXY` to point the dev proxy somewhere else than `http://localhost:8080`.

## Layout

```
src/
  main.tsx                 bootstrap: runtime config -> socket -> render
  app/                     App shell, layout (sidebar, main area, member list, mobile toolbar), modal host, shortcuts
  state/                   signals: session, channels, chat, presence, voice, settings, ui, misc (streams, screenshare, admin, minigame)
  services/
    socket/                SocketClient (reconnecting socket.io), api (typed emits), bindings (server events -> state)
    voice/                 VoiceService (WebRTC mesh, Opus tuning, stats, camera/screen tracks), AudioService (mic pipeline, noise gate)
    native/                Electron bridge, Capacitor foreground service and audio routes
    ServerConfigService    GET /api/config: registration mode, ICE servers with ephemeral TURN credentials, public URLs
    sounds                 synthesised UI sounds
  features/
    auth/                  sign-in / register gate, profile dialog
    channels/              channel list, create/delete, stream key dialog, confirm dialog
    chat/                  message list, composer, message rendering (links, mentions)
    stream/                HLS player + live chat page
    voice/                 voiceManager (joins, mute/deafen, PTT, camera, screen, moderation), voice page, dock, audio settings
    screenshare/           presenter/viewer rooms over direct WebRTC
    minigames/             canvas engine (slither, pacman, fighter) + panel
    admin/                 members, channel permissions, bans
  components/              Button, IconButton, Modal, Avatar, RoleBadge, Toggle, Slider, Select, TextInput, Menu, ToastHost
  lib/                     formatting, text tokenizer, storage, permissions, device detection, identicons, runtime URLs
  types/protocol.ts        wire types shared with the server
  styles/app.css           Tailwind v4 theme tokens (dark palette) and the few custom classes
```

## Sharing a game with sound

Screen share works like a go-live button, no OBS needed, in two places: a
screenshare room (one presenter, chat on the side) and the "Share screen"
button of a voice channel. Both capture through `services/screenCapture.ts`.

- In Chrome or Edge pick **Entire screen** (or a browser tab) and tick **Share
  audio** in the picker. A single window cannot carry sound on Windows and macOS,
  so share the whole screen for games. In the desktop app tick **Share system
  audio** in its picker.
- The tile shows **Audio on** or **No audio** for the presenter and every viewer,
  from the audio track of the stream itself. The presenter also gets a toast
  with these steps when the picker returned no audio.
- Wear headphones. Browsers that support it (Chromium 128+) are asked to leave
  this page's own audio, the voice chat, out of the capture (`restrictOwnAudio`)
  so friends are not echoed back; speakers still feed the microphone.
- Quality presets live in Voice & audio settings and next to the share button:
  **720p30** (default, about 3.5 Mbit/s) and **1080p60** (up to 8 Mbit/s, for
  games). The choice is remembered and can be changed while sharing. The
  presenter uploads one copy per viewer, so 1080p60 with three viewers needs
  roughly 25 Mbit/s of upload.

## Conventions

- State lives in `state/*` as signals; mutate through the exported helpers, never from components directly except trivial UI flags.
- Everything that talks to the server goes through `services/socket/api.ts`; everything the server pushes is handled in `services/socket/bindings.ts` (or `voiceManager` / `screenshareService` for media signaling).
- Components stay presentational; long-lived logic (timers, media, reconnection) belongs in services.
- Keep the web build same-origin friendly: relative URLs by default, absolute ones only for the desktop/mobile shells.
- The Electron (`desktop/`) and Capacitor (`mobile/`) shells load the production bundle unchanged.
- Motion is short (150 to 250 ms, ease-out) and defined once: durations, easings and the `animate-*` enter animations live in the `@theme` block of `styles/app.css`, leave animations are driven by `data-state="closed"` through the `usePresence` / `useListPresence` hooks in `lib/motion.ts`. `prefers-reduced-motion` switches all non-essential motion off (spinners keep turning).
- Camera capture goes through `services/voice/cameraCapture.ts`: ideal-only constraints, a retry ladder down to a bare request, a fallback to the machine's other cameras, and error text that tells "in use or blocked" from "constraints refused" from "no camera".

## Public pages and SEO

`public/landing.html` (served at `/`) and `public/downloads.html` are static pages with inline CSS; `public/robots.txt`,
`public/sitemap.xml` and `public/site.webmanifest` go with them. They contain `__SITE_URL__` and `__BUILD_DATE__`
placeholders that `vite.config.js` fills at build time from `VITE_SITE_URL` (the Caddy image passes `SITE_URL` from
`ops/.env`); without a site URL the pages use relative canonical links and the sitemap line is left out of robots.txt.
The app page (`/app`) is `noindex`. PNG icons and the Open Graph card are generated by `scripts/brand-assets.py`.
