# Installable PWA and Android / iOS apps

The same React build runs:
- as a website;
- as an installable PWA;
- inside Capacitor shells for Android and iOS.

**Offline rule (confirmed by Sunrise, 30 Oct 2026):** only the **app shell** is stored on the device: HTML, JS, CSS, icons and fonts. Patient data, prescriptions and documents are never cached or stored for offline use.

## PWA

| Piece | File |
|---|---|
| Manifest | `public/manifest.webmanifest`:<br>• name "Sunrise Care Connect", short name "Sunrise Care";<br>• standalone, portrait;<br>• theme `#0F766E`, background `#F8FAFC`;<br>• icons: 192, 512 and maskable 512, plus SVG;<br>• shortcuts: Book, Appointments, Records. |
| Icons | `public/icons/*.png`, rendered from `public/favicon.svg`:<br>• the maskable icon keeps the art inside the 80 % safe zone;<br>• `apple-touch-icon.png` is 180 px;<br>• iOS meta tags are in `index.html`. |
| Service worker | `public/sw.js` (also handles Web Push) |
| Precache list | `vite.config.ts → pwaPrecache()`:<br>• after `vite build` it writes the shell into `dist/sw.js`: `/`, the entry script, preloaded chunks, CSS, the manifest and icons;<br>• it also writes a content hash as the cache version. |
| Client | `src/lib/pwa.ts`:<br>• registers the worker (production web builds only, never inside the native app);<br>• update prompt;<br>• `useOnline`;<br>• `useInstall`.<br>`src/components/layout/AppChrome.tsx` holds the offline banner. |

**Service worker caching rules**

| Request | Strategy |
|---|---|
| Page navigation | Network first. Offline, it falls back to the cached shell, which shows the banner "You're offline…". Pages themselves are never stored. |
| `/assets/*` (hashed build files) | Cache first. Lazy route chunks are cached the first time they load. |
| Google Fonts | Stale-while-revalidate |
| `/rest/v1`, `/auth/v1`, `/storage/v1`, `/functions/v1`, `/realtime/v1`, other origins, anything that isn't GET | **Not intercepted.** These requests never reach a cache. |

**Updates.** A deploy changes the precache hash. Open tabs check every hour and on each load. When a new version is ready, a toast says "A new version of Sunrise Care is ready" with **Reload**:
1. **Reload** sends `SKIP_WAITING` to the new worker.
2. The page reloads once the new worker has taken over.
3. Old `scc-*` caches are deleted when the new worker activates.

A half-filled form is never swapped out without the user choosing to reload.

**Opening the app offline.** If someone is signed in and opens the app with no connection, the shell waits for the connection, with the banner showing, instead of showing the login screen. Their role is never guessed from stored data.

**Install.** Profile → *Install the app*:
- **Chrome / Edge / Android:** uses the browser's install prompt.
- **iPhone Safari:** shows the hint "Share → Add to Home Screen".
- **Already installed, or inside the native app:** the card is hidden.

**Hosting.**
- Serve `sw.js` with `Cache-Control: no-cache`, so updates are picked up.
- Serve `index.html` with `no-cache`.
- Serve `/assets/*` as immutable.
- Serve over HTTPS. Service workers need a secure origin; `localhost` is allowed for testing.

## Android and iOS (Capacitor 8)

`capacitor.config.ts`:

| Setting | Value |
|---|---|
| `appId` | `in.sunrisehospitals.careconnect`. **This is a placeholder:** confirm the store bundle id with Sunrise. Override it with `CAP_APP_ID`. It must match the Firebase apps. |
| `appName` | `Sunrise Care` |
| `webDir` | `dist` |
| Web build | Bundled inside the app and served from `https://localhost` |
| Splash | Teal, hidden by the app once it starts |

The native bridge is `src/lib/native.ts`. All of it does nothing on the web, and the plugins load only inside the app.

