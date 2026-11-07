import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import * as api from './api';
import { derivePhase, useRecording } from './useRecording';

const fakes = vi.hoisted(() => {
  class FakeCapture {
    static supported = vi.fn(() => true);
    static instances: FakeCapture[] = [];
    started = false; stopped = false; mimeType = 'audio/webm';
    constructor(public getTracks: () => unknown[], public onChunk: (b: Blob) => void) { FakeCapture.instances.push(this); }
    start() { if (!this.getTracks().length) throw new Error('no_audio'); this.started = true; }
    async stop() { this.stopped = true; }
  }
  class FakeUploader {
    static instances: FakeUploader[] = [];
    static result: { parts: number; bytes: number; failed: boolean; reason?: string } = { parts: 3, bytes: 4200, failed: false };
    constructor(public prefix: string, public upload: unknown, public opts: unknown) { FakeUploader.instances.push(this); }
    push() {}
    async drain() { return FakeUploader.result; }
  }
  return { FakeCapture, FakeUploader };
});
vi.mock('./capture', () => ({ AudioCapture: fakes.FakeCapture }));
vi.mock('./uploader', () => ({ ChunkUploader: fakes.FakeUploader }));
vi.mock('@/lib/realtime', () => ({ useRealtime: vi.fn() }));
vi.mock('./api', () => ({
  useRecordingEnabled: vi.fn(), useRecordingState: vi.fn(), setRecordingConsent: vi.fn(), startRecording: vi.fn(), stopRecording: vi.fn(),
  finishRecording: vi.fn(), failRecording: vi.fn(), uploadPart: vi.fn(), recordingKey: (id: string) => ['recording', id],
}));

type Rows = { consents: { party: 'doctor' | 'patient'; withdrawn_at: string | null }[]; recordings: { id: string; status: string; stop_reason: string | null; started_at: string; ended_at: string | null; duration_seconds: number | null }[] };
const both: Rows['consents'] = [{ party: 'doctor', withdrawn_at: null }, { party: 'patient', withdrawn_at: null }];
const rec = (over: Partial<Rows['recordings'][number]> = {}) => ({ id: 'rec1', status: 'recording', stop_reason: null, started_at: new Date().toISOString(), ended_at: null, duration_seconds: null, ...over });
const live = { id: 'mic', kind: 'audio', readyState: 'live' };

let data: Rows;
const setData = (d: Partial<Rows>) => { data = { consents: [], recordings: [], ...d }; vi.mocked(api.useRecordingState).mockReturnValue({ data } as never); };

function mount(role: 'doctor' | 'patient', callOver: Record<string, unknown> = {}) {
  const call = { provider: 'livekit', phase: 'connected', audioTracks: () => [live], ...callOver };
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>;
  return renderHook((p: { call: typeof call }) => useRecording({ appointmentId: 'a1', role, call: p.call as never }), { wrapper, initialProps: { call } });
}

beforeEach(() => {
  vi.mocked(api.useRecordingEnabled).mockReturnValue({ data: true } as never);
  vi.mocked(api.setRecordingConsent).mockResolvedValue({} as never);
  vi.mocked(api.startRecording).mockResolvedValue({ id: 'rec1', storage_prefix: 'recordings/a1/rec1/', kind: 'audio' });
  vi.mocked(api.stopRecording).mockResolvedValue({} as never);
  vi.mocked(api.finishRecording).mockResolvedValue({} as never);
  vi.mocked(api.failRecording).mockResolvedValue({} as never);
  fakes.FakeCapture.supported.mockReturnValue(true);
  fakes.FakeCapture.instances.length = 0;
  fakes.FakeUploader.instances.length = 0;
  fakes.FakeUploader.result = { parts: 3, bytes: 4200, failed: false };
  setData({});
});
afterEach(() => vi.clearAllMocks());

