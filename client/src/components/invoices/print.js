/**
 * Open a printable page (server-rendered, same origin, no scripts) in a new tab and start the browser's print dialog
 * when it has loaded, so the user can print or "Save as PDF". Returns false when the browser blocked the tab.
 */
export function openPrintable(url) {
  const w = window.open(url, '_blank');
  if (!w) return false;
  const start = () => {
    try { w.focus(); w.print(); } catch { /* the user can still print from the tab */ }
  };
  try {
    if (w.document?.readyState === 'complete' && w.location.href !== 'about:blank') start();
    else w.addEventListener('load', start, { once: true });
  } catch {
    // Cross-origin or closed: leave the tab open for manual printing.
  }
  return true;
}

/** Copy text to the clipboard; resolves true on success. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
