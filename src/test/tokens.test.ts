import { readFileSync } from 'node:fs';
import { contrast, hslToRgb } from '@/lib/contrast';

/** Parses the design tokens from index.css and enforces WCAG 2.1 AA (4.5:1) for every text pair, in both themes. */
const css = readFileSync('src/styles/index.css', 'utf8');
const block = (selector: RegExp) => {
  const m = css.match(selector);
  if (!m) throw new Error('token block not found');
  return Object.fromEntries([...m[1].matchAll(/--([\w-]+):\s*([^;]+);/g)].map((x) => [x[1], x[2].trim()]));
};
const themes = {
  light: block(/:root,\s*\.light\s*\{([\s\S]*?)\n  \}/),
  dark: block(/\.dark\s*\{([\s\S]*?)\n  \}/),
};
const TEXT_PAIRS: [string, string][] = [
  ['foreground', 'background'],
  ['foreground', 'card'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'muted'],
  ['primary-foreground', 'primary'],
  ['primary', 'card'],
  ['primary', 'background'],
  ['primary-soft-foreground', 'primary-soft'],
  ['accent-foreground', 'accent'],
  ['highlight-foreground', 'highlight'],
  ['warning', 'highlight-soft'],
  ['warning', 'warning-soft'],
  ['success', 'success-soft'],
  ['success-foreground', 'success'],
  ['destructive', 'destructive-soft'],
  ['destructive', 'card'],
  ['destructive-foreground', 'destructive'],
  ['warning-foreground', 'warning'],
];

describe.each(Object.entries(themes))('%s theme tokens', (_name, vars) => {
  it.each(TEXT_PAIRS)('%s on %s meets AA 4.5:1', (fg, bg) => {
    const ratio = contrast(hslToRgb(vars[fg]), hslToRgb(vars[bg]));
    expect(ratio, `${fg}/${bg} = ${ratio.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
  });
  it('brand primary is the specified teal in light mode', () => {
    if (_name === 'light') expect(vars.primary).toBe('175 77% 26%');
  });
});
