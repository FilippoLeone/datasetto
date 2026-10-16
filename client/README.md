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
  app/                     App shell, layout (sidebar, main area, member list, mobile toolbar), modal host, shortcuts, connection banner
  state/                   signals: session, channels, chat, search, presence, voice, settings, notifications (push status), ui, screenAudio, misc (streams, screenshare, admin, minigame)
  services/
    socket/                SocketClient (socket.io with our own reconnect pacing), backoff (exponential backoff + jitter scheduler),
                           api (typed emits), bindings (server events -> state)
    voice/                 VoiceService (WebRTC mesh, Opus tuning, stats, camera/screen tracks), AudioService (mic pipeline, noise gate)
    native/                Electron bridge, Capacitor foreground service and audio routes
    screenCapture          getDisplayMedia / desktop picker capture with system audio, shared by rooms and voice channels
    pushNotifications      Web Push opt-in per browser: permission, service worker, subscription, sync after sign-in
    visibilityHeartbeat    tells the server whether this page is visible (push goes out only when no page is)
    ServerConfigService    GET /api/config: registration mode, ICE servers with ephemeral TURN credentials, public URLs, push
    sounds, AudioNotificationService   synthesised UI sounds
  audio/worklets/          AudioWorklet processors (noise gate)
  features/
    auth/                  sign-in / register gate, profile dialog
    channels/              channel list, create/delete, stream key dialog, confirm dialog
    chat/                  message list, composer, message rendering (links, mentions), history paging and jump-to-message,
                           outbox (queue of unconfirmed messages: "sending", failed after 60 s, retry)
    search/                Ctrl+K message search: header box, results panel, debounced queries
    stream/                HLS player + live chat page
    voice/                 voiceManager (joins, mute/deafen, PTT, camera, screen, moderation, rejoin after a reconnect), voice page, dock,
                           audio settings, voiceRejoin (rejoin state machine), peerReconcile (keep / rekey / rebuild peer connections),
                           desktopVoice (system-wide push to talk + voice overlay through the Electron bridge), pushToTalkHold, voiceOverlayState
    screenshare/           presenter/viewer rooms over direct WebRTC, screenshareRejoin (room rejoin state machine)
    minigames/             canvas engine (slither, pacman, fighter) + panel
    admin/                 members, channel permissions, bans
    settings/              the Notifications section of the settings dialog (features/voice/AudioSettingsModal hosts the dialog)
  components/              Button, IconButton, Modal, Avatar, RoleBadge, Toggle, Slider, Select, TextInput, Menu, ToastHost
  lib/                     formatting, text tokenizer, storage, permissions, device detection, identicons, runtime and HLS URLs, shortcut (push-to-talk keys)
  types/                   protocol.ts (wire types shared with the server), globals.d.ts (desktop and Capacitor globals)
  styles/app.css           Tailwind v4 theme tokens (dark palette) and the few custom classes
  test/setup.ts            vitest environment (jsdom)
public/                    copied as-is: landing.html, downloads.html, robots.txt, sitemap.xml, site.webmanifest, icons,
                           sw.js (the push service worker, plain JS, no caching)
