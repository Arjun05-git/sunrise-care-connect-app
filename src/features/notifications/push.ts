// Web Push on this device: service worker + PushManager subscription, stored server-side for the
// dispatcher. The VAPID public key is public by design (VITE_ variable); the private key stays server-side.
// Inside the Android/iOS app the same calls go to the native bridge (FCM device token) instead.
import { disableNativePush, enableNativePush, isNative, nativePushState } from '@/lib/native';
import { registerPush, removePush } from './api';

const KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
const webPushSupported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && !!KEY;
export const pushSupported = () => isNative() || webPushSupported();

const fromB64u = (s: string) => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(p + '='.repeat((4 - (p.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
const toB64u = (b: ArrayBuffer | null) => (b ? btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : '');

async function registration() {
  return (await navigator.serviceWorker.getRegistration('/')) ?? navigator.serviceWorker.register('/sw.js', { scope: '/' });
}
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!webPushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration('/');
  return reg ? reg.pushManager.getSubscription() : null;
}
/** Asks for permission (must follow a user tap) and registers this device. */
/** Whether this device (browser or app) currently receives push for the signed-in user. */
export const pushOnThisDevice = async () => (isNative() ? nativePushState() : !!(await currentSubscription()));
export async function enablePush(): Promise<'enabled' | 'denied' | 'unsupported'> {
  if (isNative()) return enableNativePush();
  if (!webPushSupported()) return 'unsupported';
  if ((await Notification.requestPermission()) !== 'granted') return 'denied';
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(KEY!) }));
  await registerPush({ endpoint: sub.endpoint, p256dh: toB64u(sub.getKey('p256dh')), auth: toB64u(sub.getKey('auth')) });
  return 'enabled';
}
export async function disablePush() {
  if (isNative()) return disableNativePush();
  const sub = await currentSubscription();
  if (!sub) return;
  await removePush(sub.endpoint).catch(() => undefined);
  await sub.unsubscribe();
}