| Feature | How |
|---|---|
| **Push** | `@capacitor/push-notifications`:<br>1. Profile → Notifications → *Push on this device* asks for permission.<br>2. It gets the **FCM token** and stores it with `register_device_token`.<br>3. The server sends to Android and iOS through **FCM HTTP v1** (`supabase/functions/_shared/notify/fcm.ts`). Messages have no clinical text and use the Android channel `sunrise_default`; reminders are high priority.<br>4. Tapping a notification opens its `/l/<token>` link inside the app. Only app paths are followed.<br>5. Signing out removes the token, so the next person on the phone doesn't get the previous user's messages. Tokens that FCM reports as gone are deleted. |
| **Camera** | `@capacitor/camera`. On the pre-consultation upload, the app shows **Take photo**. The photo goes through the same type and size checks and the same private upload as any file, and it isn't saved to the gallery. Video consultations use the WebView's camera and microphone, which need the permissions below. |
| **Files** | Choosing files uses the system picker, through the normal file input. **Downloads** (prescription PDF, receipt) the user taps are saved to the app's Documents folder; on iOS they appear in the Files app under Sunrise Care. This is the only file the app writes, and only when the user asks for it. |
| **Session** | In the app, the Supabase session (incl. the refresh token) is kept in the iOS Keychain / Android Keystore (`@aparajita/capacitor-secure-storage`), not WebView localStorage; an older session is moved across once. |
| **Shell** | Status bar colour, splash hide, and the Android back button (goes back, or minimises the app on the first screen). |

### Permissions (`npm run mobile:add` / `mobile:build` apply them via `scripts/mobile/patch-native.mjs`)

The script can safely be run again after every `cap sync` or Capacitor upgrade.

**Android: `android/app/src/main/AndroidManifest.xml`**

| Permission | Why |
|---|---|
| `POST_NOTIFICATIONS` | Push. Android 13+ asks at runtime when the user turns push on. |
| `CAMERA`, `RECORD_AUDIO`, `MODIFY_AUDIO_SETTINGS` | Video consultation in the WebView (asked when joining), and *Take photo* |
| `READ_EXTERNAL_STORAGE` (max SDK 32), `WRITE_EXTERNAL_STORAGE` (max SDK 29) | Picking photos and saving a download on older Android. 13+ uses the system photo picker and needs neither. |
| `<queries>` for `IMAGE_CAPTURE` | Lets the camera app be found on Android 11+ |
| `uses-feature camera / microphone required="false"` | The app still installs on devices without them |

The script also sets:
- `android:allowBackup="false"`, so WebView storage, which holds the sign-in session, isn't copied by cloud or device-transfer backup;
- `usesCleartextTraffic="false"`.

**iOS: `ios/App/App/Info.plist`**

| Key | Text shown to the user |
|---|---|
| `NSCameraUsageDescription` | "Sunrise Care uses the camera for video consultations and to photograph reports for your doctor." |
| `NSMicrophoneUsageDescription` | "…so your doctor can hear you during a consultation." |
| `NSPhotoLibraryUsageDescription` / `NSPhotoLibraryAddUsageDescription` | Choose photos of reports; save images you keep |
| `UIFileSharingEnabled`, `LSSupportsOpeningDocumentsInPlace` | Downloaded prescriptions show in the Files app |
| `UIBackgroundModes: remote-notification` | Push delivery |

The script also does two things for iOS:
- It writes `ios/App/App/App.entitlements` (`aps-environment`).
- It patches `AppDelegate.swift` to pass the APNs token to Firebase and hand Capacitor the **FCM** token. The code is inside `#if canImport(FirebaseMessaging)`, so it compiles before Firebase is added.

### Build steps

**One-time setup**
```bash
npm install
cp .env.mobile.example .env.mobile      # VITE_SUPABASE_URL (https), VITE_SUPABASE_ANON_KEY – both public
npm run mobile:add                      # checks .env.mobile, builds, adds android/ + ios/, applies permissions
npm run mobile:assets                   # app icons + splash from assets/ (icon-only, icon-foreground/background, splash, splash-dark)
```
After that, commit `android/` and `ios/`. They are normal source folders from then on.