describe('derivePhase', () => {
  const d = (over: Partial<Parameters<typeof derivePhase>[0]>) => derivePhase({ enabled: true, role: 'doctor', mine: false, theirs: false, active: false, saving: false, capturing: false, ...over });
  it('is off when the hospital has not switched recording on', () => expect(d({ enabled: false, mine: true, theirs: true })).toBe('off'));
  it('doctor: nobody has agreed → idle; only the doctor → asked; both → ready', () => {
    expect(d({})).toBe('idle');
    expect(d({ mine: true })).toBe('asked');
    expect(d({ mine: true, theirs: true })).toBe('ready');
  });
  it('patient: the doctor asked → invited; both → ready', () => {
    expect(d({ role: 'patient' })).toBe('idle');
    expect(d({ role: 'patient', theirs: true })).toBe('invited');
    expect(d({ role: 'patient', mine: true, theirs: true })).toBe('ready');
  });
  it('a recording in progress is "recording" for both; for the doctor without a running capture it is "interrupted"', () => {
    expect(d({ active: true, capturing: true, mine: true, theirs: true })).toBe('recording');
    expect(d({ role: 'patient', active: true, mine: true, theirs: true })).toBe('recording');
    expect(d({ active: true, capturing: false, mine: true, theirs: true })).toBe('interrupted');
  });
  it('while the media is being saved it is "saving"', () => expect(d({ saving: true, mine: true, theirs: true })).toBe('saving'));
});

