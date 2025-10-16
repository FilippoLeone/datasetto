# Datasetto Desktop

Electron wrapper around the existing Datasetto web client. This workspace launches the Vite-powered UI inside a desktop shell and packages platform installers.

## Prerequisites

- Node.js 18+
- npm 9+
- The web client dependencies installed (`npm install` inside `client/`)

## Install dependencies

```bash
npm install
```

Run this command from inside the `desktop/` directory.

## Development workflow

1. Start the desktop dev environment (runs Vite dev server plus Electron):

```bash
npm run dev
```

2. Electron waits for `http://localhost:5173` and opens it once the Vite dev server from `client/` is ready.

## Production build & packaging

1. Build the web client assets and copy them into the desktop bundle:

```bash
npm run build:renderer
npm run prepare:renderer
```

2. Package installers for the current platform:

```bash
npm run build
```

During packaging the build script also regenerates the desktop icon (PNG + ICO) from a simple Datasetto monogram and clears old release artifacts. The final outputs appear in `desktop/release/`:

- `Datasetto Setup <version>.exe` (NSIS installer)
- `Datasetto-<version>-win-x64.exe` (portable build – no installer)
- `win-unpacked/` (unzipped application directory)

> **Tip:** `npm run build` already chains `build:renderer`, `prepare:renderer`, icon generation, and a cleanup step before calling `electron-builder`, so you can run it directly when you want a packaged `.exe`/`.dmg`/AppImage.

To tweak the icon artwork, edit `scripts/generate-icon.mjs` (it uses `pngjs` to draw a gradient monogram) and rerun `npm run generate:icon`.

If you’re on Windows and had the app running from a previous build, the cleanup step will try to close `Datasetto.exe` automatically before packaging. If the build still fails with an “access is denied” error, ensure no Datasetto processes are running and retry `npm run build`.

## Project structure

```
desktop/
├─ main.js          # Electron main-process entry
├─ preload.js       # Secure preload bridge exposed to the renderer
├─ renderer/        # Copied Vite build output (generated)
├─ scripts/
│  └─ copy-dist.mjs # Copies client/dist into renderer/
├─ resources/       # Place platform icons or extra assets here
└─ package.json     # Desktop-specific dependencies & scripts
```

## Configuration notes

- `ELECTRON_START_URL` is used during development to load the Vite dev server;
  production builds fall back to the static files under `renderer/`.
- Update the icons inside `resources/` (`icon.icns`, `icon.ico`, `icon.png`) before shipping to match your branding.
- Adjust the `build` section in `package.json` if you need different packaging targets or signing options.
- Packaging tweaks already enabled:
  - Relative asset paths when `VITE_BUILD_TARGET=desktop`, so the portable build resolves bundled files correctly.
  - `npmRebuild` disabled during packaging (faster builds when no native modules are used).
  - Both NSIS installer and portable executables are produced for Windows.

## Configure backend endpoints

The desktop shell ships with production defaults pointed at `https://datasetto.com` (see `resources/runtime-config.json`).

If you need to override them for staging or self-hosted environments, use one of the following:

1. **Environment variables** (set before launching Electron or the packaged executable):

  - `DATASETTO_SERVER_URL`
  - `DATASETTO_API_BASE_URL`
  - `DATASETTO_HLS_BASE_URL`
  - `DATASETTO_RTMP_SERVER_URL`

2. **Runtime config file** – drop a `runtime-config.json` next to the build artifacts:

  - During development: place it in `desktop/runtime-config.json`.
  - For packaged builds: customise `desktop/resources/runtime-config.json` before running `npm run build`. The file will be bundled into `resources/runtime-config.json` inside the app.

  Example:

  ```json
  {
    "serverUrl": "https://staging.datasetto.com",
    "apiBaseUrl": "https://staging.datasetto.com",
    "hlsBaseUrl": "https://staging.datasetto.com/hls",
    "rtmpServerUrl": "rtmp://staging.datasetto.com/live"
  }
  ```

Resolution order now prefers environment variables, then `runtime-config.json`, and finally the built-in `https://datasetto.com` defaults. Localhost fallbacks are only used when all other sources are absent.
