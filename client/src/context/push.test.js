import { describe, it, expect } from 'vitest';
import { deviceLabel, urlBase64ToUint8Array, pushSupport } from './push.js';

describe('push helpers', () => {
  it('names devices from their user agent', () => {
    expect(deviceLabel('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36')).toBe('Chrome on Android');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148')).toBe('Home Screen app on iPhone');
    expect(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone');
    expect(deviceLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe('Edge on Windows');
    expect(deviceLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:131.0) Gecko/20100101 Firefox/131.0')).toBe('Firefox on Mac');
    expect(deviceLabel(null)).toBe('Browser');
  });

  it('decodes the VAPID public key for PushManager.subscribe', () => {
    const bytes = urlBase64ToUint8Array('BAEC_-8');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect([...bytes]).toEqual([4, 1, 2, 255, 239]);
  });

  it('reports when the browser has no push support', () => {
    // jsdom has no service worker or Push API.
    expect(pushSupport()).toMatchObject({ supported: false, permission: 'unsupported' });
  });
});
