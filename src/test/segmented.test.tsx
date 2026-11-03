import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Segmented } from '@/components/ui/segmented';

function Theme() {
  const [v, setV] = useState<'light' | 'dark' | 'system'>('light');
  return <Segmented aria-label="Theme" value={v} onValueChange={setV} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'system', label: 'System' }]} />;
}

describe('Segmented (radio group)', () => {
  it('is a labelled radio group with one Tab stop', () => {
    render(<Theme />);
    expect(screen.getByRole('radiogroup', { name: 'Theme' })).toBeInTheDocument();
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1]);
  });
  it('arrow keys move focus and select, wrapping around', () => {
    render(<Theme />);
    const [light, dark, system] = screen.getAllByRole('radio') as HTMLButtonElement[];
    fireEvent.keyDown(light!, { key: 'ArrowRight' });
    expect(dark).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(dark);
    fireEvent.keyDown(dark!, { key: 'ArrowRight' });
    fireEvent.keyDown(system!, { key: 'ArrowRight' });
    expect(light).toHaveAttribute('aria-checked', 'true');
    fireEvent.keyDown(light!, { key: 'ArrowLeft' });
    expect(system).toHaveAttribute('aria-checked', 'true');
    expect(system!.tabIndex).toBe(0);
  });
});
