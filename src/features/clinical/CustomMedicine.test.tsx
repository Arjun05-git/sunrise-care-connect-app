import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as api from './api';
import type { CustomCheck } from './api';
import { CustomMedicineDialog } from './CustomMedicine';

vi.mock('./api', async (orig) => ({ ...(await orig<typeof import('./api')>()), checkCustomMedicine: vi.fn() }));

const OK: CustomCheck = { ok: true, code: null, match: null, warnings: [] };
const answer = (c: Partial<CustomCheck>) => vi.mocked(api.checkCustomMedicine).mockResolvedValue({ ...OK, ...c });

function setup(direct = false) {
  const onAdd = vi.fn();
  const onOpenChange = vi.fn();
  const onUseCatalogue = vi.fn();
  render(<CustomMedicineDialog appointmentId="a1" open direct={direct} onOpenChange={onOpenChange} onAdd={onAdd} onUseCatalogue={onUseCatalogue} />);
  return { onAdd, onOpenChange, onUseCatalogue };
}
const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const check = async () => { fireEvent.click(screen.getByRole('button', { name: 'Check medicine' })); await waitFor(() => expect(api.checkCustomMedicine).toHaveBeenCalled()); };

afterEach(() => vi.clearAllMocks());

describe('CustomMedicineDialog – direct mode (the demo): the typed medicine is added as typed', () => {
  it('has no check step and no acknowledgement; Add needs only a name', () => {
    setup(true);
    expect(screen.queryByRole('button', { name: 'Check medicine' })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add to prescription' });
    expect(add).toBeDisabled();
    type(/^Medicine name/, 'A');
    expect(add).toBeDisabled();
    type(/^Medicine name/, 'Ar');
    expect(add).toBeEnabled();
  });

  it('adds immediately with what was typed, asks the server nothing, and closes', () => {
    const { onAdd, onOpenChange } = setup(true);
    type(/^Medicine name/, 'Arnica Herbal Gel');
    type(/^Generic name/, 'Arnica montana');
    type(/^Strength/, '10 %');
    type(/^Form/, 'Gel');
    fireEvent.click(screen.getByRole('button', { name: 'Add to prescription' }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({
      drug_id: null, is_custom: true, custom_acknowledged: true, drug_name: 'Arnica Herbal Gel', generic_name: 'Arnica montana', strength: '10 %', form: 'Gel',
      dose: '', frequency: '', duration: '', route: '', instructions: '',
    }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(api.checkCustomMedicine).not.toHaveBeenCalled();
  });

  it('even a name that is in the catalogue is added as typed', () => {
    const { onAdd } = setup(true);
    type(/^Medicine name/, 'Amoxicillin');
    fireEvent.click(screen.getByRole('button', { name: 'Add to prescription' }));
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ drug_name: 'Amoxicillin', is_custom: true }));
    expect(api.checkCustomMedicine).not.toHaveBeenCalled();
  });
});

describe('CustomMedicineDialog', () => {
  it('cannot check an empty name', () => {
    setup();
    expect(screen.getByRole('button', { name: 'Check medicine' })).toBeDisabled();
    type(/^Medicine name/, 'A');
    expect(screen.getByRole('button', { name: 'Check medicine' })).toBeDisabled();
    type(/^Medicine name/, 'Ar');
    expect(screen.getByRole('button', { name: 'Check medicine' })).toBeEnabled();
  });

  it('asks the server, with the typed name and generic, before anything can be added', async () => {
    answer({});
    const { onAdd } = setup();
    type(/^Medicine name/, 'Arnica Herbal Gel');
    type(/^Generic name/, 'Arnica montana');
    await check();
    expect(api.checkCustomMedicine).toHaveBeenCalledWith('a1', 'Arnica Herbal Gel', 'Arnica montana');
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('a name that is already in the catalogue is refused, naming the catalogue entry, and offers to search for it', async () => {
    answer({ ok: false, code: 'use_catalogue_entry', match: { drug_id: 'drug-9', name: 'Amoxicillin', generic_name: 'Amoxicillin', category: 'A', schedule: 'H' } });
    const { onAdd, onUseCatalogue, onOpenChange } = setup();
    type(/^Medicine name/, 'Amoxycillin caps');
    await check();
    expect(await screen.findByText(/“Amoxicillin” is already in the medicine list/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to prescription' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Search for Amoxicillin' }));
    expect(onUseCatalogue).toHaveBeenCalledWith('Amoxicillin');
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('explains when the hospital has switched custom medicines off, or the name is invalid', async () => {
    answer({ ok: false, code: 'custom_disabled' });
    setup();
    type(/^Medicine name/, 'Arnica Herbal Gel');
    await check();
    expect(await screen.findByText(/switched off at your hospital/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add to prescription' })).not.toBeInTheDocument();
  });

  it('shows the not-rule-checked notice and needs the doctor\'s acknowledgement before adding', async () => {
    answer({});
    const { onAdd } = setup();
    type(/^Medicine name/, 'Arnica Herbal Gel');
    type(/^Strength/, '10 %');
    type(/^Form/, 'Gel');
    await check();
    expect(await screen.findByText(/cannot check it against the prescribing rules/i)).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add to prescription' });
    expect(add).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: /I have checked this medicine myself/ }));
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({
      drug_id: null, is_custom: true, custom_acknowledged: true, drug_name: 'Arnica Herbal Gel', strength: '10 %', form: 'Gel',
      generic_name: '', dose: '', frequency: '', duration: '', route: '', instructions: '',
    }));
  });

  it('shows a possible-allergy warning without blocking', async () => {
    answer({ warnings: [{ code: 'allergy', allergy: 'penicillin' }] });
    setup();
    type(/^Medicine name/, 'Penicillin G benzathine injection');
    await check();
    expect(await screen.findByText(/recorded allergy to “penicillin”/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /I have checked this medicine myself/ }));
    expect(screen.getByRole('button', { name: 'Add to prescription' })).toBeEnabled();
  });

  it('editing the name after a check requires checking again', async () => {
    answer({});
    setup();
    type(/^Medicine name/, 'Arnica Herbal Gel');
    await check();
    await screen.findByRole('checkbox', { name: /I have checked this medicine myself/ });
    type(/^Medicine name/, 'Arnica Herbal Gel X');
    expect(screen.queryByRole('checkbox', { name: /I have checked this medicine myself/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check medicine' })).toBeEnabled();
  });

  it('a failed check adds nothing and says so', async () => {
    vi.mocked(api.checkCustomMedicine).mockRejectedValue(new Error('network'));
    const { onAdd } = setup();
    type(/^Medicine name/, 'Arnica Herbal Gel');
    fireEvent.click(screen.getByRole('button', { name: 'Check medicine' }));
    expect(await screen.findByText(/couldn.t check the medicine/i)).toBeInTheDocument();
    expect(onAdd).not.toHaveBeenCalled();
  });

  it('Cancel closes without adding', () => {
    const { onAdd, onOpenChange } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onAdd).not.toHaveBeenCalled();
  });
});
