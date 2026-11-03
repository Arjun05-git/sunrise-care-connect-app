import { config } from './config';
import { getSupabase } from './supabase';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { isNative, saveToDevice } from './native';

/** Error from an edge function: `code` is the stable error code ("hold_expired", "bad_signature", …). */
export class FunctionError extends Error {
  constructor(public code: string, public status: number) {
    super(code);
  }
}

async function call(name: string, body: unknown): Promise<Response> {
  const { data } = await getSupabase().auth.getSession();
  const res = await fetch(`${config.supabaseUrl}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: config.supabaseAnonKey, Authorization: `Bearer ${data.session?.access_token ?? config.supabaseAnonKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new FunctionError(err?.error ?? 'internal_error', res.status);
  }
  return res;
}

export const callFunction = async <T>(name: string, body: unknown): Promise<T> => (await call(name, body)).json() as Promise<T>;

/** Function that returns a file (receipt PDF): triggers a browser download. */
export async function downloadFunctionFile(name: string, body: unknown, fallbackName: string) {
  const res = await call(name, body);
  const fileName = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const blob = await res.blob();
  // The app's WebView can't follow <a download>; save to the app's Documents folder instead (user-initiated only).
  if (isNative()) {
    await saveToDevice(fileName, blob);
    toast.success(i18n.t('native.saved', { name: fileName }));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: fileName });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
