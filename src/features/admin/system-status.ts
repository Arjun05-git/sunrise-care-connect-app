import { useQuery } from '@tanstack/react-query';
import { callFunction } from '@/lib/functions';

/** Mirrors supabase/functions/_shared/status.ts. Modes and short codes only; the server never sends a configured value. */
export type Mode = 'mock' | 'sandbox' | 'live' | 'unconfigured';
export type ProviderId = 'payments' | 'whatsapp' | 'sms' | 'push' | 'video' | 'his' | 'leadsquared' | 'abdm';
export type Area = 'payments' | 'notifications' | 'video' | 'integrations';

export interface ProviderStatus {
  id: ProviderId;
  area: Area;
  mode: Mode;
  detail?: string;
  note?: 'unverified_adapter';
}

export interface SystemStatus {
  environment: 'demo' | 'production';
  providers: ProviderStatus[];
  warnings: string[];
}

export const useSystemStatus = () =>
  useQuery({ queryKey: ['admin', 'system-status'], queryFn: () => callFunction<SystemStatus>('system-status', {}), staleTime: 60_000 });
