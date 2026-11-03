import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * One-time-code input (6 boxes by default). Supports paste, SMS autofill (`autocomplete=one-time-code`),
 * backspace navigation and secret mode for PINs. Each box is labelled for screen readers.
 */
export function InputOTP({ value, onChange, length = 6, label, secret, invalid, autoFocus }: { value: string; onChange: (v: string) => void; length?: number; label: string; secret?: boolean; invalid?: boolean; autoFocus?: boolean }) {
  const refs = React.useRef<(HTMLInputElement | null)[]>([]);
  const setAt = (i: number, ch: string) => {
    const chars = value.split('');
    chars[i] = ch;
    onChange(chars.join('').slice(0, length));
  };
  return (
    <div role="group" aria-label={label} className="flex justify-center gap-2">
      {Array.from({ length }).map((_, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          autoFocus={autoFocus && i === 0}
          type={secret ? 'password' : 'text'}
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          maxLength={length}
          aria-label={`${label} ${i + 1}`}
          aria-invalid={invalid || undefined}
          value={value[i] ?? ''}
          onChange={(e) => {
            const digits = e.target.value.replace(/\D/g, '');
            if (digits.length > 1) {
              onChange(digits.slice(0, length));
              refs.current[Math.min(digits.length, length) - 1]?.focus();
              return;
            }
            setAt(i, digits);
            if (digits && i < length - 1) refs.current[i + 1]?.focus();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !value[i] && i > 0) refs.current[i - 1]?.focus();
          }}
          className={cn('h-14 w-11 rounded-xl border bg-card text-center text-xl font-bold shadow-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/25 sm:w-12', invalid ? 'border-destructive' : 'border-input')}
        />
      ))}
    </div>
  );
}
