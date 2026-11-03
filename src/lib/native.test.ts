import { describe, expect, it } from 'vitest';
import { isNative, safeAppPath } from './native';

describe('native bridge on the web', () => {
  it('is not native in a browser', () => expect(isNative()).toBe(false));
  it('only opens same-app paths from a notification', () => {
    expect(safeAppPath('/l/abc123')).toBe('/l/abc123');
    expect(safeAppPath('/p/appointments?x=1')).toBe('/p/appointments?x=1');
    expect(safeAppPath(`${window.location.origin}/l/abc`)).toBe('/l/abc');
    expect(safeAppPath('https://evil.example/phish')).toBe('/');
    expect(safeAppPath('//evil.example/x')).toBe('/');
    expect(safeAppPath('javascript:alert(1)')).toBe('/');
    expect(safeAppPath(undefined)).toBe('/');
    // react-router open-redirect tricks (backslash, protocol-relative, encoded / whitespace variants)
    expect(safeAppPath('/\\evil.example')).toBe('/');
    expect(safeAppPath('\\\\evil.example')).toBe('/');
    expect(safeAppPath('/%2F/evil.example')).toBe('/%2F/evil.example');
    expect(safeAppPath('///evil.example')).toBe('/');
    expect(safeAppPath(' //evil.example')).toBe('/');
  });
});
