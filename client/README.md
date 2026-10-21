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
  state/                   signals: session, channels, chat, search, presence, voice, settings, activity (game activity), notifications (push status), ui, peerAudio (per-person volume), screenAudio, misc (streams, screenshare, admin, minigame)
  services/
    socket/                SocketClient (socket.io with our own reconnect pacing), backoff (exponential backoff + jitter scheduler),
                           api (typed emits), bindings (server events -> state)
    voice/                 VoiceService (WebRTC mesh, Opus tuning, stats, camera/screen tracks), AudioService (mic pipeline, noise gate, neural suppressor)
    native/                Electron bridge, Capacitor foreground service and audio routes
    screenCapture          getDisplayMedia / desktop picker capture with system audio, shared by rooms and voice channels
    pushNotifications      Web Push opt-in per browser: permission, service worker, subscription, sync after sign-in
    uploads                POST /api/uploads over XMLHttpRequest (progress) for pictures in chat
    visibilityHeartbeat    tells the server whether this page is visible (push goes out only when no page is)
    ServerConfigService    GET /api/config: registration mode, ICE servers with ephemeral TURN credentials, public URLs, push
    updates                update notices: the desktop updater's state, or a daily GET /api/releases on the web and Android
    sounds, AudioNotificationService   synthesised UI sounds
  audio/worklets/          AudioWorklet processors (noise gate, DeepFilterNet3 and RNNoise suppressors, mic capture; parts/ are the sources the generated ones are built from)
  audio/neural/            WebAssembly builds of DeepFilterNet3 and RNNoise, the model, licences
  features/
    auth/                  sign-in / register gate, profile dialog
    channels/              channel list, create/delete, stream key dialog, confirm dialog
    chat/                  message list (in-place edit box, reply quotes, tombstones, long-press sheet), composer (picture strip,
                           reply bar, @mention autocomplete), MessageBody (markdown, links, mentions, spoilers), AttachmentGrid +
                           Lightbox (pictures), LinkPreviewCard, history paging and jump-to-message, outbox (queue of unconfirmed
                           messages: "sending", failed after 60 s, retry; pending messages can still be edited or dropped)
    search/                Ctrl+K message search: header box, results panel, debounced queries
    stream/                HLS player + live chat page
    voice/                 voiceManager (joins, mute/deafen, PTT, camera, screen, moderation, rejoin after a reconnect), voice page, dock,
                           audio settings, voiceRejoin (rejoin state machine), peerReconcile (keep / rekey / rebuild peer connections),
                           desktopVoice (system-wide push to talk + voice overlay through the Electron bridge), pushToTalkHold, voiceOverlayState
    screenshare/           presenter/viewer rooms over direct WebRTC, screenshareRejoin (room rejoin state machine)
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

Settings (the gear in the sidebar) > Notifications has two switches for what
this device tells you about, "@mentions" and "Direct messages" (both on by
default, remembered in `localStorage`, `state/notifications.ts`). They apply to
the in-app notifications (the desktop app's native ones, the browser's
`Notification` while a window is visible but not focused) and to Web Push: the
choice is sent along with the push subscription, so the server pushes only what
this device asked for.

Browsers (desktop browsers, Android Chrome and the installed PWA) can receive
Web Push notifications for direct messages and @mentions while no window shows
the app. It is opt-in per browser: "Notify me on this device" asks for
permission, registers `public/sw.js` at the site root, subscribes with the
server's VAPID public key from `/api/config` and sends the subscription to the
server (`services/pushNotifications.ts`). The choice is remembered in
`localStorage` and the subscription is re-sent after every sign-in (and after
a switch above changes), so it always belongs to the current login; turning it
off tells the server and drops the browser subscription. "Send a test" asks
the server for a notification right away. The
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

## How loud each friend plays for you

Every place you hear someone has their volume: click a member in the list on the
right or under a voice channel, click their card or the percentage on their camera
tile in a voice channel, or tap them on a phone (the menu becomes a bottom sheet).
The panel has a 0 to 200 % slider (a real range input: arrow keys step 5 %, Home
and End go to 0 and 200 %), a **Mute for me** switch and **Reset to 100 %**. The
setting is per account and lives in `state/peerAudio.ts` (localStorage key
`rtmpdisc.peerAudio.v1`), so it survives reloads and applies again whenever that
person joins; `voiceManager` pushes it into `VoiceService`, which plays each
remote voice through its own gain node (`services/voice/PeerAudioManager.ts`):
above 100 % is a boost, a mute for me is gain 0 on your side only, nothing is
signalled and their stream is untouched, and the change is heard at once. A
muted friend shows a crossed speaker on their card, tile and row, and the voice
dock counts them. Engines without `AudioContext.setSinkId` (Firefox, Safari) play
through the `<audio>` element instead, where the volume tops out at 100 %. A
shared screen's sound and the stream player keep their own 0 to 100 % volume with
the same `VolumeSlider` component. The desktop overlay only mirrors mute states
and is unchanged.

