import type { CapacitorConfig } from '@capacitor/cli';

// Android/iOS shells around the same web build (dist/). See docs/MOBILE.md.
// appId is a placeholder until Sunrise confirms the store bundle id; it must match the Firebase apps.
const config: CapacitorConfig = {
  appId: process.env.CAP_APP_ID ?? 'in.sunrisehospitals.careconnect',
  appName: 'Sunrise Care',
  webDir: 'dist',
  // The web build is bundled in the app (no remote server URL), served from https://localhost.
  server: { androidScheme: 'https', iosScheme: 'https', hostname: 'localhost' },
  android: { allowMixedContent: false, webContentsDebuggingEnabled: false },
  ios: { contentInset: 'never', limitsNavigationsToAppBoundDomains: false },
  plugins: {
    SplashScreen: { launchShowDuration: 2000, launchAutoHide: true, backgroundColor: '#0F766E', showSpinner: false },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] },
  },
};

export default config;
