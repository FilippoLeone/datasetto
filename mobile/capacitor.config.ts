import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.datasetto.mobile',
  appName: 'Datasetto',
  webDir: '../client/dist',
  server: {
    androidScheme: 'https', // Production uses HTTPS
    // Allow navigation to your backend server domains
    allowNavigation: [
      'datasetto.com'
    ]
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true
    }
  }
};

export default config;
