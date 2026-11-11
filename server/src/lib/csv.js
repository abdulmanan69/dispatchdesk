/**
 * Spreadsheet-formula guard for CSV exports: cells starting with = + - @ (or tab/CR) are prefixed with a quote, so a
 * value such as =HYPERLINK(...) from an import, FMCSA or a lead source is shown as text when the file is opened in
 * Excel or Sheets. A plain number such as "-50.00" (a credit line) is not a formula and stays numeric.
 */
export const safeCell = (v) => {
  const s = v == null ? '' : String(v);
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return s;
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
};