scripts/brand-assets.py    redraws the PNG icons and the Open Graph card (Pillow)
```

## Notifications

Browsers (desktop browsers, Android Chrome and the installed PWA) can receive
Web Push notifications for direct messages and @mentions while no window shows
the app. It is opt-in per browser: Settings (the gear in the sidebar) >
Notifications > "Notify me on this device" asks for permission, registers
`public/sw.js` at the site root, subscribes with the server's VAPID public key
from `/api/config` and sends the subscription to the server
(`services/pushNotifications.ts`). The choice is remembered in `localStorage`
and the subscription is re-sent after every sign-in, so it always belongs to the
current login; turning it off tells the server and drops the browser
subscription. "Send a test" asks the server for a notification right away. The
section explains itself when push is unavailable: no secure context or service
workers, the server has no keys, or notifications are blocked in the browser.

The service worker only shows notifications and handles clicks: it focuses an
open app window and posts `{type: 'push:open', channelId}` to it, or opens
`/app?channel=<id>`; the app reads `?channel=` at boot (`state/channels.ts`,
`pendingChannelId`) and selects that conversation once the channel list arrives.
`services/visibilityHeartbeat.ts` reports `document.visibilityState` to the
server on every change and every 30 s while visible, which is how the server
knows nobody is looking. Inside the Electron and Capacitor shells nothing is
registered: the desktop app shows native notifications through its bridge.

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
  goes through the TURN relay is bound by the relay's per-session cap
  (`TURN_MAX_BPS` in `ops/.env`, 12 Mbit/s by default, 0 for none), so on a
  capped server they see a softer picture at the native presets; direct
  connections are not affected.
- Voice uses Opus at 128 kbps by default (Voice & audio settings > Bitrate
  offers 32 to 128 kbps); the value is applied to our sender through
  `setParameters` and asked of the other side through `maxaveragebitrate` in
  the SDP.

## Searching messages

The search box in the header (Ctrl+K, Cmd+K on a Mac; a magnifier button that
opens a full-screen page on phones) searches the chat history of every channel
you can read: public channels, private channels you belong to and your own
direct messages. Results are grouped by channel, newest first, with the
author's avatar, how long ago the message was sent and a snippet in which the
matching words are highlighted. Searching starts after two letters and is
debounced while you type; the last word matches as a prefix (`pine` finds
`pineapple`) and a phrase in double quotes must appear as written.

- **Everywhere / #channel** narrows the search to the channel that is open; the
  filter icon on a result (or hovering it) limits results to that person, shown
  as a removable "From …" chip. Arrow keys move through the results, Enter opens
  the highlighted one, Escape closes the panel; "Load more" fetches the next page.
- Clicking a result opens its channel and scrolls to the message, which lights
  up for a moment. When the message is older than the history on screen the
  client pages backwards (`chat:history:before`) until it has it. The same
  paging runs when you scroll to the top of a channel; the "start of #channel"
  banner only appears once there is nothing older to load.
- Empty, loading and error states have their own panel content, and the panel's
  enter/leave motion goes through `lib/motion.ts`, so it respects reduced motion
  like every other dialog.

## Staying connected through a deploy or a flaky link

A dropped socket is not an event for the person using the app. What happens
(`services/socket/client.ts`, `services/socket/bindings.ts`):

- **Reconnect pacing** is ours, not socket.io's: exponential backoff from 1 s,
  doubling, capped at 30 s, with jitter (`services/socket/backoff.ts`). The
  server's `server:restarting {expectedWaitMs}` notice (sent right before a
  deploy stops it) replaces the first wait; the browser's `online` event, the
  page becoming visible again and the banner's "Retry now" retry at once;
  while the browser reports no network, attempts are held.
- **The banner** (`app/ConnectionBanner.tsx`) is a thin strip at the top,
  never a modal: "The server is restarting. Back in about 10 s", "Connection
  lost. Attempt 3 in 4 s", "No internet connection", each with "Retry now".
  The rest of the app stays usable.
- **Resume** re-presents the stored session token on every connect. The server
  treats it as the same login (nobody else is signed out), re-sends the
  channel list, and the client reopens the channel it had open.
- **Chat typed while offline** goes into the outbox (`features/chat/outbox.ts`)
  and shows in the list right away as "Sending…"; it goes out in order on the
  next sign-in, each message acknowledged by the server and swapped for the
  echoed copy (matched by `clientId`). A message the server has not confirmed
  after 60 s, or refused, turns into "Not sent" with Retry and Discard. The
  composer never locks.
- **Voice calls keep going.** The audio runs peer to peer, so the socket going
  away changes nothing you can hear: the call shows "Reconnecting voice…",
  keeps the microphone, mute, deafen and push-to-talk state, and on the next
  sign-in `voiceManager` rejoins the room (`features/voice/voiceRejoin.ts`:
  up to six attempts, giving up after 90 s away or on a permanent refusal).
  The room's new socket ids are matched with the connections still held
  (`features/voice/peerReconcile.ts`): the same person with the same media
  session keeps their connection, moved to the new id, with an ICE restart
  only if the transport broke; someone who rebuilt or who is new is
  negotiated afresh. Friends the server no longer lists stay for up to a
  minute while their audio still flows.
- **Live streams** (`features/stream/HlsPlayer.tsx`) ask for a fresh ticket
  and reload the playlist as soon as the socket is back, instead of waiting
  for the retry timer.
- **Screenshare rooms keep going too** (`features/screenshare/screenshareService.ts`,
  state machine in `screenshareRejoin.ts`): the presenter keeps capturing and the
  viewers keep their picture while the socket is down; on the next sign-in the
  presenter starts hosting again with the same media session id and each viewer
  joins again, telling the server what it still holds. The host matches every
  `viewer:pending` with the connection it has to that person (same media session
  and they still hold ours: kept, moved to the new socket id, ICE restart if it
  broke; otherwise a fresh offer), and a viewer follows the presenter's new socket
  id from the room event or its seat confirmation. A viewer whose presenter
  vanished waits up to a minute with the last picture before giving up; a
  different presenter in the room is watched instead.

The backoff schedule, the outbox and the rejoin state machines are unit tested
(`backoff.test.ts`, `outbox.test.ts`, `voiceRejoin.test.ts`, `peerReconcile.test.ts`,
`screenshareRejoin.test.ts`).

## Push to talk and the voice overlay while gaming

- Push to talk (Voice & audio settings > Transmission) records a key or a combination such as `Ctrl + Shift + F9`
  (`lib/shortcut.ts`: stored as `Ctrl+Shift+KeyV`, a bare `KeyboardEvent.code` from the old client still loads).
  A press must carry exactly the recorded modifiers, a release only has to be the same key. A modifier alone
  (right Ctrl) works too.
- In the browser the key works while the tab is focused. In the desktop app the same key is registered with the
  operating system while you are in voice (`features/voice/desktopVoice.ts` asks `window.desktopAPI` for it) and
  also works while a game has focus; the dialog says "Works in the background in the desktop app" when it does,
  warns when the system or another app already owns the combination, and explains that a modifier alone or a bare
  typing key has limits. Electron reports presses only, so `pushToTalkHold.ts` treats the key as released when the
  OS key repeats stop (about 150 ms after a long hold, up to 1.2 s after a short tap).
- The desktop overlay (Voice & audio settings > Voice overlay: toggle and corner) is fed from the voice signals by
  `voiceOverlayState.ts`: you first, then friends by name, speaking ring, mute/deafen, your Muted / Deafened /
  Hold to talk / Live state, at most eight rows plus a "+N more" line. It is hidden outside voice and in the browser.
  Both the shortcut helpers and the overlay state are unit tested; everything feature-detects the bridge so a
  browser, a phone or an older desktop shell keeps working.

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
