# Datasetto Desktop

Electron shell around the Datasetto web client (`client/`, Preact + Vite). It loads the production bundle from `renderer/` and adds what a browser tab cannot do: a native screen picker with system audio, a tray icon that mirrors your voice state, native notifications, links that open in the system browser, and automatic updates from GitHub Releases.

## Prerequisites

- Node.js 22.12+ (24 LTS recommended, it is what CI uses) and npm 10+
- Electron 44 (Chromium 152, Node 24 inside the app) packaged with electron-builder 26; the installers run on Windows 10+, macOS 13+ and glibc Linux x64
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

## Automatic updates

The packaged app keeps itself current through [electron-updater](https://www.electron.build/auto-update) and the releases of `FilippoLeone/datasetto` (`updater.js`):

- It checks 20 seconds after launch and every 4 hours. On Windows (installed) and Linux (AppImage, deb) the new installer downloads in the background and a small card in the app says "Version x is ready, restart to update" with a restart button. Nothing is installed while the app runs and no dialog interrupts a call: the update is applied on that restart, or silently on the next quit.
- macOS builds are not code signed, so they cannot replace themselves; the portable Windows executable cannot either. Those builds only read the release metadata and show "Version x is available" with a button that opens the release page.
- **Settings > Desktop app** has the **Automatic updates** switch (on by default; stored in `desktop-settings.json` in the user-data folder), the running version, the updater status and a **Check now** button that works with the switch off too.
- Everything the updater does is in the desktop log with the `[Updater]` prefix (`Ctrl+Shift+L` reveals the file).
- `DATASETTO_UPDATE_REPO=owner/repo` points the updater at another GitHub repository (a fork, or a test repository with a release of a higher version). Unpackaged runs (`npm start`, `npm run dev`) never check.

The feed is the public GitHub provider: electron-updater reads the repository's releases feed, downloads `latest.yml` (or `latest-mac.yml` / `latest-linux.yml`) from the newest release and then the installer named in it. Draft releases are not visible to it and pre-releases are skipped. A release without the metadata files is reported as an error in the log and ignored.

To tweak the icon artwork, edit `scripts/generate-icon.mjs` (it uses `pngjs` to draw a gradient monogram) and rerun `npm run generate:icon`.

If you’re on Windows and had the app running from a previous build, the cleanup step will try to close `Datasetto.exe` automatically before packaging. If the build still fails with an “access is denied” error, ensure no Datasetto processes are running and retry `npm run build`.

## Project structure

```
desktop/
├─ main.js              # Electron main process: window, tray, notifications, screen picker, IPC
├─ preload.js           # contextBridge: window.desktopAPI + window.datasettoDesktopConfig
├─ updater.js           # electron-updater wiring: GitHub feed, background download, notices, the on/off setting
├─ picker/              # Screen/window picker window (HTML + preload)
├─ renderer/            # Copied Vite build output (generated, git-ignored)
├─ resources/           # App and tray icons (generated) and the bundled runtime-config.json
├─ scripts/
│  ├─ copy-dist.mjs     # Copies client/dist into renderer/
│  ├─ generate-icon.mjs # Draws the app and tray icons
│  ├─ clean-release.mjs # Clears release/ before packaging
│  └─ build-release.mjs # Multi-platform packaging helper
└─ package.json         # Desktop-specific dependencies, scripts and the electron-builder config
```

## How the shell and the client talk

`preload.js` exposes two globals through `contextBridge`; the typed contract lives in `client/src/types/globals.d.ts` and must stay in sync with the preload:

- `window.desktopAPI`: `getInfo`, `getRuntimeConfig`, `showNotification`, `checkNotificationPermission`, `updateVoiceActivity` (tray icon state), `pickScreenshareSource` (native picker, returns the chosen `desktopCapturer` source and whether to share system audio), `openExternal`, `getLogPath`, `openLogFile`, `log`, and the updater: `getUpdateState`, `setAutoUpdate`, `checkForUpdates`, `installUpdate`, `onUpdateState` (the state shape is `DesktopUpdateState` in `globals.d.ts`; the client feature-detects these, so older shells simply show no update section).
  The picker (`picker/`) is a modal window styled like the client (tokens copied from `client/src/styles/app.css`): tabs for entire screens and windows, thumbnails refreshed every two seconds while it is open, display size on screen cards, a "Share system audio" switch, and arrow/Enter/Escape keyboard control. The client may pass `{ audio, quality: { width, height, fps, label } }`; the quality is only shown as a hint in the footer and the result object is unchanged.
- `window.datasettoDesktopConfig`: `{ serverUrl, apiBaseUrl, hlsBaseUrl, rtmpServerUrl }`, read by `client/src/lib/runtimeConfig.ts` before the build-time `VITE_*` fallbacks.

The client uses these helpers from `client/src/services/native/desktop.ts` and `client/src/features/screenshare/screenshareService.ts`; every call is a no-op in a plain browser.

## Configuration notes

- `ELECTRON_START_URL` makes the shell load a URL instead of `renderer/index.html` (used by `npm run dev`) and opens DevTools detached.
- `F12` / `Ctrl+Shift+I` toggles DevTools in any build; `Ctrl+Shift+L` reveals the log file (`datasetto.log` next to a portable executable, otherwise in the user-data folder).
- `renderer/`, `release/` and a local `desktop/runtime-config.json` are git-ignored.
- `DATASETTO_UPDATE_REPO` (`owner/repo`) changes where the packaged app looks for updates; see [Automatic updates](#automatic-updates).
- The icons in `resources/` (`icon.png`, `icon.ico`, `icon-speaking.*`, `tray-*.*`) are all drawn by `scripts/generate-icon.mjs`; change the artwork there rather than editing the files.
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
