#!/usr/bin/env node
// Applies Sunrise Care's permissions and push wiring to the generated Capacitor projects.
// Safe to run again after `npx cap sync` or a Capacitor upgrade: every change is checked first.
//   node scripts/mobile/patch-native.mjs            (both platforms that exist)
// See docs/MOBILE.md for the manual steps (Firebase files, Xcode capability, signing).
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const done = [];
const edit = (file, fn) => {
  const p = path.join(root, file);
  if (!fs.existsSync(p)) return false;
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after !== before) { fs.writeFileSync(p, after); done.push(file); }
  return true;
};

// ---------------------------------------------------------------- Android
const ANDROID_PERMS = [
  // Push (Android 13+ asks at runtime)
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
  // Video consultation in the WebView (LiveKit) and the camera button for documents
  '<uses-permission android:name="android.permission.CAMERA" />',
  '<uses-permission android:name="android.permission.RECORD_AUDIO" />',
  '<uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS" />',
  // Picking files/photos and saving a downloaded prescription on older Android (13+ uses the system picker)
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
  '<uses-feature android:name="android.hardware.camera" android:required="false" />',
  '<uses-feature android:name="android.hardware.microphone" android:required="false" />',
];
const ANDROID_QUERIES = '<queries>\n        <intent><action android:name="android.media.action.IMAGE_CAPTURE" /></intent>\n    </queries>';
const androidOk = edit('android/app/src/main/AndroidManifest.xml', (s) => {
  for (const line of ANDROID_PERMS) {
    const name = /android:name="([^"]+)"/.exec(line)[1];
    if (!s.includes(`"${name}"`)) s = s.replace('</manifest>', `    ${line}\n</manifest>`);
  }
  if (!s.includes('android.media.action.IMAGE_CAPTURE')) s = s.replace('</manifest>', `    ${ANDROID_QUERIES}\n</manifest>`);
  // Health app: no cloud/device-transfer backup of WebView storage (it holds the sign-in session).
  s = s.replace('android:allowBackup="true"', 'android:allowBackup="false"');
  if (!s.includes('android:usesCleartextTraffic')) s = s.replace('<application', '<application\n        android:usesCleartextTraffic="false"');
  return s;
});

// ---------------------------------------------------------------- iOS
const plistEntry = (key, value) => `\t<key>${key}</key>\n\t${value}\n`;
const IOS_KEYS = [
  ['NSCameraUsageDescription', '<string>Sunrise Care uses the camera for video consultations and to photograph reports for your doctor.</string>'],
  ['NSMicrophoneUsageDescription', '<string>Sunrise Care uses the microphone so your doctor can hear you during a consultation.</string>'],
  ['NSPhotoLibraryUsageDescription', '<string>Choose photos of reports or prescriptions to share with your doctor.</string>'],
  ['NSPhotoLibraryAddUsageDescription', '<string>Save images you choose to keep to your photo library.</string>'],
  // Prescriptions the user downloads appear in the Files app under Sunrise Care.
  ['UIFileSharingEnabled', '<true/>'],
  ['LSSupportsOpeningDocumentsInPlace', '<true/>'],
  ['UIBackgroundModes', '<array>\n\t\t<string>remote-notification</string>\n\t</array>'],
];
const iosOk = edit('ios/App/App/Info.plist', (s) => {
  for (const [k, v] of IOS_KEYS) if (!s.includes(`<key>${k}</key>`)) s = s.replace(/<\/dict>\s*<\/plist>\s*$/, `${plistEntry(k, v)}</dict>\n</plist>\n`);
  return s;
});

// Push entitlement file. Xcode → Signing & Capabilities → + Push Notifications links it to the target.
if (iosOk) {
  const ent = path.join(root, 'ios/App/App/App.entitlements');
  if (!fs.existsSync(ent)) {
    fs.writeFileSync(ent, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n\t<key>aps-environment</key>\n\t<string>development</string>\n</dict>\n</plist>\n');
    done.push('ios/App/App/App.entitlements');
  }
}

// The server sends through FCM for both platforms, so iOS must hand Capacitor an FCM token, not the
// raw APNs token. Compiles without Firebase too (canImport), but push then needs FirebaseMessaging added.
const MARK = '// sunrise:push';
edit('ios/App/App/AppDelegate.swift', (s) => {
  if (s.includes(MARK)) return s;
  s = s.replace('import Capacitor\n', `import Capacitor\n#if canImport(FirebaseCore) && canImport(FirebaseMessaging)\nimport FirebaseCore\nimport FirebaseMessaging\n#endif\n`);
  s = s.replace('        // Override point for customization after application launch.\n', `        ${MARK}\n        #if canImport(FirebaseCore) && canImport(FirebaseMessaging)\n        FirebaseApp.configure()\n        #endif\n`);
  const methods = `
    ${MARK}: hand the FCM registration token to @capacitor/push-notifications.
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        #if canImport(FirebaseCore) && canImport(FirebaseMessaging)
        Messaging.messaging().apnsToken = deviceToken
        Messaging.messaging().token { token, error in
            if let error = error {
                NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
            } else if let token = token {
                NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: token)
            }
        }
        #else
        NotificationCenter.default.post(name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
        #endif
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NotificationCenter.default.post(name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
    }
`;
  const i = s.lastIndexOf('}');
  return `${s.slice(0, i)}${methods}}\n`;
});

if (!androidOk && !iosOk) console.log('No native projects yet. Run: npx cap add android && npx cap add ios');
console.log(done.length ? `Patched:\n  ${done.join('\n  ')}` : 'Already up to date.');
