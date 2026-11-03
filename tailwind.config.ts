import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * Tailwind theme = shadcn/ui token convention + Sunrise brand extras.
 * All colours are CSS variables (src/styles/index.css) so branding can be swapped without touching components.
 */
const c = (name: string) => `hsl(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: { center: true, padding: '1rem', screens: { '2xl': '1280px' } },
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'Inter', 'system-ui', 'sans-serif'],
        ml: ['"Noto Sans Malayalam"', '"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
      },
      colors: {
        border: c('border'),
        input: c('input'),
        ring: c('ring'),
        background: c('background'),
        foreground: c('foreground'),
        primary: { DEFAULT: c('primary'), foreground: c('primary-foreground'), soft: c('primary-soft'), 'soft-foreground': c('primary-soft-foreground') },
        secondary: { DEFAULT: c('secondary'), foreground: c('secondary-foreground') },
        muted: { DEFAULT: c('muted'), foreground: c('muted-foreground') },
        accent: { DEFAULT: c('accent'), foreground: c('accent-foreground') },
        /** Brand warm amber for highlights (badges, offers, "free follow-up"). */
        highlight: { DEFAULT: c('highlight'), foreground: c('highlight-foreground'), soft: c('highlight-soft') },
        success: { DEFAULT: c('success'), foreground: c('success-foreground'), soft: c('success-soft') },
        warning: { DEFAULT: c('warning'), foreground: c('warning-foreground'), soft: c('warning-soft') },
        destructive: { DEFAULT: c('destructive'), foreground: c('destructive-foreground'), soft: c('destructive-soft') },
        card: { DEFAULT: c('card'), foreground: c('card-foreground') },
        popover: { DEFAULT: c('popover'), foreground: c('popover-foreground') },
      },
      borderRadius: { lg: 'var(--radius)', md: 'calc(var(--radius) - 4px)', sm: 'calc(var(--radius) - 8px)', xl: 'calc(var(--radius) + 4px)' },
      boxShadow: {
        soft: '0 1px 2px hsl(222 47% 11% / 0.04), 0 4px 16px hsl(222 47% 11% / 0.06)',
        lift: '0 2px 4px hsl(222 47% 11% / 0.06), 0 12px 32px hsl(222 47% 11% / 0.10)',
      },
      spacing: { tap: '2.75rem' },
      minHeight: { tap: '2.75rem' },
      minWidth: { tap: '2.75rem' },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
      },
      animation: { 'fade-up': 'fade-up 250ms ease-out' },
    },
  },
  plugins: [animate],
} satisfies Config;