## Noise suppression

Voice & audio settings > Noise suppression has three levels:

- **Off**: the microphone as the browser delivers it (echo cancellation and
  automatic gain control stay as set).
- **Standard** (default): the browser's own noise suppression plus the envelope
  noise gate (`audio/worklets/noise-gate-processor.js`, strength slider).
  Good against hum and fans; keystrokes and chewing go through.
- **Strong**: a neural model runs on the microphone inside an `AudioWorklet`
  and removes keyboard typing, chewing and other non-speech sounds before the
  track reaches WebRTC. The browser's own suppression is turned off so only
  one denoiser touches the voice. Nothing leaves the device.

How Strong works (`services/voice/neuralSuppression.ts`,
`audio/worklets/parts/`):

- The engine is [DeepFilterNet3](https://github.com/Rikorose/DeepFilterNet)
  (libDF compiled to WebAssembly with SIMD, `audio/neural/`), 480-sample frames
  at 48 kHz, both model stages on every frame. Measured on clean speech it
  changes the level by 0.2 dB in every octave band from 125 Hz to 11 kHz
  (SI-SDR 41 dB); typing in pauses goes down 44 dB with the gate, chewing 22
  to 54 dB. It costs about 0.6 ms per 10 ms frame on a desktop CPU (11-14 %
  of the audio thread) and adds 61 ms of delay (30 ms model lookahead, 11 ms
  reframing, 20 ms gate lookahead).
- The **Strength** slider (6..40 dB, default 25) is the model's attenuation
  limit while you speak; unlimited removal makes pauses sound gated and
  metallic. Pauses are handled by an activity gate after the model, driven by
  the model's own local-SNR estimate (RNNoise's voice probability), with
  200 ms of hold, 20 ms of lookahead and -30 dB when closed, so keystrokes do
  not open it and word attacks are kept.
