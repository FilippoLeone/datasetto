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
  state/                   signals: session, channels, chat, search, presence, voice, settings, activity (game activity), notifications (push status), ui, screenAudio, misc (streams, screenshare, admin, minigame)
  services/
    socket/                SocketClient (reconnecting socket.io), api (typed emits), bindings (server events -> state)
    voice/                 VoiceService (WebRTC mesh, Opus tuning, stats, camera/screen tracks), AudioService (mic pipeline, noise gate)
    native/                Electron bridge, Capacitor foreground service and audio routes
    screenCapture          getDisplayMedia / desktop picker capture with system audio, shared by rooms and voice channels
    pushNotifications      Web Push opt-in per browser: permission, service worker, subscription, sync after sign-in
    uploads                POST /api/uploads over XMLHttpRequest (progress) for pictures in chat
    visibilityHeartbeat    tells the server whether this page is visible (push goes out only when no page is)
    ServerConfigService    GET /api/config: registration mode, ICE servers with ephemeral TURN credentials, public URLs, push
    updates                update notices: the desktop updater's state, or a daily GET /api/releases on the web and Android
    sounds, AudioNotificationService   synthesised UI sounds
  audio/worklets/          AudioWorklet processors (noise gate)
  features/
    auth/                  sign-in / register gate, profile dialog
    channels/              channel list, create/delete, stream key dialog, confirm dialog
    chat/                  message list, composer (with the picture strip: paste, drop, picker), message rendering (links, mentions),
                           AttachmentGrid + Lightbox (pictures), LinkPreviewCard, history paging and jump-to-message
    search/                Ctrl+K message search: header box, results panel, debounced queries
    stream/                HLS player + live chat page
    voice/                 voiceManager (joins, mute/deafen, PTT, camera, screen, moderation), voice page, dock, audio settings,
                           desktopVoice (system-wide push to talk + voice overlay through the Electron bridge), pushToTalkHold, voiceOverlayState
    screenshare/           presenter/viewer rooms over direct WebRTC
    minigames/             canvas engine (slither, pacman, fighter) + panel
    admin/                 members, channel permissions, bans
    activity/              "Playing <game>": own entries and report pacing (gameActivity), the Electron bridge wiring (desktopActivity), catalogue tests
    settings/              the Notifications, Desktop app (automatic updates) and Game activity sections of the settings dialog (features/voice/AudioSettingsModal hosts the dialog)
  components/              Button, IconButton, Modal, Avatar, RoleBadge, Toggle, Slider, Select, TextInput, Menu, ToastHost, UpdateNotice
  lib/                     formatting, text tokenizer, storage, permissions, device detection, identicons, runtime and HLS URLs, shortcut (push-to-talk keys),
                           version comparison (version.ts) and the running version (appVersion.ts),
                           attachments (composer picture drafts), media (picture URLs with the viewer's ticket)
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

## Sharing pictures and link previews

- **Attach pictures** by pasting them into the message box, dropping files anywhere
  in the app, or with the picture button next to the box (on phones the file input
  offers the camera and the gallery). PNG, JPEG, WebP and GIF up to the server's
  `UPLOAD_MAX_MB` (10 MB by default), at most 10 per message; anything else is
  explained in a toast. Each picture appears in a strip above the box with its
  upload progress, a remove button and a retry on failure (`lib/attachments.ts`
  holds the strip's state, `services/uploads.ts` the upload). The message goes out
  once every picture is stored, with or without text.
- **In the list** a single picture keeps its shape (bounded to 420 × 340), several
  form a two-column grid of square tiles; the space is reserved from the known
  size so nothing jumps. The server's resized preview is shown (the original for
  GIFs so they animate). Clicking opens the **lightbox**: Escape closes, arrow keys
  step through the message's pictures, Home/End jump, the backdrop closes, "Open
  original" opens the full file, and focus returns to the thumbnail afterwards.
  Its enter/leave motion goes through `lib/motion.ts` like every dialog, so it is
  instant under reduced motion.
- **Picture URLs** are server-relative and need the viewer's media ticket: it
  arrives with `auth:success`, `lib/media.ts` appends it (`?t=`) and the socket
  bindings renew it an hour before it expires. Only people who can read the channel
  get the bytes, so private channels and direct messages stay private.
- **Link previews**: the first link of a message gets a compact card (site, title,
  description, thumbnail) when the server has fetched it; it arrives a moment after
  the message (`chat:messageUpdated`) or at once for a link seen recently. The
  author (or a moderator) can remove the card with its × ; admins switch previews
  off per channel in the channel's permissions dialog ("Link previews").

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

## Game activity ("Playing <game>")

Desktop app only, off by default. Settings > Game activity > "Show what I'm playing" asks the Electron shell to
read the names of the running programs every 20 s (with the operating system's own process-list tool, nothing
injected or hooked; `desktop/README.md` has the full account for the anti-cheat question) and to report the title
it matches in its bundled catalogue or in your own entries. `features/activity/desktopActivity.ts` keeps the shell
configured (`configureGameActivity`, sent at start-up and on every change), mirrors the detection into
`state/activity.ts` (`detectedGame`) and sends it to the server as `presence:activity {title}` through
`features/activity/gameActivity.ts`'s reporter: only changes, never more than one per 11 s (the server accepts one
per 10 s), repeated after every `auth:success` because a new socket starts at null. What leaves the machine is that
title and nothing else; the server broadcasts it as the `activity` field of `user:update`, and `MemberList` and the
voice tiles show "Playing <title>" with a controller icon.

