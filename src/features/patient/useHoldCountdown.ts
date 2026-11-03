import { useCallback, useEffect, useRef, useState } from 'react';
import { getHold, type HoldStatus } from './api';

export type HoldPhase = 'loading' | 'active' | 'expired' | 'confirmed' | 'gone';

/**
 * Countdown for a 10-minute slot hold. Seconds left come from the SERVER clock (get_hold),
 * then tick locally against a monotonic deadline; re-synced whenever the tab becomes visible
 * again (phones throttle timers in the background). Calls onExpire once when it reaches 0.
 */
export function useHoldCountdown(appointmentId: string, onExpire: () => void) {
  const [phase, setPhase] = useState<HoldPhase>('loading');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const deadline = useRef<number | null>(null);
  const fired = useRef(false);
  const onExpireRef = useRef(onExpire);
  onExpireRef.current = onExpire;

  const expire = useCallback(() => {
    setSecondsLeft(0);
    setPhase('expired');
    if (!fired.current) {
      fired.current = true;
      onExpireRef.current();
    }
  }, []);

  const apply = useCallback(
    (h: HoldStatus | null) => {
      if (!h) return setPhase('gone');
      if (h.status === 'confirmed') return setPhase('confirmed');
      if (h.status !== 'pending_payment' || h.seconds_left <= 0) return expire();
      deadline.current = performance.now() + h.seconds_left * 1000;
      setSecondsLeft(h.seconds_left);
      setPhase('active');
    },
    [expire],
  );

  const sync = useCallback(() => getHold(appointmentId).then(apply).catch(() => undefined), [appointmentId, apply]);

  useEffect(() => {
    fired.current = false;
    void sync();
    const onVisible = () => document.visibilityState === 'visible' && void sync();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [sync]);

  useEffect(() => {
    if (phase !== 'active') return;
    const id = window.setInterval(() => {
      if (deadline.current == null) return;
      const left = Math.max(0, Math.ceil((deadline.current - performance.now()) / 1000));
      setSecondsLeft(left);
      if (left <= 0) {
        window.clearInterval(id);
        expire();
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [phase, expire]);

  return { phase, secondsLeft, resync: sync, markConfirmed: () => setPhase('confirmed') };
}
