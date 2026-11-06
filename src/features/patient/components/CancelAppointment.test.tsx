import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FunctionError } from '@/lib/functions';
import * as api from '../api';
import type { CancelQuote, MyAppointment } from '../api';
import { CancelAppointment } from './CancelAppointment';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('../api', async (orig) => ({ ...(await orig<typeof import('../api')>()), useCancelQuote: vi.fn(), cancelAppointment: vi.fn() }));

const FUTURE = new Date(Date.now() + 5 * 3600_000).toISOString();
const appt = (over: Record<string, unknown> = {}) =>
  ({ id: 'a1', status: 'confirmed', start_at: FUTURE, reschedule_requests: [], doctors: { full_name: 'Dr. Arun Nair' }, ...over }) as unknown as MyAppointment;
const quote = (over: Partial<CancelQuote> = {}): CancelQuote => ({ rule: 'tier', percent: 50, amount: 400, paid: 800, refundable: 800, hours_before: 5, ...over });
const withQuote = (data: CancelQuote | undefined, state: { isPending?: boolean; isError?: boolean } = {}) =>
  vi.mocked(api.useCancelQuote).mockReturnValue({ data, isPending: !!state.isPending, isError: !!state.isError } as never);

const open = (a = appt()) => {
  render(<QueryClientProvider client={new QueryClient()}><CancelAppointment a={a} /></QueryClientProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel appointment' }));
};

afterEach(() => vi.clearAllMocks());

describe('CancelAppointment', () => {
  it('offers nothing for a booking that cannot be cancelled', () => {
    withQuote(quote());
    render(<QueryClientProvider client={new QueryClient()}><CancelAppointment a={appt({ status: 'completed' })} /></QueryClientProvider>);
    expect(screen.queryByRole('button', { name: 'Cancel appointment' })).not.toBeInTheDocument();
  });

  it('asks first, naming the doctor, and shows the refund before anything is cancelled', () => {
    withQuote(quote());
    open();
    expect(screen.getByText('Cancel this appointment?')).toBeInTheDocument();
    expect(screen.getByText(/Dr\. Arun Nair/)).toBeInTheDocument();
    expect(screen.getByText(/refunded ₹400/)).toBeInTheDocument();
    expect(screen.getByText(/50%/)).toBeInTheDocument();
    expect(api.cancelAppointment).not.toHaveBeenCalled();
  });

  it('says plainly when the policy gives no refund this close to the start', () => {
    withQuote(quote({ percent: 0, amount: 0 }));
    open();
    expect(screen.getByText(/no refund this close to the appointment/i)).toBeInTheDocument();
  });

  it('says there is nothing to refund when nothing was paid', () => {
    withQuote(quote({ rule: 'free_consult', paid: 0, amount: 0, refundable: 0, percent: 0 }));
    open();
    expect(screen.getByText(/nothing to refund/i)).toBeInTheDocument();
  });

  it('waits for the refund amount before the cancel button works', () => {
    withQuote(undefined, { isPending: true });
    open();
    expect(screen.getByText(/checking your refund/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, cancel appointment' })).toBeDisabled();
  });

  it('still lets the patient cancel if the refund amount cannot be fetched', () => {
    withQuote(undefined, { isError: true });
    open();
    expect(screen.getByText(/couldn.t check the refund amount/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Yes, cancel appointment' })).toBeEnabled();
  });

  it('"Keep appointment" closes the dialog and cancels nothing', () => {
    withQuote(quote());
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Keep appointment' }));
    expect(api.cancelAppointment).not.toHaveBeenCalled();
    expect(screen.queryByText('Cancel this appointment?')).not.toBeInTheDocument();
  });

  it('confirming cancels with the typed reason, reports the refund and closes', async () => {
    withQuote(quote());
    vi.mocked(api.cancelAppointment).mockResolvedValue({ refund_id: 'r1' } as never);
    open();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: 'Feeling better' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel appointment' }));
    await waitFor(() => expect(api.cancelAppointment).toHaveBeenCalledWith('a1', 'Feeling better'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/cancelled.*₹400/)));
    await waitFor(() => expect(screen.queryByText('Cancel this appointment?')).not.toBeInTheDocument());
  });

  it('explains a refusal from the server (already started) and does not claim success', async () => {
    withQuote(quote());
    vi.mocked(api.cancelAppointment).mockRejectedValue(new FunctionError('too_late', 409));
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel appointment' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/already started/i)));
    expect(toast.success).not.toHaveBeenCalled();
  });
});
