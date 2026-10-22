# Datasetto Desktop

Electron shell around the Datasetto web client (`client/`, Preact + Vite). It loads the production bundle from `renderer/` and adds what a browser tab cannot do: a native screen picker with system audio, a tray icon that mirrors your voice state, native notifications, links that open in the system browser, for gaming a push-to-talk key that works while another window has focus plus a small always-on-top voice overlay, and automatic updates from GitHub Releases, and for gaming a push-to-talk key that works while another window has focus, a small always-on-top voice overlay and an opt-in "Playing <game>" status read from the names of running programs.

## Prerequisites

- Node.js 22.12+ (24 LTS recommended, it is what CI uses) and npm 10+
- Electron 44 (Chromium 152, Node 24 inside the app) packaged with electron-builder 26; the installers run on Windows 10+, macOS 13+ and glibc Linux x64
  - The next Electron bump must bundle Node 24.22.1 or later (the `node` field in <https://releases.electronjs.org/releases.json>). Electron 44.8.0 ships Node 24.22.0, which has CVE-2026-111497 (a remote code execution bug in Node's Brotli decoder); on 22 October 2026 no Electron release had the fix yet (44.9.3 and 45.0.0 still bundle 24.22.0). The risk to the app is low: the main process never decodes Brotli from the network itself, and the updater and `net.fetch` go through Chromium's network stack.
- The web client dependencies installed (`npm install` inside `client/`); the renderer is built from there
- For local testing, the Docker stack on <http://localhost:8080>, started from the repo root with
  `docker compose -f ops/docker-compose.yml -f ops/docker-compose.local.yml up -d`

## Install dependencies

```bash
npm install
```

Run this command from inside the `desktop/` directory.

## Run the shell against a server

The shell talks to whichever server its runtime configuration names (see [Configure backend endpoints](#configure-backend-endpoints)). To run the bundled renderer against the local Docker stack:

```bash
npm run build:renderer
npm run prepare:renderer
npm run start:local
```

`start:local` is `npm start` with `DATASETTO_SERVER_URL=http://localhost:8080`; the API, HLS and RTMP URLs are derived from it. Plain `npm start` uses the production defaults from `resources/runtime-config.json`.

## Development workflow (Vite dev server)

```bash
npm run dev
```

This starts the Vite dev server in `client/` and opens Electron on `http://localhost:5173` once it is ready (`ELECTRON_START_URL`). The dev server proxies `/api`, `/socket.io`, `/hls` and `/health` to the local Docker stack (`VITE_DEV_PROXY`, default `http://localhost:8080`). When the renderer is loaded over http and no backend is configured, the shell leaves the backend URLs empty and the client uses the page origin, exactly like the web build, so the proxy does the rest. Set `DATASETTO_SERVER_URL` if the dev shell should talk to another server instead.

## Production build & packaging

1. Build the web client with relative asset paths and copy it into the desktop bundle:

```bash
npm run build:renderer
npm run prepare:renderer
```

`build:renderer` runs the client's `npm run build` (TypeScript check + Vite) with `VITE_BUILD_TARGET=desktop`, which sets Vite's `base` to `./` so that `renderer/index.html` resolves its assets from `file://`. The shell opens `renderer/index.html` directly; that file is the app itself. The `/` → `landing.html` and `/app` → `index.html` rewrites exist only in the web Caddy and are not needed here.

2. Package installers for the current platform:

```bash
npm run build
```

During packaging the build script also regenerates the desktop icon (PNG + ICO) from a simple Datasetto monogram and clears old release artifacts. The outputs appear in `desktop/release/`, named after the version in `package.json` (`Datasetto-<version>-<os>-<arch>.<ext>`):

- Windows: `Datasetto-<version>-win-x64.exe` (installer), `Datasetto-Portable-<version>-win-x64.exe` and `win-unpacked/`
- Linux: `Datasetto-<version>-linux-x86_64.AppImage` and `Datasetto-<version>-linux-amd64.deb`
- macOS: `Datasetto-<version>-mac-arm64.dmg`
- The updater metadata next to them: `latest.yml` (Windows), `latest-mac.yml`, `latest-linux.yml` and one `.blockmap` per installer. electron-builder writes them because `build.publish` names the GitHub repository; `--publish never` in the build script keeps it from uploading anything itself.

> **Tip:** `npm run build` already chains `build:renderer`, `prepare:renderer`, icon generation, and a cleanup step before calling `electron-builder`, so you can run it directly when you want a packaged `.exe`/`.dmg`/AppImage. `npm run release` (or `release:win`, `release:linux`, `release:mac`) wraps the same steps for multi-platform builds.

The published installers come from `.github/workflows/release.yml`: on every GitHub release it runs these same steps on Windows, Linux and macOS runners, sets the package version from the release tag (`v0.1.9` → `0.1.9`) and attaches the installers together with the `latest*.yml` and `.blockmap` files to the release. The metadata must sit next to the installers in the release, that is what installed apps read.

## Title bar

The main window has no native title bar; the client draws its own 32 px bar (logo and name, `client/src/app/TitleBar.tsx`) and the system's caption buttons stay on top of it. On Windows and Linux they are the Window Controls Overlay buttons (`titleBarStyle: 'hidden'` + `titleBarOverlay`), so Snap Layouts on hover over maximize, double-click to maximize, drag to snap and the system menu (right click on the bar) behave as with a native frame. On macOS the traffic lights sit inset at the left end of the bar (`hiddenInset`). The bar is a drag region (`app-region: drag`); anything clickable added to it needs `no-drag`. The preload exposes `desktopAPI.titleBar` (`{ height, platform }`, only when `main.js` asks for the page-drawn bar) and `setTitleBarColors({ color, symbolColor })`, which the client calls with the bar's computed colours whenever the theme changes, so the buttons always sit on the bar's background (IPC `titlebar:colors`, `#rrggbb` only). The client sets `data-titlebar` on `<html>`, and its `.safe-top` / `.p-safe` paddings clear the bar the way they clear a phone's notch. The browser and Android builds have no `titleBar` and look as before; the picker, overlay and video pop-out windows keep their own frames.

## Automatic updates

The packaged app keeps itself current through [electron-updater](https://www.electron.build/auto-update) and the releases of `FilippoLeone/datasetto` (`updater.js`):

- It checks 20 seconds after launch and every 4 hours. On Windows (installed) and Linux (AppImage, deb) the new installer downloads in the background and a small card in the app says "Version x is ready, restart to update" with a restart button. Nothing is installed while the app runs and no dialog interrupts a call: the update is applied on that restart, or silently on the next quit.
- macOS builds are not code signed, so they cannot replace themselves; the portable Windows executable cannot either. Those builds only read the release metadata and show "Version x is available" with a button that opens the release page.
- **Settings > Desktop app** has the **Automatic updates** switch (on by default; stored in `desktop-settings.json` in the user-data folder), the running version, the updater status and a **Check now** button that works with the switch off too.
- Everything the updater does is in the desktop log with the `[Updater]` prefix (`Ctrl+Shift+L` reveals the file).
- `DATASETTO_UPDATE_REPO=owner/repo` points the updater at another GitHub repository (a fork, or a test repository with a release of a higher version). Unpackaged runs (`npm start`, `npm run dev`) never check.

The feed is the public GitHub provider: electron-updater reads the repository's releases feed, downloads `latest.yml` (or `latest-mac.yml` / `latest-linux.yml`) from the newest release and then the installer named in it. Draft releases are not visible to it and pre-releases are skipped. A release without the metadata files is reported as an error in the log and ignored.

The icons in `resources/` are committed and used as they are; the build does not redraw them. To change the artwork, see [brand/README.md](../brand/README.md).

If you’re on Windows and had the app running from a previous build, the cleanup step will try to close `Datasetto.exe` automatically before packaging. If the build still fails with an “access is denied” error, ensure no Datasetto processes are running and retry `npm run build`.

## Gaming: push to talk in the background and the voice overlay

Both features are plain operating-system facilities. Nothing is injected into other processes, no hooks are installed and no game memory is read, so anti-cheat systems see an ordinary application.

**System-wide push to talk.** With push to talk on (Voice & audio settings), the client asks the shell to register the chosen combination as a global shortcut (`globalShortcut`, which is `RegisterHotKey` on Windows) while you are in a voice channel, and drops it when you leave voice, switch to voice activity or clear the key. Presses are forwarded to the client, so holding the key transmits even while a game has focus. Details and limits:

- Electron only reports presses, never releases. Windows and X11 repeat the press at the keyboard's repeat rate while the key is held, so the client treats the key as released once the repeats stop: at most 1.2 s after a tap shorter than the keyboard's repeat delay, about 150 ms once the key has been held longer than that (`client/src/features/voice/pushToTalkHold.ts`). macOS does not repeat hot keys, so there a press keeps the mic open for about a second; holding the key works in the focused window.
- A combination the system or another app already owns cannot be registered (`register` returns false). The settings dialog checks this when you record the key and says so; the key then works only while Datasetto is focused.
- A modifier on its own (right Ctrl, say) cannot be a global shortcut; the dialog explains it. A bare letter, digit or Space can, but other apps will not receive that key while you are in voice, so prefer a function key, a numpad key or a Ctrl/Alt combination.
- While the settings dialog records a new key, the registration is paused so the key reaches the window.

**Voice overlay.** A frameless, transparent, always-on-top window (`overlay/`) in a corner of the primary display shows the voice channel, every participant with a speaking ring and mute/deafen icons, and your own state (Muted, Deafened, Hold to talk, Live). It ignores the mouse (`setIgnoreMouseEvents`), never takes focus, is excluded from screen captures (`setContentProtection`, so it does not show up in your own screen share) and is hidden from the screen share picker, like the picker itself (`picker/own-windows.js`: this app's windows by their native handle, checked on every thumbnail refresh, and any window titled exactly "Datasetto voice overlay" or "Share your screen", so a second running copy of the app, such as a test build next to the installed one, cannot offer its overlay either). The client feeds it over IPC from its voice state and hides it when you leave voice; the toggle and the corner live in Voice & audio settings. Because it is an ordinary window, games running in **exclusive fullscreen** cover it; borderless (windowed fullscreen) and windowed games show it.

## Game activity: "Playing <game>"

Off by default. Settings > Game activity > "Show what I'm playing" turns it on; friends then see "Playing <game>" under your name in the member list and on your voice tile while a known game runs.

**What the app does, exactly.** Every 20 seconds, while the switch is on, the main process runs the operating system's own process-list tool and keeps nothing but the lower-cased executable names: `tasklist /FO CSV /NH` on Windows (PowerShell `Get-Process` names if that fails), `ps -axo comm=` on macOS and Linux. That is the same public list Task Manager, Activity Monitor or `ps` show to any user. The names are compared with `games/catalogue.json` (a few hundred common PC games, executable name to title, plus a list of launchers that never count as a game) and with your own entries, and only the matched title, or nothing, is handed to the client over IPC (`activity:detected`). The client sends that title to the server as `presence:activity {title}` (`null` when the game ends), at most once every 10 seconds; the server keeps it on your connection in memory, broadcasts it with the online list and drops it when you disconnect. Nothing is persisted.

**What the app does not do, for the anti-cheat question.** It opens no handle to another process, reads no memory of any process, does not enumerate, inspect or subclass other windows, installs no keyboard, mouse or window hooks, injects no DLL or code, loads no driver and never touches a game's files or input. The only system call involved is spawning `tasklist`/`ps` as a child process and reading its text output, exactly what a script in a terminal would do. Anti-cheat systems watch for processes that attach to, hook or read the game; a program that lists process names is an ordinary application to them, and Datasetto stays one with this feature on. Your process list never leaves your machine: the client only ever sees the matched title, the server only ever receives that title.

**Your own entries.** For a game that is not in the catalogue, Settings > Game activity > "Add a game" shows the names of the programs running right now (read on your machine for the picker, shown only there, launchers and Windows system processes left out); pick the game's program and give it a name. Own entries win over the catalogue, so you can also rename a catalogue title. Minecraft (Java) runs as `javaw.exe`, for instance. Entries are stored in the client's local storage (`datasetto.gameActivity.v1`) and sent to the shell on every start and change, up to 50 of them, titles of up to 64 characters. The catalogue lives in `games/catalogue.json` (keys lower-cased); on Linux the 15-character `comm` names `ps` reports are matched as prefixes, and a few native Linux executables are listed too.

The matcher and the parsers are plain CommonJS in `games/match.js`, with no Electron in them, so the client's unit tests (`client/src/features/activity/catalogue.test.ts`) exercise them and the catalogue as shipped.

## Test builds next to the installed app (Windows)

Every Windows build is a `Datasetto.exe` with the product name Datasetto, so on their own Windows and Electron cannot tell the installed app from a test build. Two things used to leak from a test build into the installed app:

- **Taskbar.** Windows groups windows by their AppUserModelID. With the installed app's ID (`com.datasetto.desktop`), a test window joined the installed app's pinned taskbar button.
- **Start Menu shortcut.** The first time a process touches notifications (`Notification.isSupported()` at startup is enough), Electron points `Start Menu\Programs\<product name>.lnk` at the running exe and registers that exe as the handler for notification clicks (`HKCU\Software\Classes\CLSID\{…}\LocalServer32`). This happens in `EnsureShortcut` in Electron's `shell/browser/notifications/win/windows_toast_activator.cc`. A test build that ran for three seconds took over the installed app's `Datasetto.lnk` this way, and a dev run left an `Electron` entry in the Start Menu. The installed app took the shortcut back the next time it started.

`app-identity.js` decides which copy is running, and only the installed one uses the app's ID and native notifications:

| Build | Recognised by | App ID | Native notifications | Window title |
| --- | --- | --- | --- | --- |
| Installed | `Uninstall Datasetto.exe` next to the exe | `com.datasetto.desktop` | on | `Datasetto` |
| Portable exe | `PORTABLE_EXECUTABLE_DIR` is set | `com.datasetto.desktop.portable` | only while no other copy owns `Datasetto.lnk` | `Datasetto` |
| Unpacked (`win-unpacked`, any scratch build) | any other packaged build | `com.datasetto.desktop.dev` | off, written to the log instead | `… (test build)` |
| Dev (`npm start`, `npm run dev`) | not packaged | `com.datasetto.desktop.dev` | off on Windows | `… (dev)` |

The installed app's ID is the same in every version, so its pin, shortcut and notifications carry over through updates. macOS and Linux packaged builds count as installed; Electron writes no shortcut there.

A packaged test run on a PC that has the installed app:

1. Build outside the repository, never into `desktop/release/` (Windows also repairs a broken shortcut to a same-named exe nearby): `npm run build:renderer && npm run prepare:renderer`, then `npx electron-builder --publish never --win --dir --config.directories.output=<scratch>/desktop-out`.
2. Give it its own profile with updates off: write `<scratch>/profile/desktop-settings.json` as `{"autoUpdate":false}` and start `<scratch>/desktop-out/win-unpacked/Datasetto.exe --user-data-dir=<scratch>/profile --mute-audio`. Without `--user-data-dir` it shares the installed app's settings, single-instance lock and sign-in.
3. Its title ends in "(test build)", it has its own taskbar button, and notifications only show up in its log as `Notification not shown`.
4. Quit it from its tray menu, or stop it by path (`Get-Process Datasetto | Where-Object Path -like '*desktop-out*' | Stop-Process`), never by name alone: the installed app is a `Datasetto` process too.
5. Builds made before this change still take the shortcut over. Afterwards, read where it points (read-only): `(New-Object -ComObject WScript.Shell).CreateShortcut("$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Datasetto.lnk").TargetPath` should be `%LOCALAPPDATA%\Programs\datasetto-desktop\Datasetto.exe`. If it is not, restarting the installed app repairs it.

## Project structure

```
desktop/
├─ main.js              # Electron main process: window, tray, notifications, screen picker, global push to talk, voice overlay, game activity, IPC
├─ preload.js           # contextBridge: window.desktopAPI + window.datasettoDesktopConfig
├─ updater.js           # electron-updater wiring: GitHub feed, background download, notices, the on/off setting
├─ app-identity.js      # Installed app or test build: taskbar ID, native notifications, title label (pure, unit-tested from client/)
├─ games/
│  ├─ catalogue.json    # Executable name -> game title, plus launchers that never count
│  └─ match.js          # Process-list parsing and matching (pure, unit-tested from client/)
├─ picker/              # Screen/window picker window (HTML + preload)
├─ overlay/             # Always-on-top voice overlay window (HTML + preload)
├─ renderer/            # Copied Vite build output (generated, git-ignored)
├─ resources/           # App and tray icons (drawn by brand/generate.mjs) and the bundled runtime-config.json
├─ scripts/
│  ├─ copy-dist.mjs     # Copies client/dist into renderer/
│  ├─ clean-release.mjs # Clears release/ before packaging
│  └─ build-release.mjs # Multi-platform packaging helper
└─ package.json         # Desktop-specific dependencies, scripts and the electron-builder config
```

## How the shell and the client talk

`preload.js` exposes two globals through `contextBridge`; the typed contract lives in `client/src/types/globals.d.ts` and must stay in sync with the preload:

- `window.desktopAPI`: `getInfo`, `getRuntimeConfig`, `showNotification`, `checkNotificationPermission`, `updateVoiceActivity` (tray icon state), `pickScreenshareSource` (native picker, returns the chosen `desktopCapturer` source and whether to share system audio), `openExternal`, `getLogPath`, `openLogFile`, `log`, and the updater: `getUpdateState`, `setAutoUpdate`, `checkForUpdates`, `installUpdate`, `onUpdateState` (the state shape is `DesktopUpdateState` in `globals.d.ts`; the client feature-detects these, so older shells simply show no update section).
  The picker (`picker/`) is a modal window styled like the client (tokens copied from `client/src/styles/app.css`): tabs for entire screens and windows, thumbnails refreshed every two seconds while it is open, display size on screen cards, a "Share system audio" switch, and arrow/Enter/Escape keyboard control. The client may pass `{ audio, quality: { width, height, fps, label } }`; the quality is only shown as a hint in the footer and the result object is unchanged.
  **Sound in a screen share** (`picker/share-audio.js`). System audio is a loopback of everything the computer plays, which would include Datasetto's own playback (friends' voices, alert sounds, a watched stream), so viewers would hear themselves. Clients that pass `displayMedia: true` get the pick handed to their next `getDisplayMedia()` call: the shell keeps it for 30 s (bound to the asking window, at most three requests, so the client can retry without the exclusion and then without audio) and its `session.setDisplayMediaRequestHandler` answers with that source and `audio: 'loopback'`. Because the page asks with `restrictOwnAudio: true`, Electron 44 turns that into Chromium's `loopbackWithoutChrome` device: WASAPI process loopback without the app's audio process tree on Windows 11, a CoreAudio tap without it on macOS 14.2+. Windows 10, older macOS and Linux get plain system audio; the picker's audio line says so (in amber) and the client shows a toast once the share runs. The answer also carries `displayMedia` (whether the hand-over was armed) and `ownAudioExcluded`. The old route (`getUserMedia` with `chromeMediaSource: 'desktop'` and the returned source id) still works for older clients but always captures plain `loopback`. A page that calls `getDisplayMedia()` without picking first gets the picker from the handler; frames inside a page never get a capture. The log records the kind of source and the audio mode, never window titles.
  Gaming additions, all optional on the client side (it feature-detects them, so a client paired with an older shell simply has no background key and no overlay): `setPushToTalkShortcut(accelerator | null)` returns `{ accelerator, registered, error? }` (`taken` or `invalid`), `checkPushToTalkShortcut(accelerator)` returns `{ available }` without changing the registration, `onPushToTalkPressed(handler)` delivers `{ accelerator, at }` for every press (and OS key repeat) and returns an unsubscribe function, `configureVoiceOverlay({ enabled, corner })` and `updateVoiceOverlay(state | null)` with the state shape described in `client/src/types/globals.d.ts` (`DesktopVoiceOverlayState`). The accelerator is an Electron accelerator string such as `Control+Shift+F9`, built by `client/src/lib/shortcut.ts`. IPC channels: `ptt:set`, `ptt:check`, `ptt:pressed`, `overlay:configure`, `overlay:state`, `overlay:size` (the overlay page reports its height so the window hugs the card).
  Game activity, also optional and feature-detected (`client/src/features/activity/desktopActivity.ts`): `configureGameActivity({ enabled, custom: [{ exe, title }] })` applies the settings and resolves with `{ enabled, title, catalogueSize }` after an immediate scan; `listProcesses()` resolves with `{ processes }`, the lower-cased names of the running programs for the picker (launchers, Windows system processes and the app itself left out); `onGameActivity(handler)` delivers `{ title }` whenever the matched title changes and returns an unsubscribe function. The shell forgets the settings on every page load (reload, window closed), so the client sends them again at start-up. IPC channels: `activity:configure`, `activity:processes`, `activity:detected`.
- `window.datasettoDesktopConfig`: `{ serverUrl, apiBaseUrl, hlsBaseUrl, rtmpServerUrl }`, read by `client/src/lib/runtimeConfig.ts` before the build-time `VITE_*` fallbacks.

The client uses these helpers from `client/src/services/native/desktop.ts` and `client/src/features/screenshare/screenshareService.ts`; every call is a no-op in a plain browser.

## Configuration notes

- `ELECTRON_START_URL` makes the shell load a URL instead of `renderer/index.html` (used by `npm run dev`) and opens DevTools detached.
- Remote voices are played through the renderer's `AudioContext` (a `MediaStreamSource` per friend); the muted `<audio>` element per peer stays in the page because Chromium only hands remote WebRTC audio to Web Audio while an element consumes the stream. Do not switch this to `createMediaElementSource`: on a `MediaStream` it yields silence (checked in Electron 44), which mutes everyone and hides who is speaking.
- `F12` / `Ctrl+Shift+I` toggles DevTools in any build; `Ctrl+Shift+L` reveals the log file (`datasetto.log` next to a portable executable, otherwise in the user-data folder).
- `renderer/`, `release/` and a local `desktop/runtime-config.json` are git-ignored.
- `DATASETTO_UPDATE_REPO` (`owner/repo`) changes where the packaged app looks for updates; see [Automatic updates](#automatic-updates).
- The icons in `resources/` (`icon.png` for Linux and the window, `icon.ico` for Windows, `icon.icns` for macOS, `icon-speaking.*`, `tray-*.*`) are all drawn by `brand/generate.mjs`; change the artwork there rather than editing the files.
- Adjust the `build` section in `package.json` if you need different packaging targets or signing options.
- Packaging tweaks already enabled:
  - Relative asset paths when `VITE_BUILD_TARGET=desktop`, so the portable build resolves bundled files correctly.
  - `npmRebuild` disabled during packaging (faster builds when no native modules are used).
  - Both NSIS installer and portable executables are produced for Windows, with different names (`build.portable.artifactName`): with the shared name the portable file used to overwrite the installer, so the published exe was the portable build and never matched the installer's checksum in `latest.yml`. Only the installer updates itself.

## Configure backend endpoints

The desktop shell ships with production defaults pointed at `https://datasetto.com` (see `resources/runtime-config.json`). Override them with one of the following, highest priority first:

1. **Environment variables** (set before launching Electron or the packaged executable):

   - `DATASETTO_SERVER_URL`
   - `DATASETTO_API_BASE_URL`
   - `DATASETTO_HLS_BASE_URL`
   - `DATASETTO_RTMP_SERVER_URL`

2. **Runtime config file**, the first one found of:

   - the file named by `DATASETTO_RUNTIME_CONFIG_PATH`
   - `resources/runtime-config.json` inside a packaged build (customise `desktop/resources/runtime-config.json` before running `npm run build`)
   - `desktop/runtime-config.json` during development

   Example:

   ```json
   {
     "serverUrl": "https://staging.datasetto.com",
     "apiBaseUrl": "https://staging.datasetto.com",
     "hlsBaseUrl": "https://staging.datasetto.com/hls",
     "rtmpServerUrl": "rtmp://staging.datasetto.com/live"
   }
   ```

3. The built-in default, `https://datasetto.com`.

Whichever source provides `serverUrl` wins, and any URL it leaves out is derived from that server (`<server>` for the API, `<server>/hls`, `rtmp://<host>/live`) rather than mixed with a lower-priority source. A single `DATASETTO_SERVER_URL` is therefore enough to point the app at another server. When the renderer is loaded from a web server (`ELECTRON_START_URL`) and nothing is configured, all four values are empty and the client uses the page origin. The RTMP URL shown in the stream key dialog always comes from the server (`PUBLIC_RTMP_URL`) when it is reachable; the configured value is only the fallback.
