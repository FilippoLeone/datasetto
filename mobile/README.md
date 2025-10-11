# Datasetto Mobile

Capacitor workspace that wraps the existing Datasetto web client for iOS and Android.

## Quick start

1. Install dependencies:

   ```bash
   npm install
   ```

2. Build the web client and sync native projects:

   ```bash
   npm run sync
   ```

   This command builds `../client` for production and copies the assets into the native shells.

3. Open the platform projects:

   - **Android:**

     ```bash
     npm run open:android
     ```

   - **iOS:**

     ```bash
     npm run open:ios
     ```

   Capacitor will generate the `android/` and `ios/` folders on first run.

## Repository layout

```
mobile/
├─ capacitor.config.ts   # Capacitor configuration (points to ../client/dist)
├─ package.json          # Mobile-specific dependencies & scripts
├─ android/              # Generated Android project (created via `npx cap add android`)
└─ ios/                  # Generated iOS project (created via `npx cap add ios`)
```

The `android/` and `ios/` directories are initially empty; run `npm run sync` to create them.

## Notes

- Ensure the `../client` build succeeds before syncing; otherwise Capacitor will copy stale assets.
- For local development, you can run the Vite dev server (`npm run dev --prefix ../client`) and configure Live Reload in `capacitor.config.ts` if desired.
- Add any additional plugins with `npx cap install <plugin>`.