- Fallbacks: [RNNoise](https://github.com/xiph/rnnoise) 0.2 is the lighter
  engine. Phones start on it and move to DeepFilterNet3 only when a benchmark
  in a worker shows headroom (mean under 2.5 ms and 95th percentile under 5 ms
  per frame). If the worklet reports more than 70 % of the audio thread for
  three seconds in a row, or an engine fails to load, the chain steps down
  DeepFilterNet3 -> RNNoise -> Standard and the settings dialog says why.
  RNNoise mutes quiet speech (soft consonants below about -40 dBFS come out as
  silence), which is why it is not the first choice. The AudioContext must run
  at 48 kHz; otherwise Standard is used.
- The node is created once per AudioContext and kept; strength and level
  changes are messages to the worklet, so the microphone is not restarted. The
  model (8 MB) and the WebAssembly module (15 MB, 4 MB over the wire) are
  Vite assets, downloaded the first time Strong is selected and cached like
  the other hashed assets; nothing is fetched from third parties.
- The mic test in the dialog can record 5 seconds and play it back as it
  would be sent and as the raw microphone, to hear what the level removes.
- Rebuilding the worklets after editing a part or the glue:
  `npm run build:worklets`. Rebuilding the WebAssembly itself:
  `audio/neural/libdf/README.md`. Licences and the model's status:
  `audio/neural/NOTICE.md`.

## Direct messages

Click a member ("Message …" in their menu) to open a conversation; it sits under
"Direct messages" in the sidebar, latest first, with the other person's avatar
and name. The × on a row (on hover; always shown on touch) or "Close
conversation" in the row's options menu (a bottom sheet on phones) takes the
conversation out of the sidebar without deleting anything: the server keeps the
history, and the conversation comes back when a message arrives in it, when you
open it again from the member list, or when you open one of its messages from a
search result. Closing the conversation that is on screen takes you back to the
channel you were in before it.

## Editing, deleting, replying and mentions

Hovering a message (a tap on touch screens, keyboard focus anywhere in the row)
shows its actions: Reply, Add reaction, and on your own messages Edit and
Delete; admins see Delete on every message. On phones a long press opens the
same choices as a bottom sheet (plus quick reactions and Copy text). Edit opens
the text in place: Enter saves, Escape cancels (Save and Cancel buttons on
touch screens); an empty or unchanged text just closes it. Arrow up in the
empty composer edits your newest message in the channel. Edited messages show
"(edited)" with the time on hover. Deleted messages stay in the list as
"Message deleted" so nothing jumps and replies to them keep their place. A
message that is still "sending" can be edited or deleted too: the queued copy
changes or goes, and if the server had already accepted it the stored message
is edited or deleted right after (`features/chat/outbox.ts`).

Reply puts a "Replying to …" bar above the composer (Escape or × cancels it);
the sent message shows the quoted original above its text, and clicking the
quote scrolls to the original, loading older history on the way, and flashes
it. A quote says "Message deleted" when the original was deleted and "Original
message unavailable" when it is gone for good.

Typing `@` in the composer lists the people who can read the channel
(`channel:members`, cached for a minute, plus whoever is online for a public
channel): arrow keys move, Enter or Tab inserts `@Display Name `, Escape
closes, a click picks. Names with a space work. The server resolves the
mentions when the message is sent, so the exact span is highlighted in the
list (warm when it is you, with a stripe down the message), the sidebar badge
of a channel turns into a brand-coloured `@n` while unread messages mention
you (the phone toolbar's badge too), and you are told about it according to
your notification switches. `@` before an address (`bob@example.com`) is not a
mention.

## Message formatting

Messages render a small markdown (`lib/markdown.ts`): `**bold**`, `*italic*`
or `_italic_` (underscores only as whole words, so `snake_case` stays as
typed), `` `inline code` `` (a run of backticks closes with a run of the same
length), fenced code blocks (```` ``` ```` on their own lines, with an optional
language word after the opening fence), `||spoilers||` (a solid block until
clicked or activated with the keyboard; a reply quote shows `[spoiler]`),
http(s) links (clickable, with the preview card as before) and @mentions. A
backslash escapes any marker (`\*`, `` \` ``, `\|`, `\\`). The text is parsed
into a tree and rendered as elements, never as HTML, so `<b>`, `<script>` and
the like are shown as typed. Unbalanced or empty markers stay as typed, and
nothing spans a line break except a code block.

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
  Hold to talk / Voice on / Live state, at most eight rows plus a "+N more" line. It is hidden outside voice and in the browser.
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
  by the image workflow for the web image (the release tag, or `git describe` for a branch build, for
  example `0.1.12-2-gabc123`). Set it yourself for a custom deployment (`ops/caddy/Dockerfile` takes it as
  the `APP_VERSION` build argument).
- `lib/version.ts` compares versions numerically (`0.1.10` > `0.1.9`). A pre-release suffix (`0.2.0-beta.1`)
  sorts below its plain release. A `git describe` suffix is read as "that release plus N commits", so a web
  bundle built from a commit after the latest release (`0.1.12-2-gabc123` with release `0.1.12`) counts as
  current and shows no notice until `0.1.13` exists. Unit tests cover it and the notice state.

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
- **iPhone and iPad** (`lib/device.ts` `isIOS`, `isStandaloneDisplay`). Safari ignores
  `interactive-widget` and scrolls the page when the keyboard comes up, so `lib/keyboard.ts` fits
  `#app` to the visual viewport (height and offset, `visualViewportPin`, tested) while a text field
  has the focus. `html` and `body` carry `touch-action: manipulation` (no double-tap zoom on plain
  text) and scroll containers `overscroll-behavior: contain` (no rubber band); rows that act as
  buttons do not select text on a long press. Outside links are real `target="_blank"` anchors
  (`onExternalLinkClick`), which a Home Screen web app hands to Safari instead of swallowing;
  only the desktop shell intercepts them. The drawers pad for the notch in landscape. Web Push
  exists on iOS only for the Home Screen app (16.4+): `state/notifications.ts` says so in the
  settings dialog instead of offering a switch that cannot work. Voice: both AudioContexts are
  created inside the tap on Join (`AudioService.unlock`), remote voices play through the media
  element (no boost above 100 %, `supportsPlaybackBoost`), and `features/voice/IosVoiceNotice.tsx`
  tells iPhone users once that a call pauses in the background. Streams use Safari's native HLS
  (`features/stream/hlsEngine.ts`, tested) with the ticket cookie, and the player hides its
  volume slider because iOS owns the media volume.

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
