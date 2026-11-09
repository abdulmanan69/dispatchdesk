const KEY = 'dd_theme';

export function storedTheme() {
  try { return localStorage.getItem(KEY) || 'system'; } catch { return 'system'; }
}

export function applyTheme(theme = storedTheme()) {
  try { localStorage.setItem(KEY, theme); } catch { /* storage unavailable */ }
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', !!dark);
  document.documentElement.dataset.theme = theme;
}

export function watchSystemTheme() {
  const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
  mq?.addEventListener?.('change', () => { if (storedTheme() === 'system') applyTheme('system'); });
}