The section explains all this in place, shows what is detected right now and keeps "Your own games": pick a program
from the list the shell reads on your machine (shown only there; launchers and Windows system processes are left
out) and give it a title. Own entries win over the catalogue, so a catalogue title can be renamed too. Settings
live in `localStorage` (`datasetto.gameActivity.v1`); `gameActivity.ts` (normalisation, add/remove, the reporter)
and `catalogue.test.ts` (the shell's matcher and catalogue, loaded from `desktop/games/`) are unit tested. In a
browser, on a phone or with an older desktop shell the section is not shown and nothing is sent.

## On a phone

Phones (under 768 px, or any touch screen shorter than 500 px, which is a phone held sideways)
get the channel and member drawers, the bottom toolbar and touch behaviour that the desktop
layout never sees: `state/ui.ts` keeps `isPhone`, `isLandscapePhone` and `keyboardOpen`, and the
styles use Tailwind's `pointer-coarse:` variant, so a desktop window of the same size is untouched.

- **Targets.** Every control is at least 40 px on a coarse pointer: icon and text buttons, channel
  rows and their options, dialog close, chips, sliders (a 28 px hit area with a 24 px thumb) and
  switch rows (the whole label toggles, not only the switch).
- **Sheets instead of pop-ups.** `components/Sheet.tsx` is a bottom sheet rendered into `<body>`.
  On touch screens `Menu` (channel options, members, voice peers) and `EmojiPicker` render as
  sheets, so nothing is clipped by a scroll container or too small to hit.
- **Messages.** A long press (450 ms, `lib/gestures.ts`) opens the message sheet: six quick
  reactions, more reactions, copy text, delete when allowed, and who reacted. A tap still shows
  the hover actions and the time of a grouped message. Text selection is off on message rows on
  touch screens so the long press is not a selection; "Copy text" replaces it.
- **Drawers.** Swipe right in the main area for the channel drawer, left for the member drawer,
  and the opposite way on an open drawer to close it (`app/useDrawerSwipe.ts`; the thresholds and
  the drawer rules in `lib/gestures.ts` are unit tested). A closed drawer is `inert`.
- **Back closes panels.** `lib/backStack.ts` keeps a stack of open panels (sheets, pickers,
  dialogs, the search page, the admin area, drawers). Android back (Capacitor) pops it before the
  app goes to the background; on touch browsers every panel is a history entry, so the browser's
  back button and gesture do the same instead of leaving the app. Desktop browsers get no history
  entries.
- **Keyboard.** While a text field has the focus and the viewport shrank (`lib/keyboard.ts`) the
  bottom toolbar hides and the message list keeps the newest message in view (a ResizeObserver
  re-sticks it to the bottom). Dialogs do not auto-focus their first field on touch screens, so
  the keyboard waits for a tap. `index.html` asks for `interactive-widget=resizes-content`.
- **Landscape.** A phone held sideways keeps the drawers, loses the bottom toolbar (the header has
  the same buttons), shows a voice channel with video edge to edge with the call controls floating
  over the picture, and puts the stream chat beside the player.
- **Player.** The stream player's bar shows on a tap and hides after three seconds of playback.
- **Install.** `services/installPrompt.ts` catches Chrome's `beforeinstallprompt`; the channel
  drawer then shows an "Install Datasetto" card, and iOS Safari gets the Share > Add to Home
  Screen steps. "Not now" hides it for two weeks (`lib/installPrompt.ts`, tested). The manifest
  and icons live in `public/`.
- **Cropper.** The avatar cropper takes a two-finger pinch to zoom next to drag, wheel and the slider.

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
