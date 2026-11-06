// Finds code whose result depends on the machine's time zone. The product runs on Asia/Kolkata: every date shown,
// grouped or compared must go through src/domain/time.ts (browser) or supabase/functions/_shared/time.ts (server),
// which pin the zone. Used by scripts/timezone-hazards.test.ts so a regression fails the build.
//
// A line containing `tz-scan:allow` is skipped (say why next to it).

const LOCAL_API = /\.(getHours|getMinutes|getSeconds|getMilliseconds|getDay|getDate|getMonth|getFullYear|getYear|setHours|setMinutes|setSeconds|setMilliseconds|setDate|setMonth|setFullYear|getTimezoneOffset)\(/g;
const ALWAYS_LOCAL_FORMAT = /\.(toLocaleDateString|toLocaleTimeString|toDateString|toTimeString)\(/g;
const DATE_FIELDS = /\b(day|month|year|weekday|hour|minute|second|era|dateStyle|timeStyle|dayPeriod)\b/;
const DATE_ONLY_PARSE = /new Date\(\s*(['"`])\d{4}-\d{2}-\d{2}\1\s*\)/g;

/** Text between the parenthesis at `open` and its matching close (balanced, strings not parsed: good enough for lint). */
function argsAt(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

export function findTimezoneHazards(source, file = '') {
  const found = [];
  const lineOf = (idx) => source.slice(0, idx).split('\n').length;
  const add = (rule, idx) => {
    const line = lineOf(idx);
    if (!source.split('\n')[line - 1].includes('tz-scan:allow')) found.push({ rule, line, file });
  };

  for (const m of source.matchAll(LOCAL_API)) add('local-date-api', m.index);
  for (const m of source.matchAll(ALWAYS_LOCAL_FORMAT)) add('local-date-format', m.index);
  for (const m of source.matchAll(DATE_ONLY_PARSE)) add('date-only-parse', m.index);
  // toLocaleString is also how numbers are formatted: only a problem when it formats date fields without a zone
  for (const m of source.matchAll(/\.toLocaleString\(/g)) {
    const args = argsAt(source, m.index + m[0].length - 1);
    if (DATE_FIELDS.test(args) && !/\btimeZone\b/.test(args)) add('local-date-format', m.index);
  }
  for (const m of source.matchAll(/Intl\.DateTimeFormat\(/g)) {
    if (!/\btimeZone\b/.test(argsAt(source, m.index + m[0].length - 1))) add('local-date-format', m.index);
  }
  return found.sort((a, b) => a.line - b.line);
}
