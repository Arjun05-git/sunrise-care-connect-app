// Native (Capacitor) bridge. The same React build runs in the browser and inside the Android/iOS
// shells; everything here is a no-op on the web. Plugins load on demand so the web bundle stays lean.
//
// Push: the device's FCM token goes to register_device_token (FCM HTTP v1 sends to both platforms;
// iOS through the APNs key uploaded to Firebase). Messages carry no clinical details; tapping one
// opens its in-app link (/l/<token>), which asks for sign-in and checks the account.
import { Capacitor } from '@capacitor/core';
import { getSupabase } from './supabase';

export const isNative = () => Capacitor.isNativePlatform();
export const nativePlatform = () => Capacitor.getPlatform() as 'android' | 'ios' | 'web';

const TOKEN_KEY = 'scc-device-token';
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const writeToken = (v: string | null) => { try { if (v) localStorage.setItem(TOKEN_KEY, v); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ } };

/** Only same-app paths are opened from a notification; anything else goes to the home screen. */
export const safeAppPath = (url: unknown) => {
  if (typeof url !== 'string' || /[\\\s]/.test(url)) return '/';   // backslashes / whitespace: open-redirect tricks
  try {
    const u = new URL(url, 'https://app.invalid');
    if (u.origin !== 'https://app.invalid' && u.origin !== window.location.origin) return '/';
    return u.pathname.startsWith('//') ? '/' : `${u.pathname}${u.search}`;
  } catch { return '/'; }
};

/** Once at start-up: status bar, splash, Android back button, notification taps. */
export async function initNative(navigate: (path: string) => void) {
  if (!isNative()) return;
  const [{ App }, { SplashScreen }, { StatusBar, Style }, { PushNotifications }] = await Promise.all([
    import('@capacitor/app'), import('@capacitor/splash-screen'), import('@capacitor/status-bar'), import('@capacitor/push-notifications'),
  ]);
  void StatusBar.setStyle({ style: Style.Light }).catch(() => undefined);
  if (nativePlatform() === 'android') void StatusBar.setBackgroundColor({ color: '#0F766E' }).catch(() => undefined);
  void App.addListener('backButton', ({ canGoBack }) => { if (canGoBack) window.history.back(); else void App.minimizeApp(); });
  void PushNotifications.addListener('pushNotificationActionPerformed', (a) => navigate(safeAppPath(a.notification.data?.url)));
  // Android 8+ needs the channel the server names (fcm.ts → sunrise_default).
  if (nativePlatform() === 'android') {
    void PushNotifications.createChannel({ id: 'sunrise_default', name: 'Sunrise Care', description: 'Appointment updates and reminders', importance: 4, visibility: 0 }).catch(() => undefined);
  }
  void SplashScreen.hide();
}

export async function nativePushState(): Promise<boolean> {
  if (!isNative()) return false;
  const { PushNotifications } = await import('@capacitor/push-notifications');
  return (await PushNotifications.checkPermissions()).receive === 'granted' && !!readToken();
}

/** Asks for permission (after a user tap) and stores this device's token for the signed-in user. */
export async function enableNativePush(): Promise<'enabled' | 'denied' | 'unsupported'> {
  if (!isNative()) return 'unsupported';
  const { PushNotifications } = await import('@capacitor/push-notifications');
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') return 'denied';
  const token = await new Promise<string>((resolve, reject) => {
    const subs = [
      PushNotifications.addListener('registration', (t) => { void Promise.all(subs).then((s) => s.forEach((h) => void h.remove())); resolve(t.value); }),
      PushNotifications.addListener('registrationError', (e) => { void Promise.all(subs).then((s) => s.forEach((h) => void h.remove())); reject(new Error(e.error)); }),
    ];
    void PushNotifications.register();
  });
  const { App } = await import('@capacitor/app');
  const info = await App.getInfo().catch(() => null);
  const { error } = await getSupabase().rpc('register_device_token', { p_platform: nativePlatform(), p_token: token, p_app_version: info ? `${info.version} (${info.build})` : null });
  if (error) throw error;
  writeToken(token);
  return 'enabled';
}

/** Stops push to this device for the current account (switching off, or signing out). */
export async function disableNativePush() {
  const token = readToken();
  if (!isNative() || !token) return;
  await getSupabase().rpc('remove_device_token', { p_token: token }).then(() => undefined, () => undefined);
  writeToken(null);
  const { PushNotifications } = await import('@capacitor/push-notifications');
  await PushNotifications.unregister().catch(() => undefined);
}

/**
 * Takes a photo (or picks one from the gallery) and returns it as a File for the normal upload path,
 * which still checks type and size. Returns null on the web (use the file input) or if cancelled.
 * The image is read straight into memory; nothing is written to the device's storage.
 */
export async function takePhoto(source: 'camera' | 'photos'): Promise<File | null> {
  if (!isNative()) return null;
  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
  try {
    const p = await Camera.getPhoto({ resultType: CameraResultType.Uri, source: source === 'camera' ? CameraSource.Camera : CameraSource.Photos, quality: 80, width: 2400, correctOrientation: true, saveToGallery: false });
    if (!p.webPath) return null;
    const blob = await (await fetch(p.webPath)).blob();
    const ext = p.format === 'png' ? 'png' : 'jpg';
    return new File([blob], `photo-${Date.now()}.${ext}`, { type: ext === 'png' ? 'image/png' : 'image/jpeg' });
  } catch {
    return null; // cancelled or permission denied
  }
}

/**
 * Saves a file the user asked to download (e.g. their prescription PDF) to the app's Documents folder
 * and returns its URI. On the web the caller keeps the normal browser download.
 */
export async function saveToDevice(name: string, blob: Blob): Promise<string | null> {
  if (!isNative()) return null;
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const data = await new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
  const res = await Filesystem.writeFile({ path: name.replace(/[^\w.-]+/g, '_'), data, directory: Directory.Documents, recursive: true });
  return res.uri;
}
