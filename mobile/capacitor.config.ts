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
  plugins: {
    SystemBars: {
      // Android 15 draws edge to edge. MainActivity keeps the WebView clear of the
      // system bars and the keyboard itself (it also covers IME insets), so
      // Capacitor 8's own insets handling (the successor of the removed
      // android.adjustMarginsForEdgeToEdge option) stays off.
      insetsHandling: 'disable',
      // The client is dark: light icons on the status and navigation bars (Capacitor 8
      // sets the bar appearance itself and would otherwise follow the device theme).
      style: 'DARK',
    },
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