**Every release**
```bash
npm run mobile:build                    # check env → tsc → vite build --mode mobile → cap sync → re-apply permissions
```

`scripts/mobile/check-env.mjs` stops the build if any of these is wrong:
- `VITE_APP_MODE` is not `supabase`;
- the Supabase URL isn't `https`;
- demo hints are on;
- a `VITE_` variable looks like a secret.

Two reasons for the check:
- inside the app, the page origin is `https://localhost`, so the website's same-origin API fallback can't work;
- everything in `VITE_` ships in the binary.

**Supabase project settings for the app**
- Auth → URL configuration: add `https://localhost` (Android) and `capacitor://localhost` (iOS, if you change `iosScheme`) to the allowed redirect URLs.
- Storage: the signed-URL and upload calls already go to the Supabase URL. Nothing else is needed.

#### Firebase (push for both platforms)
1. Create a Firebase project. Add an **Android app** and an **iOS app**, both with the bundle id above.
2. Android: download `google-services.json` to `android/app/`. The Capacitor template applies the Google Services plugin automatically when the file is there.
3. iOS:
   - Download `GoogleService-Info.plist`, then drag it into Xcode → App target.
   - In Xcode → File → Add Package Dependencies, add `https://github.com/firebase/firebase-ios-sdk` with the **FirebaseMessaging** product.
   - Apple Developer → Keys → create an **APNs Auth Key (.p8)**, then upload it in Firebase → Project settings → Cloud Messaging → Apple app configuration.
   - In Xcode → Signing & Capabilities, add **Push Notifications** and **Background Modes → Remote notifications**. Xcode links `App.entitlements`.
4. Server: in Firebase → Project settings → Service accounts, generate a key, then:
   ```
   supabase secrets set FCM_SERVICE_ACCOUNT="$(cat service-account.json)"
   ```
   The notifications dispatcher signs an OAuth token with it (RS256) and sends through FCM HTTP v1. The same dispatcher also keeps sending Web Push to browsers when the VAPID keys are set.

`google-services.json`, `GoogleService-Info.plist` and keystores are in `.gitignore`.

#### Android release
```bash
npm run mobile:build && npm run mobile:android     # opens Android Studio
```
1. Android Studio → Build → Generate Signed App Bundle. Keep the upload keystore outside git; Play App Signing holds the app key.
2. Play Console:
   - **Health apps declaration.** Sunrise provides consultations by registered doctors, not emergency services; the emergency notice is on every patient screen.
   - **Data safety:**
     - collected: name, phone, health info provided by the user, photos and files the user chooses;
     - encrypted in transit;
     - users can ask for deletion.
3. Requirements: minimum SDK 24 and target SDK 36, the Capacitor 8 defaults. Use JDK 21. iOS 15 or later.

#### iOS release
```bash
npm run mobile:build && npm run mobile:ios         # opens Xcode (needs macOS + Xcode 26)
```
1. Set the Team and bundle id. Archive → Distribute to App Store Connect.
2. App Store Connect:
   - **App Privacy** answers as for Play;
   - the permission texts above;
   - **medical** category.
3. Production push: archives use the `production` APNs environment automatically. The entitlement file says `development` for debug builds, and Xcode sets it per configuration.

### Checking a build on a device
- **Push:**
  1. Turn on Profile → Notifications → *Push on this device*.
  2. A row appears in `device_tokens` with platform `android` or `ios`.
  3. Book a consultation. The notification shows title and body only, and tapping it opens the secure link inside the app.
- **Video:** join a consultation. Android/iOS asks for camera and microphone once.
- **Camera:** pre-consultation → **Take photo** → the file uploads with progress.
- **Download:** Records → prescription → Download → "Saved … to Documents" (Files app on iOS).
- **Sign-out:** the row in `device_tokens` is removed.

> Built and checked here: the web build, the PWA (e2e) and the patch script against freshly generated Android and iOS projects, where the XML and plist were validated. **Not done here:** the native projects were not compiled, and nothing was run on a device or simulator. That needs Android Studio and Xcode with the Firebase files.