describe('useRecording – doctor', () => {
  it('asking for consent records the doctor\'s consent; withdrawing the request withdraws it', async () => {
    const { result } = mount('doctor');
    await act(() => result.current.giveConsent());
    expect(api.setRecordingConsent).toHaveBeenCalledWith('a1', true);
    await act(() => result.current.withdrawConsent());
    expect(api.setRecordingConsent).toHaveBeenLastCalledWith('a1', false);
  });

  it('a Jitsi call cannot be recorded (its audio is not reachable): the reason is shown and nothing is started', async () => {
    setData({ consents: both });
    const { result } = mount('doctor', { provider: 'jitsi', audioTracks: () => [] });
    expect(result.current.canRecord).toEqual({ ok: false, reason: 'provider' });
    await act(() => result.current.start());
    expect(api.startRecording).not.toHaveBeenCalled();
    expect(result.current.error).toBe('unsupported_provider');
  });

  it('a browser that cannot record webm is told so', () => {
    fakes.FakeCapture.supported.mockReturnValue(false);
    expect(mount('doctor').result.current.canRecord).toEqual({ ok: false, reason: 'browser' });
  });

  it('no live audio → nothing is started (a recording of silence would be worse than none)', async () => {
    setData({ consents: both });
    const { result } = mount('doctor', { audioTracks: () => [] });
    await act(() => result.current.start());
    expect(api.startRecording).not.toHaveBeenCalled();
    expect(result.current.error).toBe('no_audio');
  });

  it('starting asks the server first, then captures into the server-chosen prefix, and checks the file header', async () => {
    setData({ consents: both });
    const { result } = mount('doctor');
    await act(() => result.current.start());
    expect(api.startRecording).toHaveBeenCalledWith('a1');
    expect(fakes.FakeUploader.instances[0]!.prefix).toBe('recordings/a1/rec1/');
    expect(fakes.FakeUploader.instances[0]!.opts).toEqual(expect.objectContaining({ requireHeader: true }));
    expect(fakes.FakeCapture.instances[0]!.started).toBe(true);
    expect(result.current.phase).toBe('recording');
  });

  it('a server refusal (no consent) is reported and nothing is captured', async () => {
    setData({ consents: both });
    vi.mocked(api.startRecording).mockRejectedValue({ message: 'consent_required' });
    const { result } = mount('doctor');
    await act(() => result.current.start());
    expect(result.current.error).toBe('consent_required');
    expect(fakes.FakeCapture.instances).toHaveLength(0);
  });

  it('stopping: capture stops, the server is told, the upload drains, and the recording is finished with its size and type', async () => {
    setData({ consents: both });
    const { result } = mount('doctor');
    await act(() => result.current.start());
    await act(() => result.current.stop());
    expect(fakes.FakeCapture.instances[0]!.stopped).toBe(true);
    expect(api.stopRecording).toHaveBeenCalledWith('rec1');
    expect(api.finishRecording).toHaveBeenCalledWith('rec1', 4200, 'audio/webm');
    expect(api.failRecording).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    expect(result.current.phase).not.toBe('recording');
  });

  it('an upload that fails is recorded as failed and never reported as saved', async () => {
    setData({ consents: both });
    fakes.FakeUploader.result = { parts: 1, bytes: 10, failed: true };
    const { result } = mount('doctor');
    await act(() => result.current.start());
    await act(() => result.current.stop());
    expect(api.failRecording).toHaveBeenCalledWith('rec1', 'upload_failed');
    expect(api.finishRecording).not.toHaveBeenCalled();
    expect(result.current.error).toBe('upload_failed');
  });

  it('a first part without the webm header is reported as such', async () => {
    setData({ consents: both });
    fakes.FakeUploader.result = { parts: 0, bytes: 0, failed: true, reason: 'bad_header' };
    const { result } = mount('doctor');
    await act(() => result.current.start());
    await act(() => result.current.stop());
    expect(api.failRecording).toHaveBeenCalledWith('rec1', 'bad_header');
    expect(result.current.error).toBe('bad_header');
  });

  it('when the PATIENT withdraws consent the server stops the recording: the doctor\'s browser finishes the upload without stopping it again', async () => {
    setData({ consents: both });
    const { result, rerender } = mount('doctor');
    await act(() => result.current.start());
    setData({ consents: [both[0]!, { party: 'patient', withdrawn_at: 'now' }], recordings: [rec({ status: 'uploading', stop_reason: 'consent_withdrawn' })] });
    rerender({ call: { provider: 'livekit', phase: 'connected', audioTracks: () => [live] } as never });
    await waitFor(() => expect(api.finishRecording).toHaveBeenCalledWith('rec1', 4200, 'audio/webm'));
    expect(fakes.FakeCapture.instances[0]!.stopped).toBe(true);
    expect(api.stopRecording).not.toHaveBeenCalled();
  });

  it('leaving the call while recording ends and saves the recording', async () => {
    setData({ consents: both });
    const { result, rerender } = mount('doctor');
    await act(() => result.current.start());
    rerender({ call: { provider: 'livekit', phase: 'disconnected', audioTracks: () => [] } as never });
    await waitFor(() => expect(api.finishRecording).toHaveBeenCalled());
    expect(api.stopRecording).toHaveBeenCalledWith('rec1');
  });

  it('a recording left "in progress" by a closed tab is offered for ending, and ending it keeps what was uploaded', async () => {
    setData({ consents: both, recordings: [rec()] });
    const { result } = mount('doctor');
    expect(result.current.phase).toBe('interrupted');
    await act(() => result.current.endInterrupted());
    expect(api.stopRecording).toHaveBeenCalledWith('rec1');
    expect(api.finishRecording).toHaveBeenCalledWith('rec1', 1, 'audio/webm');
  });

  it('… and when nothing had been uploaded it is recorded as failed', async () => {
    setData({ consents: both, recordings: [rec()] });
    vi.mocked(api.finishRecording).mockRejectedValue({ message: 'file_missing' });
    const { result } = mount('doctor');
    await act(() => result.current.endInterrupted());
    expect(api.failRecording).toHaveBeenCalledWith('rec1', 'interrupted');
  });
});

describe('useRecording – patient', () => {
  it('is invited when the doctor has asked, and can allow or withdraw', async () => {
    setData({ consents: [{ party: 'doctor', withdrawn_at: null }] });
    const { result } = mount('patient');
    expect(result.current.phase).toBe('invited');
    await act(() => result.current.giveConsent());
    expect(api.setRecordingConsent).toHaveBeenCalledWith('a1', true);
    await act(() => result.current.withdrawConsent());
    expect(api.setRecordingConsent).toHaveBeenLastCalledWith('a1', false);
  });

  it('sees the recording in progress and never captures anything itself', () => {
    setData({ consents: both, recordings: [rec()] });
    const { result } = mount('patient');
    expect(result.current.phase).toBe('recording');
    expect(fakes.FakeCapture.instances).toHaveLength(0);
  });

  it('shows nothing at all while recording is switched off', () => {
    vi.mocked(api.useRecordingEnabled).mockReturnValue({ data: false } as never);
    setData({ consents: both });
    expect(mount('patient').result.current.phase).toBe('off');
  });
});
