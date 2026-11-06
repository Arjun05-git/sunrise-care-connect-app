// Secret detection shared by scripts/scan-secrets.mjs (repo, staged files, git history) and scripts/check-bundle.mjs
// (the built app). Dependency-free on purpose. Findings never contain the secret itself, only its first characters.
//
// A line containing `secret-scan:allow` is skipped (use it, with a reason, for documented non-secret values).

const PLACEHOLDER_WORDS = /(mock|example|dummy|placeholder|changeme|change-me|do-not-use|not-a-secret|sample|fake|redacted)/i;
const PLACEHOLDER_WHOLE = /^(<.*>|\[.*\]|\$\{.*\}|\$[A-Za-z_][A-Za-z0-9_]*|env\(.*\)|x{4,}|\*{3,}|\.{3,}|your[-_ ].*|todo.*|none|null|true|false)$/i;
const LOCAL_PREFIX = /^(local|test|dev)[-_]/i;
const LOCAL_HOSTS = /^(localhost|127\.0\.0\.1|\[?::1\]?|host\.docker\.internal|0\.0\.0\.0)$/i;

/** Placeholders, empty values and obviously local / mock values are not secrets. */
export function isPlaceholder(value) {
  const v = String(value ?? '').trim().replace(/^["']|["']$/g, '');
  if (v === '') return true;
  if (PLACEHOLDER_WHOLE.test(v) || PLACEHOLDER_WORDS.test(v) || LOCAL_PREFIX.test(v)) return true;
  if (/[()]/.test(v) || /^(process|Deno|import)\./.test(v)) return true; // a code expression, not a literal
  return new Set(v).size <= 2; // 'aaaaaaaa…'
}

const redact = (value) => `${String(value).slice(0, 4)}…(${String(value).length})`;

function jwtRole(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).role;
  } catch {
    return undefined;
  }
}

/** Each rule returns the secret text it found on the line, or null. `client` rules also run on built bundles. */
const RULES = [
  { id: 'supabase-service-role-jwt', client: true, find: (l) => (l.match(/eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g) ?? []).find((t) => jwtRole(t) === 'service_role') ?? null },
  { id: 'supabase-secret-key', client: true, find: (l) => l.match(/\bsb_secret_[A-Za-z0-9_-]{20,}/)?.[0] ?? null },
  { id: 'private-key', client: true, find: (l) => l.match(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/)?.[0] ?? null },
  { id: 'razorpay-live-key', client: true, find: (l) => l.match(/\brzp_live_[A-Za-z0-9]{10,}/)?.[0] ?? null },
  { id: 'stripe-live-key', client: true, find: (l) => l.match(/\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/)?.[0] ?? null },
  { id: 'aws-access-key', client: true, find: (l) => l.match(/\bAKIA[0-9A-Z]{16}\b/)?.[0] ?? null },
  { id: 'github-token', client: true, find: (l) => l.match(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}/)?.[0] ?? null },
  { id: 'slack-token', client: true, find: (l) => l.match(/\bxox[baprs]-[A-Za-z0-9-]{10,}/)?.[0] ?? null },
  { id: 'google-api-key', client: true, find: (l) => l.match(/\bAIza[0-9A-Za-z_-]{35}\b/)?.[0] ?? null },
  {
    id: 'database-url-password',
    client: true,
    find: (l) => {
      const m = l.match(/\bpostgres(?:ql)?:\/\/[^:\s/@]+:([^@\s]+)@([^\s/:?]+)/);
      return m && !isPlaceholder(m[1]) && !LOCAL_HOSTS.test(m[2]) && !m[2].startsWith('$') ? m[1] : null;
    },
  },
  {
    id: 'secret-assignment',
    client: false,
    find: (l) => {
      const m = l.match(/\b[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_KEY|API_KEY|AUTH_KEY|SERVICE_ROLE(?:_KEY)?|ACCESS_KEY)[A-Z0-9_]*\s*[=:]\s*["']?([^\s"'#]{16,})/);
      return m && !isPlaceholder(m[1]) ? m[1] : null;
    },
  },
  // A VITE_ variable is compiled into the app and public: a secret-looking NAME is wrong whatever the value.
  { id: 'secret-in-client-env', client: false, find: (l) => l.match(/^\s*(?:export\s+)?(VITE_[A-Z0-9_]*(?:SECRET|SERVICE_ROLE|PRIVATE|PASSWORD)[A-Z0-9_]*)\s*=/)?.[1] ?? null },
];

export const RULE_IDS = RULES.map((r) => r.id);

/** Scan text line by line. opts.bundle: only the high-confidence token rules (for minified build output). */
export function scanText(text, file = '', opts = {}) {
  const findings = [];
  const rules = opts.bundle ? RULES.filter((r) => r.client) : RULES;
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('secret-scan:allow')) continue;
    for (const rule of rules) {
      const hit = rule.find(line);
      if (hit) findings.push({ rule: rule.id, file, line: i + 1, preview: rule.id === 'secret-in-client-env' ? hit : redact(hit) });
    }
  }
  return findings;
}

const SKIP = /(^|\/)(node_modules|dist|\.git)\/|(^|\/)package-lock\.json$|\.lock$|\.(png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|otf|keystore|jks|zip|gz)$/i;
export function shouldScan(path) {
  return !SKIP.test(String(path).replace(/\\/g, '/'));
}
