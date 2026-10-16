# Datasetto web client

Preact + TypeScript single page app. Signals hold the application state, the
media engines (WebRTC voice/video, HLS playback, screenshare) are plain
services, and components only read signals and call actions.

```bash
npm install
npm run dev        # http://localhost:5173, proxies /api, /socket.io and /hls to the Docker stack on :8080
npm run build      # type-check + production bundle in dist/
npm run typecheck  # tsc only
npm run lint
npm test           # vitest unit tests for lib/, state/ and services/
```

Set `VITE_DEV_PROXY` to point the dev proxy somewhere else than `http://localhost:8080`.
Build-time defaults are listed in `.env.example` (copy it to `.env` for `npm run dev`);
the web build served by Caddy needs none of them because everything is same-origin.

## Layout

```
src/
  main.tsx                 bootstrap: runtime config -> socket -> render
  app/                     App shell, layout (sidebar, main area, member list, mobile toolbar), modal host, shortcuts
  state/                   signals: session, channels, chat, presence, voice, settings, ui, screenAudio, misc (streams, screenshare, admin, minigame)
  services/
    socket/                SocketClient (reconnecting socket.io), api (typed emits), bindings (server events -> state)
    voice/                 VoiceService (WebRTC mesh, Opus tuning, stats, camera/screen tracks), AudioService (mic pipeline, noise gate)
    native/                Electron bridge, Capacitor foreground service and audio routes
    screenCapture          getDisplayMedia / desktop picker capture with system audio, shared by rooms and voice channels
    ServerConfigService    GET /api/config: registration mode, ICE servers with ephemeral TURN credentials, public URLs
    updates                update notices: the desktop updater's state, or a daily GET /api/releases on the web and Android
    sounds, AudioNotificationService   synthesised UI sounds
  audio/worklets/          AudioWorklet processors (noise gate)
  features/
    auth/                  sign-in / register gate, profile dialog
    channels/              channel list, create/delete, stream key dialog, confirm dialog
    chat/                  message list, composer, message rendering (links, mentions)
    stream/                HLS player + live chat page
    voice/                 voiceManager (joins, mute/deafen, PTT, camera, screen, moderation), voice page, dock, audio settings
    screenshare/           presenter/viewer rooms over direct WebRTC
    minigames/             canvas engine (slither, pacman, fighter) + panel
    admin/                 members, channel permissions, bans
    settings/              Desktop app section of the settings dialog (automatic updates switch, updater status)
  components/              Button, IconButton, Modal, Avatar, RoleBadge, Toggle, Slider, Select, TextInput, Menu, ToastHost, UpdateNotice
  lib/                     formatting, text tokenizer, storage, permissions, device detection, identicons, runtime and HLS URLs,
                           version comparison (version.ts) and the running version (appVersion.ts)
  types/                   protocol.ts (wire types shared with the server), globals.d.ts (desktop and Capacitor globals)
  styles/app.css           Tailwind v4 theme tokens (dark palette) and the few custom classes
  test/setup.ts            vitest environment (jsdom)
public/                    copied as-is: landing.html, downloads.html, robots.txt, sitemap.xml, site.webmanifest, icons
scripts/brand-assets.py    redraws the PNG icons and the Open Graph card (Pillow)
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
  **720p30** (about 3.5 Mbit/s), **1080p60** (default, up to 8 Mbit/s),
  **Native resolution · 60 fps** (the display's own size, up to 12 Mbit/s) and
  **Native resolution · 120 fps (competitive)** (up to 18 Mbit/s; 120 fps needs
  a 120 Hz display and a browser that grants it, otherwise it falls back to
  what the capture delivers). The deployment ceiling is
  `VITE_SCREENSHARE_MAX_BITRATE_KBPS` (25000) and `VITE_SCREENSHARE_MAX_FPS`
  (120). The choice is remembered and can be changed while sharing. Every
  screen tile shows the resolution and frame rate it actually plays at.
- The presenter uploads one copy per viewer, so 1080p60 with three viewers
  needs roughly 25 Mbit/s of upload. A viewer who cannot connect directly and
  goes through the TURN relay is capped at about 1.5 Mbit/s by the relay
  (`TURN_MAX_BPS` in `ops/turn/entrypoint.sh`), so they see a softer picture
  at the higher presets; direct connections are not affected.
- Voice uses Opus at 128 kbps by default (Voice & audio settings > Bitrate
  offers 32 to 128 kbps); the value is applied to our sender through
  `setParameters` and asked of the other side through `maxaveragebitrate` in
  the SDP.

## Update notices

`services/updates.ts` runs at boot and `components/UpdateNotice.tsx` shows a small card in the bottom
corner when a newer version exists; it can be closed and comes back only for a newer version than the one
closed (`datasetto.updates.dismissed.v1`). It is never a dialog, so a call is not interrupted.

- **Desktop app**: the Electron shell checks GitHub Releases itself (`desktop/updater.js`) and pushes its
  state over `window.desktopAPI.onUpdateState`; `state/updates.ts` keeps it for the card ("Version x is
  ready, restart to update" with a restart button, or "Version x is available" with a download button on
  builds that cannot install themselves) and for **Settings > Desktop app** (`features/settings/`), which
  has the automatic-updates switch and a **Check now** button.
- **Web and Android**: once a day (`isReleaseCheckDue`, remembered in `datasetto.updates.checkedAt.v1`)
  the client fetches `GET /api/releases` from the server, which caches the latest GitHub release, and
  compares `version` with the version this build was made from (`lib/appVersion.ts`: `VITE_APP_VERSION`,
  on Android the app's versionName). On the web the card offers a reload and a link to the downloads page;
  on Android it links to the APK. Without a build version (a local `npm run dev` or `npm run build`) no
  check runs.
- `VITE_APP_VERSION` is set by the release workflow from the tag for the desktop and Android bundles, and
  by the image workflow for the web image (the release tag, or `git describe` for a branch build, which
  sorts below the next release). Set it yourself for a custom deployment (`ops/caddy/Dockerfile` takes it as
  the `APP_VERSION` build argument).
- `lib/version.ts` compares versions numerically (`0.1.10` > `0.1.9`, pre-release and `git describe`
  suffixes sort below the plain release); unit tests cover it and the notice state.

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
