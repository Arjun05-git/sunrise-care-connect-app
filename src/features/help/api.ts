import { useQuery } from '@tanstack/react-query';
import { getSupabase } from '@/lib/supabase';
import type { TicketDetail, TicketMessage } from '@/features/admin/console-api';

export { createTicket, postTicketMessage, TICKET_CATEGORIES } from '@/features/admin/console-api';
const sb = () => getSupabase();
async function unwrap<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data as T;
}

/** The signed-in user's own tickets (RLS: own rows; internal staff notes never reach the user). */
export const useMyTickets = () =>
  useQuery({ queryKey: ['help', 'tickets'], queryFn: async () => (await unwrap(sb().from('support_tickets').select('*').order('updated_at', { ascending: false }))) as unknown as TicketDetail[] });
export const useMyTicket = (id: string) =>
  useQuery({
    queryKey: ['help', 'ticket', id],
    queryFn: async () => {
      const [ticket, messages] = await Promise.all([
        unwrap(sb().from('support_tickets').select('*').eq('id', id).single()),
        unwrap(sb().from('ticket_messages').select('*').eq('ticket_id', id).order('created_at')),
      ]);
      return { ticket: ticket as unknown as TicketDetail, messages: messages as TicketMessage[] };
    },
  });
export const useMyRecentAppointments = () =>
  useQuery({
    queryKey: ['help', 'appts'],
    queryFn: async () => (await unwrap(sb().from('appointments').select('id, ref_code, start_at').neq('status', 'rescheduled').order('start_at', { ascending: false }).limit(10))) as { id: string; ref_code: string; start_at: string }[],
  });
