import { describe, it, expect } from 'vitest';
import { bulkFilter, bulkTarget, insertAtCursor, selectAllState, SELECT_ALL_CAP } from './bulkSelection.js';

describe('bulk selection helpers', () => {
  it('drops empty filters and keeps the sort', () => {
    expect(bulkFilter({ q: '', state: 'TX', noActivity: '', fleetMin: '2' }, { field: 'companyName', dir: 'asc' }))
      .toEqual({ state: 'TX', fleetMin: '2', sort: 'companyName', dir: 'asc' });
    expect(bulkFilter({}, null)).toEqual({});
  });

  it('offers select-all only when the whole page is selected and more rows match', () => {
    expect(selectAllState({ selectedCount: 0, pageCount: 25, total: 90 })).toBe('none');
    expect(selectAllState({ selectedCount: 3, pageCount: 25, total: 90 })).toBe('partial');
    expect(selectAllState({ selectedCount: 25, pageCount: 25, total: 25 })).toBe('partial');
    expect(selectAllState({ selectedCount: 25, pageCount: 25, total: 90 })).toBe('offer');
    expect(selectAllState({ selectedCount: 25, pageCount: 25, total: SELECT_ALL_CAP + 1 })).toBe('tooMany');
    expect(selectAllState({ selectedCount: 25, pageCount: 25, total: 90, allMatching: true })).toBe('all');
  });

  it('targets the filter in select-all mode and the ids otherwise', () => {
    expect(bulkTarget({ allMatching: true, ids: new Set(['a']), filter: { state: 'TX' } })).toEqual({ filter: { state: 'TX' } });
    expect(bulkTarget({ allMatching: false, ids: new Set(['a', 'b']), filter: {} })).toEqual({ ids: ['a', 'b'] });
  });

  it('inserts at the caret or at the end', () => {
    expect(insertAtCursor({ selectionStart: 3, selectionEnd: 3 }, 'Hi ,', '{{first_name}}')).toEqual({ value: 'Hi {{first_name}},', caret: 17 });
    expect(insertAtCursor(null, 'Hello', ' {{company}}')).toEqual({ value: 'Hello {{company}}', caret: 17 });
    expect(insertAtCursor({ selectionStart: 0, selectionEnd: 5 }, 'Hello world', 'Bye')).toEqual({ value: 'Bye world', caret: 3 });
  });
});
