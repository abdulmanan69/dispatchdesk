/** Largest "select all matching" set the server accepts (server: BULK_FILTER_CAP in services/carriers/query.js). */
export const SELECT_ALL_CAP = 5000;

/** List filters as the bulk API expects them: empty values dropped, sort kept. */
export function bulkFilter(filters = {}, sort) {
  const out = {};
  for (const [k, v] of Object.entries(filters)) if (v !== '' && v != null) out[k] = v;
  if (sort?.field) { out.sort = sort.field; out.dir = sort.dir === 'asc' ? 'asc' : 'desc'; }
  return out;
}

/**
 * What the "select all" banner should offer.
 *  none     nothing selected
 *  partial  some rows on this page
 *  offer    the whole page is selected and more rows match: offer "Select all N matching"
 *  tooMany  the whole page is selected but more than the cap match
 *  all      every matching carrier is selected (filter mode)
 */
export function selectAllState({ selectedCount, pageCount, total, allMatching, cap = SELECT_ALL_CAP }) {
  if (allMatching) return 'all';
  if (!selectedCount) return 'none';
  if (selectedCount < pageCount || total <= pageCount) return 'partial';
  return total > cap ? 'tooMany' : 'offer';
}

/** Bulk request target: every matching carrier (filter) or the checked ids. */
export function bulkTarget({ allMatching, ids, filter }) {
  return allMatching ? { filter } : { ids: [...ids] };
}

/** Insert text at the caret of a textarea/input (or at the end), returning the new value and caret position. */
export function insertAtCursor(el, value, text) {
  const v = String(value ?? '');
  const start = el && typeof el.selectionStart === 'number' ? el.selectionStart : v.length;
  const end = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : start;
  return { value: v.slice(0, start) + text + v.slice(end), caret: start + text.length };
}
