import en from '@/i18n/locales/en.json';
import ml from '@/i18n/locales/ml.json';
import { catalogueIds, hasUnacknowledgedCustom, toSaveItems, type RxItem } from './api';

const catalogue = (over: Partial<RxItem> = {}): RxItem => ({ drug_id: 'drug-002', drug_name: 'Paracetamol 650', strength: '650 mg', form: 'Tablet', dose: '1 tablet', frequency: 'TDS', duration: '5 days', route: 'Oral', instructions: 'After food', ...over });
const custom = (over: Partial<RxItem> = {}): RxItem => ({
  drug_id: null, is_custom: true, custom_acknowledged: true, drug_name: 'Arnica Herbal Gel', generic_name: 'Arnica montana', strength: '10 %', form: 'Gel',
  dose: 'Apply thinly', frequency: 'BD', duration: '7 days', route: 'Topical', instructions: '', ...over,
});

describe('toSaveItems – what is sent to save_rx_draft', () => {
  it('catalogue items are sent exactly as before (id, dose, frequency, duration, route, instructions)', () => {
    expect(toSaveItems([catalogue()])).toEqual([{ drug_id: 'drug-002', dose: '1 tablet', frequency: 'TDS', duration: '5 days', route: 'Oral', instructions: 'After food' }]);
  });

  it('a catalogue item never carries a custom flag or a name (the server takes those from the catalogue)', () => {
    const sent = toSaveItems([catalogue()])[0] as Record<string, unknown>;
    for (const key of ['custom', 'name', 'generic_name', 'acknowledged', 'strength', 'form']) expect(sent, key).not.toHaveProperty(key);
  });

  it('a custom item is sent with its typed details and the doctor\'s acknowledgement', () => {
    expect(toSaveItems([custom()])).toEqual([{
      custom: true, name: 'Arnica Herbal Gel', generic_name: 'Arnica montana', strength: '10 %', form: 'Gel',
      dose: 'Apply thinly', frequency: 'BD', duration: '7 days', route: 'Topical', instructions: '', acknowledged: true,
    }]);
  });

  it('a mixed list keeps its order', () => {
    const sent = toSaveItems([catalogue(), custom(), catalogue({ drug_id: 'drug-004' })]);
    expect(sent.map((s) => ('custom' in s ? 'custom' : (s as { drug_id: string }).drug_id))).toEqual(['drug-002', 'custom', 'drug-004']);
  });

  it('an unacknowledged custom item says so (the server will refuse to sign it)', () => {
    expect((toSaveItems([custom({ custom_acknowledged: false })])[0] as { acknowledged: boolean }).acknowledged).toBe(false);
  });
});

describe('catalogueIds – only catalogue medicines go to the rule check', () => {
  it('skips custom items and items without an id', () => {
    expect(catalogueIds([catalogue(), custom(), catalogue({ drug_id: 'drug-004' })])).toEqual(['drug-002', 'drug-004']);
    expect(catalogueIds([custom()])).toEqual([]);
  });
});

describe('hasUnacknowledgedCustom', () => {
  it('is true only for a custom item the doctor has not acknowledged', () => {
    expect(hasUnacknowledgedCustom([catalogue(), custom()])).toBe(false);
    expect(hasUnacknowledgedCustom([catalogue(), custom({ custom_acknowledged: false })])).toBe(true);
    expect(hasUnacknowledgedCustom([catalogue()])).toBe(false);
  });
});

describe('strings – every new server error code and dialog text exists in English and Malayalam', () => {
  const lookup = (tree: unknown, path: string) => path.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], tree);
  const keys = [
    ...['use_catalogue_entry', 'custom_disabled', 'custom_invalid', 'custom_not_acknowledged', 'too_many_custom'].map((c) => `clinical.err.${c}`),
    ...['link', 'title', 'intro', 'name', 'generic', 'strength', 'form', 'check', 'checking', 'inCatalogue', 'searchFor', 'disabled', 'invalid', 'checkFailed',
      'notChecked', 'allergy', 'ack', 'add', 'badge', 'badgeHint', 'checkedByYou', 'needAck'].map((k) => `clinical.rx.custom.${k}`),
  ];
  it.each(keys)('%s', (key) => {
    expect(typeof lookup(en, key), `en ${key}`).toBe('string');
    expect(typeof lookup(ml, key), `ml ${key}`).toBe('string');
  });
});
