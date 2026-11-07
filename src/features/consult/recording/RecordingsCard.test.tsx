import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from './api';
import { RecordingsCard } from './RecordingsCard';

vi.mock('./api', () => ({ useRecordingState: vi.fn(), playRecording: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) }));

const row = (id: string, status: string) => ({ id, status, stop_reason: null, started_at: '2026-11-07T04:00:00Z', ended_at: '2026-11-07T04:10:00Z', duration_seconds: 600 });
const show = (recordings: ReturnType<typeof row>[]) => {
  vi.mocked(api.useRecordingState).mockReturnValue({ data: { consents: [], recordings } } as never);
  return render(<QueryClientProvider client={new QueryClient()}><RecordingsCard appointmentId="a1" /></QueryClientProvider>);
};

describe('RecordingsCard', () => {
  it('shows nothing when the appointment has no ready recording', () => {
    const { container } = show([row('r1', 'failed'), row('r2', 'recording')]);
    expect(container).toBeEmptyDOMElement();
  });
  it('plays a ready recording through the audited link, and only on request', async () => {
    vi.mocked(api.playRecording).mockResolvedValue({ url: 'https://signed.example/joined.webm', expires_in: 300, mime_type: 'audio/webm' });
    const { container } = show([row('r1', 'ready')]);
    expect(api.playRecording).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'consult.rec.play' }));
    await waitFor(() => expect(api.playRecording).toHaveBeenCalledWith('r1'));
    await waitFor(() => expect(container.querySelector('audio')?.getAttribute('src')).toBe('https://signed.example/joined.webm'));
  });
  it('says so when the recording cannot be played', async () => {
    vi.mocked(api.playRecording).mockRejectedValue(new Error('parts_missing'));
    show([row('r1', 'ready')]);
    fireEvent.click(screen.getByRole('button', { name: 'consult.rec.play' }));
    expect(await screen.findByText('consult.rec.playFailed')).toBeInTheDocument();
  });
});
