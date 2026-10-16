import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.datasetto.mobile',
  appName: 'Datasetto',
  webDir: '../client/dist',
  server: {
    androidScheme: 'https', // Production uses HTTPS
    // Hosts the WebView may navigate to; add your own server when self-hosting.
    allowNavigation: ['datasetto.com'],
  },
  android: {
    // Android 15 draws edge to edge. MainActivity keeps the WebView clear of the
    // system bars and the keyboard itself (it also covers IME insets), so the
    // built-in margin handling stays off.
    adjustMarginsForEdgeToEdge: 'disable',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
    },
    Keyboard: {
      // Shrink the web view when the keyboard opens so the composer stays visible (iOS).
      resize: 'native',
    },
  },
};

export default config;
