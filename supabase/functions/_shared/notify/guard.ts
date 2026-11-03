// Last line of defence before anything leaves the building: only whitelisted variables, and links only
// to our own sign-in-protected /l/<token> route. The database enforces the same (template whitelist,
// enqueue drops unknown variables); this catches a mis-configured template or code path.
import type { OutboundMessage } from './types.ts';

export const ALLOWED_VARS = ['name', 'doctor', 'date', 'time', 'ref', 'link', 'amount', 'response', 'otp', 'minutes'];
const LINK = /^https?:\/\/[^\s/]+(:\d+)?\/l\/[0-9a-f]{32}$/;

export function checkMessage(m: OutboundMessage): string | null {
  for (const k of Object.keys(m.variables ?? {})) if (!ALLOWED_VARS.includes(k)) return `variable_not_allowed:${k}`;
  if (m.link && !LINK.test(m.link)) return 'link_not_allowed';
  // every URL in the text must be our secure link
  for (const url of m.text.match(/https?:\/\/\S+/g) ?? []) if (url !== m.link) return 'url_not_allowed';
  if (m.text.length > 1000) return 'too_long';
  return null;
}

/** SMS parts: GSM-7 160 / 153 per part, Unicode (e.g. Malayalam) 70 / 67 per part. */
export function smsParts(text: string): number {
  const unicode = /[^\x0A\x0D\x20-\x7E£¥èéùìòÇØøÅå_ÆæßÉ¡ÄÖÑÜ§¿äöñüà€]/.test(text);
  const single = unicode ? 70 : 160;
  const multi = unicode ? 67 : 153;
  return text.length <= single ? 1 : Math.ceil(text.length / multi);
}

/** E.164 for India without the plus, as WhatsApp / MSG91 expect: 919847000001. */
export function msisdn(phone: string | null): string | null {
  const d = (phone ?? '').replace(/\D/g, '');
  if (d.length === 10) return `91${d}`;
  if (d.length === 12 && d.startsWith('91')) return d;
  return null;
}
