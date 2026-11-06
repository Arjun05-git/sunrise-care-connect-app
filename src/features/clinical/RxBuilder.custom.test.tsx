import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import * as api from './api';
import type { CustomCheck, DrugHit, Rx } from './api';
import { RxBuilder } from './rx';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  useRx: vi.fn(), useNotes: vi.fn(), useSigningStatus: vi.fn(), useCustomMedicineMode: vi.fn(),
  searchDrugs: vi.fn(), checkDrugs: vi.fn(), saveRxDraft: vi.fn(), checkCustomMedicine: vi.fn(),
}));

const PARACETAMOL: DrugHit = {
  drug_id: 'drug-002', name: 'Paracetamol 650', generic_name: 'Paracetamol', form: 'Tablet', strength: '650 mg', category: 'O', schedule: 'OTC', blocked: false, reasons: [], warnings: [],
  default_dose: '1 tablet', default_frequency: 'TDS', default_route: 'Oral',
};
const OK: CustomCheck = { ok: true, code: null, match: null, warnings: [] };
const draftWith = (items: Partial<api.RxItem & { position: number }>[]): Rx => ({
  id: 'rx1', appointment_id: 'a1', version: 1, status: 'draft', parent_prescription_id: null, addendum_reason: null, rx_no: null, verification_code: null, finalized_at: null,
  updated_at: '', created_at: '', diagnoses: [], advice: '', investigations: '', follow_up_date: null,
  prescription_items: items.map((i, n) => ({ drug_id: null, drug_name: '', strength: '', form: '', dose: '', frequency: '', duration: '', route: '', instructions: '', position: n, ...i })),
});

