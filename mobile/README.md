# Datasetto Mobile

Capacitor workspace that wraps the Datasetto web client (`client/`, Preact + Vite) for Android and iOS. The native projects in `android/` and `ios/` are committed; `npx cap sync` copies the web build into them.

## Quick start

Requirements for Capacitor 8: Node.js 22+, JDK 21, Android Studio with the Android 16 SDK (compileSdk and targetSdk 36, minSdk 24; the Gradle wrapper fetches Gradle 8.14.3 and AGP 8.13 itself), and for iOS Xcode 26 with an iOS 15 deployment target. `npx cap migrate` keeps `android/` and `ios/` in step with the Capacitor version.

1. Install dependencies (from inside `mobile/`):

   ```bash
   npm install
   ```

2. Tell the build which server the app talks to. Unlike the web build, the app cannot rely on "same origin": inside the Capacitor WebView the page origin is `https://localhost`, so it needs an absolute server URL. Create `client/.env.mobile` (git-ignored) with it:

   ```bash
   VITE_SERVER_URL=https://your-server.example
   ```

   `VITE_API_BASE_URL`, `VITE_HLS_BASE_URL` and `VITE_RTMP_SERVER_URL` are optional and derived from `VITE_SERVER_URL` when unset. The build script resolves each value from, in order: the shell environment, `client/.env.mobile`, `client/.env.production`, `ops/.env`. If nothing is set, the app falls back at runtime to the client's built-in default (`VITE_MOBILE_DEFAULT_SERVER_URL`, `https://datasetto.com`).

