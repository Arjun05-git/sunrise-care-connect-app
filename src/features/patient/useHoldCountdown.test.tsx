import { act, renderHook } from '@testing-library/react';
import { useHoldCountdown } from './useHoldCountdown';
import * as api from './api';

describe('useHoldCountdown', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] }));
  afterEach(() => vi.useRealTimers());

  it('counts down from the server value and fires onExpire once at 0', async () => {
    vi.spyOn(api, 'getHold').mockResolvedValue({ status: 'pending_payment', hold_expires_at: '', seconds_left: 3 });
    const onExpire = vi.fn();
    const { result } = renderHook(() => useHoldCountdown('a1', onExpire));
    await act(async () => {}); // resolve getHold
    expect(result.current.phase).toBe('active');
    expect(result.current.secondsLeft).toBe(3);
    await act(async () => { vi.advanceTimersByTime(1500); });
    expect(result.current.secondsLeft).toBe(2);
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(result.current.phase).toBe('expired');
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('reports an already-lapsed or confirmed hold', async () => {
    const spy = vi.spyOn(api, 'getHold').mockResolvedValue({ status: 'cancelled', hold_expires_at: null, seconds_left: 0 });
    const onExpire = vi.fn();
    const a = renderHook(() => useHoldCountdown('a2', onExpire));
    await act(async () => {});
    expect(a.result.current.phase).toBe('expired');
    expect(onExpire).toHaveBeenCalledTimes(1);
    spy.mockResolvedValue({ status: 'confirmed', hold_expires_at: null, seconds_left: 0 });
    const b = renderHook(() => useHoldCountdown('a3', vi.fn()));
    await act(async () => {});
    expect(b.result.current.phase).toBe('confirmed');
  });
});