function mount(versions: Rx[] = [], mode: 'checked' | 'direct' = 'checked') {
  vi.mocked(api.useCustomMedicineMode).mockReturnValue({ data: mode } as never);
  vi.mocked(api.useRx).mockReturnValue({ data: versions, isPending: false, isError: false } as never);
  vi.mocked(api.useNotes).mockReturnValue({ data: { diagnoses: [{ code: 'J06.9', description: 'URTI' }] } } as never);
  vi.mocked(api.useSigningStatus).mockReturnValue({ data: { pin_set: true, signature_updated_at: 'x' } } as never);
  vi.mocked(api.searchDrugs).mockResolvedValue([PARACETAMOL]);
  vi.mocked(api.checkDrugs).mockResolvedValue([]);
  vi.mocked(api.saveRxDraft).mockResolvedValue({ id: 'rx1', version: 1, updated_at: '' });
  vi.mocked(api.checkCustomMedicine).mockResolvedValue(OK);
  render(<QueryClientProvider client={new QueryClient()}><MemoryRouter><RxBuilder appointmentId="a1" /></MemoryRouter></QueryClientProvider>);
}
const searchBox = () => document.querySelector('[data-ref="drug-search"]') as HTMLInputElement;
const type = (label: RegExp, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

async function addParacetamol() {
  fireEvent.change(searchBox(), { target: { value: 'para' } });
  const hit = await waitFor(() => { const el = document.querySelector('[data-ref="drug-hit"]'); if (!el) throw new Error('no hit yet'); return el as HTMLElement; });
  fireEvent.click(within(hit).getByRole('button', { name: /^Add / }));
}
async function addCustomArnica() {
  fireEvent.click(screen.getByRole('button', { name: /Add one that is not in the list/ }));
  type(/^Medicine name/, 'Arnica Herbal Gel');
  type(/^Generic name/, 'Arnica montana');
  fireEvent.click(screen.getByRole('button', { name: 'Check medicine' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: /I have checked this medicine myself/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Add to prescription' }));
}

afterEach(() => vi.clearAllMocks());

describe('RxBuilder – the catalogue flow is unchanged', () => {
  it('search → add → autosave sends the same payload as before', async () => {
    mount();
    await addParacetamol();
    expect(await screen.findByText('Paracetamol 650')).toBeInTheDocument();
    await waitFor(() => expect(api.saveRxDraft).toHaveBeenCalled(), { timeout: 4000 });
    expect(vi.mocked(api.saveRxDraft).mock.calls.at(-1)![1]).toEqual(expect.arrayContaining([expect.objectContaining({ drug_id: 'drug-002' })]));
    expect(api.toSaveItems(vi.mocked(api.saveRxDraft).mock.calls.at(-1)![1])).toEqual([{ drug_id: 'drug-002', dose: '1 tablet', frequency: 'TDS', duration: '', route: 'Oral', instructions: '' }]);
  });
});

describe('RxBuilder – direct mode (the demo)', () => {
  it('a typed medicine is added straight from the dialog and saved, with no check and no tick', async () => {
    mount([], 'direct');
    fireEvent.click(screen.getByRole('button', { name: /Add one that is not in the list/ }));
    type(/^Medicine name/, 'Arnica Herbal Gel');
    fireEvent.click(screen.getByRole('button', { name: 'Add to prescription' }));
    const line = await waitFor(() => { const el = document.querySelector('[data-ref="rx-item"]'); if (!el) throw new Error('not added'); return el as HTMLElement; });
    expect(within(line).getByText('Arnica Herbal Gel')).toBeInTheDocument();
    expect(api.checkCustomMedicine).not.toHaveBeenCalled();
    await waitFor(() => expect(api.saveRxDraft).toHaveBeenCalled(), { timeout: 4000 });
    expect(api.toSaveItems(vi.mocked(api.saveRxDraft).mock.calls.at(-1)![1])).toEqual([expect.objectContaining({ custom: true, name: 'Arnica Herbal Gel', acknowledged: true })]);
  });
});

describe('RxBuilder – a medicine that is not in the list', () => {
  it('is added through "Add one that is not in the list", flagged, and kept out of the rule check', async () => {
    mount();
    await addCustomArnica();
    const line = await waitFor(() => { const el = document.querySelector('[data-ref="rx-item"]'); if (!el) throw new Error('not added'); return el as HTMLElement; });
    expect(within(line).getByText('Arnica Herbal Gel')).toBeInTheDocument();
    expect(within(line).getByText('Not in list · not rule-checked')).toBeInTheDocument();
    expect(within(line).getByText('Arnica montana')).toBeInTheDocument();
    expect(within(line).getByText('Checked by you')).toBeInTheDocument();
    // nothing for the rule engine to judge: every rule check carries an empty id list
    for (const [, ids] of vi.mocked(api.checkDrugs).mock.calls) expect(ids).toEqual([]);
  });

  it('autosave sends it in the custom shape, after the catalogue medicine, and only the catalogue id is rule-checked', async () => {
    mount();
    await addParacetamol();
    await addCustomArnica();
    await waitFor(() => expect(document.querySelectorAll('[data-ref="rx-item"]').length).toBe(2));
    await waitFor(() => expect(api.saveRxDraft).toHaveBeenCalled(), { timeout: 4000 });
    const sent = api.toSaveItems(vi.mocked(api.saveRxDraft).mock.calls.at(-1)![1]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual(expect.objectContaining({ drug_id: 'drug-002' }));
    expect(sent[1]).toEqual(expect.objectContaining({ custom: true, name: 'Arnica Herbal Gel', generic_name: 'Arnica montana', acknowledged: true }));
    await waitFor(() => expect(api.checkDrugs).toHaveBeenLastCalledWith('a1', ['drug-002']));
  });

  it('"Search for <catalogue entry>" puts that name in the search box', async () => {
    mount();
    vi.mocked(api.checkCustomMedicine).mockResolvedValue({ ok: false, code: 'use_catalogue_entry', match: { drug_id: 'drug-9', name: 'Amoxicillin', generic_name: 'Amoxicillin', category: 'A', schedule: 'H' }, warnings: [] });
    fireEvent.click(screen.getByRole('button', { name: /Add one that is not in the list/ }));
    type(/^Medicine name/, 'Amoxycillin');
    fireEvent.click(screen.getByRole('button', { name: 'Check medicine' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Search for Amoxicillin' }));
    await waitFor(() => expect(searchBox().value).toBe('Amoxicillin'));
    expect(document.querySelector('[data-ref="rx-item"]')).toBeNull();
  });

  it('an unacknowledged custom line (an older draft) blocks signing until the doctor confirms it', async () => {
    mount([draftWith([{ drug_name: 'Arnica Herbal Gel', is_custom: true, custom_acknowledged: false, generic_name: 'Arnica montana' }])]);
    const sign = document.querySelector('[data-ref="rx-sign"]') as HTMLButtonElement;
    expect(sign).toBeDisabled();
    expect(screen.getByText(/Confirm that you have checked each manually added medicine before signing/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /I have checked this medicine myself/ }));
    await waitFor(() => expect(sign).toBeEnabled());
    expect(screen.queryByText(/Confirm that you have checked each manually added medicine before signing/)).not.toBeInTheDocument();
  });

  it('a saved draft with a custom line opens normally (no catalogue id needed)', () => {
    mount([draftWith([{ drug_name: 'Arnica Herbal Gel', is_custom: true, custom_acknowledged: true, generic_name: 'Arnica montana' }, { drug_id: 'drug-002', drug_name: 'Paracetamol 650' }])]);
    expect(screen.getAllByText(/Arnica Herbal Gel|Paracetamol 650/)).toHaveLength(2);
    expect(document.querySelectorAll('[data-ref="rx-custom"]')).toHaveLength(1);
  });
});
