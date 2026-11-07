import { useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { RealtimeChannel, RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { isDemo } from './config';
import { ensureRealtimeAuth, getSupabase } from './supabase';

export interface RealtimeSource {
  table: 'appointments' | 'reschedule_requests' | 'notifications' | 'slots' | 'chat_messages' | 'call_logs' | 'recording_consents' | 'consult_recordings';
  /** PostgREST-style filter Supabase Realtime understands, e.g. `doctor_id=eq.<uuid>` */
  filter?: string;
}
export type LiveState = 'connecting' | 'live' | 'offline';

/**
 * Supabase Realtime (postgres_changes): when a subscribed row changes, refetch the given queries.
 * Realtime enforces RLS per subscriber, so only rows the user may read arrive. Payloads are used
 * only as a signal – data is always re-read through the normal (RLS-checked) queries.
 */
export function useRealtime(name: string, sources: RealtimeSource[], invalidate: QueryKey[], onChange?: (p: RealtimePostgresChangesPayload<Record<string, unknown>>) => void, enabled = true) {
  const qc = useQueryClient();
  const [state, setState] = useState<LiveState>('connecting');
  const cb = useRef(onChange);
  cb.current = onChange;
  const keys = useRef(invalidate);
  keys.current = invalidate;
  const signature = JSON.stringify(sources);

  useEffect(() => {
    if (isDemo || !enabled) return;
    const sb = getSupabase();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    let attempts = 0;
    let channel: RealtimeChannel | null = null;

    const open = () => {
      let ch = sb.channel(`${name}:${Math.random().toString(36).slice(2, 8)}`);
      for (const s of JSON.parse(signature) as RealtimeSource[]) {
        ch = ch.on('postgres_changes', { event: '*', schema: 'public', table: s.table, ...(s.filter ? { filter: s.filter } : {}) }, (payload) => {
          cb.current?.(payload as RealtimePostgresChangesPayload<Record<string, unknown>>);
          // coalesce bursts (one booking move touches several rows) into one refetch
          clearTimeout(timer);
          timer = setTimeout(() => keys.current.forEach((k) => void qc.invalidateQueries({ queryKey: k })), 150);
        });
      }
      channel = ch;
      // join only once the user's token is set – otherwise RLS (rightly) filters every change out
      void ensureRealtimeAuth().then(() => {
        if (cancelled || channel !== ch) return;
        ch.subscribe((status) => {
          if (channel !== ch) return;
          if (status === 'SUBSCRIBED') {
            attempts = 0;
            setState('live');
            keys.current.forEach((k) => void qc.invalidateQueries({ queryKey: k })); // catch up on anything missed while connecting
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            setState('offline');
            // a channel whose join was lost (e.g. subscribed while the socket was still connecting) can keep
            // retrying a stale join forever – replace it with a fresh channel instead (bounded, backing off)
            if (status !== 'CLOSED' && !cancelled && attempts < 6) {
              attempts += 1;
              channel = null;
              void sb.removeChannel(ch);
              retryTimer = setTimeout(() => !cancelled && open(), Math.min(1000 * 2 ** (attempts - 1), 30000));
            }
          }
        });
      });
    };
    open();

    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      if (channel) void sb.removeChannel(channel);
    };
  }, [name, signature, enabled, qc]);

  return state;
}
