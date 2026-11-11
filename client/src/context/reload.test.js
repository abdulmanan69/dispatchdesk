import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isChunkError, reloadForNewVersion, recentlyReloaded, importWithReload } from './reload.js';

let reload;
beforeEach(() => {
  sessionStorage.clear();
  reload = vi.fn();
  vi.stubGlobal('location', { ...window.location, reload });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('chunk reload after a deploy', () => {
  it('recognizes chunk-load failures from each browser', () => {
    expect(isChunkError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/Fleet-abc.js'))).toBe(true);
    expect(isChunkError(new TypeError('error loading dynamically imported module'))).toBe(true);
    expect(isChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkError(new Error('Unable to preload CSS for /assets/x.css'))).toBe(true);
    expect(isChunkError(Object.assign(new Error('x'), { name: 'ChunkLoadError' }))).toBe(true);
    expect(isChunkError(new Error('Cannot read properties of undefined'))).toBe(false);
    expect(isChunkError(null)).toBe(false);
  });

  it('reloads once, then refuses for 30 seconds (no reload loops)', () => {
    expect(recentlyReloaded()).toBe(false);
    expect(reloadForNewVersion()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(recentlyReloaded()).toBe(true);
    expect(reloadForNewVersion()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('wrapped imports reload on chunk errors and rethrow everything else', async () => {
    const ok = await importWithReload(async () => ({ default: 'Page' }))();
    expect(ok.default).toBe('Page');

    const other = await importWithReload(async () => { throw new Error('Syntax error in page'); })().catch((e) => e);
    expect(other.message).toBe('Syntax error in page');
    expect(reload).not.toHaveBeenCalled();

    const pending = importWithReload(async () => { throw new TypeError('Failed to fetch dynamically imported module'); })();
    await new Promise((r) => setTimeout(r, 10));
    expect(reload).toHaveBeenCalledTimes(1);
    const state = await Promise.race([pending.then(() => 'settled', () => 'settled'), new Promise((r) => setTimeout(() => r('pending'), 20))]);
    expect(state).toBe('pending'); // the page is reloading; nothing renders an error

    // A second failure right after the reload surfaces to the error screen instead of looping.
    const again = await importWithReload(async () => { throw new TypeError('Failed to fetch dynamically imported module'); })().catch((e) => e);
    expect(isChunkError(again)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