3. Build the web client and sync the native projects:

   ```bash
   npm run sync
   ```

   This runs `scripts/build-web.mjs` (the client's `npm run build` with `VITE_BUILD_TARGET=mobile` and the resolved `VITE_*` values), then `npx cap sync` for every platform, then `scripts/configure-android-foreground-service.mjs`, which keeps the permissions, the foreground service and the notification icon that voice chat needs in the Android manifest.

   On Windows and Linux the iOS part of `cap sync` fails because it needs CocoaPods. Sync Android only:

   ```bash
   npm run build:web
   npx cap sync android
   node ./scripts/configure-android-foreground-service.mjs
   ```

4. Open the platform projects:

   - **Android:** `npm run open:android`
   - **iOS:** `npm run open:ios` (macOS with Xcode and CocoaPods)

## Testing against the local Docker stack

Start the stack from the repo root (`docker compose -f ops/docker-compose.yml -f ops/docker-compose.local.yml up -d`) and build with it as the server:

```bash
VITE_SERVER_URL=http://localhost:8080 npm run build:web
```

(PowerShell: `$env:VITE_SERVER_URL = 'http://localhost:8080'; npm run build:web`.) A device or emulator cannot reach the host's `localhost`; use the machine's LAN address instead (an emulator reaches the host as `10.0.2.2`). Plain `http` is allowed by the Android manifest's `usesCleartextTraffic`, but the page itself is served from `https://localhost` (`androidScheme: 'https'`), so the WebView blocks a plain-http API as mixed content and the app sits on "Connecting to server…" (release builds log nothing). For a local http server add `android: { allowMixedContent: true }` to `capacitor.config.ts` while testing and take it out again before a release build.

## Release builds

`.github/workflows/release.yml` builds a debug-signed APK for every GitHub release: `npm run build:web` with `https://datasetto.com` as the server, `npx cap sync android`, then `gradlew assembleRelease`, attached to the release as `datasetto-android-<tag>-debug.apk`. iOS is not built in CI (it needs an Apple developer account); build it from Xcode after `npm run open:ios`.

## Repository layout

```
mobile/
├─ capacitor.config.ts   # webDir ../client/dist, https scheme, allowed navigation hosts
├─ package.json          # Mobile-specific dependencies & scripts
├─ scripts/
│  ├─ build-web.mjs      # Resolves VITE_* and builds the client for mobile
│  └─ configure-android-foreground-service.mjs
├─ android/              # Android project (app/src/main/assets/public is generated and git-ignored)
└─ ios/                  # iOS project
```

## How the client behaves inside Capacitor

- `window.Capacitor.isNativePlatform()` switches on the native code paths (`client/src/lib/device.ts`, `client/src/lib/runtimeConfig.ts`). In a browser, and in the Electron shell, the same code is a no-op.
- **Layout.** Phones (under 768px, or any touch screen shorter than 500px, so a phone held sideways too) get a channel drawer, a member drawer and a bottom toolbar; tablets keep the channel sidebar and use a member drawer; from 1024px (tablet landscape) the desktop layout applies. In landscape the bottom toolbar goes (the header has the same buttons), a voice channel with video is shown edge to edge with the call controls floating over it, and the stream chat sits beside the player. The header, drawers, sheets, modals and toolbar pad themselves with `env(safe-area-inset-*)`, so notches and the home indicator never cover controls.
- **Touch.** Hit areas are at least 40px on touch screens and form controls render at 16px so iOS does not zoom when one is focused. Menus (channel options, members, voice peers) and the emoji picker open as bottom sheets. A long press on a chat message opens its sheet (quick reactions, copy, delete, who reacted); a tap shows its actions and time. Swipe right in the main area for the channel drawer, left for the member drawer, the other way to close them. The stream player bar shows on a tap and hides after a few seconds. Details in `client/README.md`, "On a phone".
- **Back button (Android).** Closes what is open, newest first (a sheet or picker, a dialog, the search page, the admin area, a drawer); with nothing open the app goes to the background instead of exiting, so a voice call keeps running (`@capacitor/app`, `client/src/services/native/capacitorApp.ts`, `client/src/lib/backStack.ts`).
- **Keyboard.** `@capacitor/keyboard` with `resize: native` shrinks the web view when the keyboard opens on iOS so the composer stays visible. Android uses `windowSoftInputMode="adjustResize"`; on Android 15+, which draws edge to edge, `MainActivity` applies the system-bar, cutout and keyboard insets as web-view margins. Capacitor 8's own insets handling (the `SystemBars` plugin) is switched off in `capacitor.config.ts` (`insetsHandling: 'disable'`) so the two do not add up; the same plugin keeps the bar icons light (`style: 'DARK'`) to match the dark client. While the keyboard is up the client hides its bottom toolbar and keeps the newest message in view.
- **System bars.** iOS uses a light-content status bar (`Info.plist`); Android paints the status and navigation bars in the client's dark base colour (`res/values/styles.xml`, `colors.xml`).
- Voice chat keeps an Android foreground service alive while the app is in the background (`@capawesome-team/capacitor-android-foreground-service`, `client/src/services/native/ForegroundServiceManager.ts`). Its notification is titled with the voice channel's name, says "Voice chat is on. Tap to come back." and has a **Leave** button that hangs up (the plugin's `NotificationActionBroadcastReceiver` delivers the tap); switching channels renames it. It is skipped on iOS and on the web. iOS declares `UIBackgroundModes: audio` plus the microphone and camera usage descriptions in `Info.plist`; without those iOS terminates the app on the first `getUserMedia` call.
- Audio output routing (speaker, earpiece, Bluetooth, wired) uses the `AudioRoute` plugin implemented in `android/app/src/main/java/com/datasetto/mobile/AudioRoutePlugin.java` (`client/src/services/native/NativeAudioRouteService.ts`). `MainActivity` registers it before `super.onCreate()`, which Capacitor requires. Where the plugin is missing (iOS), the client shows a speakerphone-only fallback.
- Screen sharing from a phone or tablet is not possible: mobile WebViews have no `getDisplayMedia` and no native picker, so the share buttons are hidden there and the room can only be watched.
- `server.allowNavigation` in `capacitor.config.ts` lists the hosts the WebView may navigate to; add your own server when self-hosting.

## Notes

- Make sure the `../client` build succeeds before syncing; otherwise Capacitor copies stale assets.
- For live reload, run the Vite dev server (`npm run dev --prefix ../client`) and point `server.url` in `capacitor.config.ts` at it.
- Add additional plugins with `npx cap install <plugin>`.
