import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from './helpers.js';

/** The Content-Security-Policy header as { directive: [sources] }. */
async function policy(url = '/api/health') {
  const header = (await request(app).get(url)).headers['content-security-policy'];
  expect(header).toBeTruthy();
  return Object.fromEntries(header.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([name, ...sources]) => [name, sources]));
}

describe('content security policy', () => {
  it('runs scripts only from this origin: no inline scripts, no eval, no third-party script hosts', async () => {
    const csp = await policy();
    // WebAssembly compilation is the only addition (in-browser OCR of scanned rate cons, served from /ocr/).
    expect(csp['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(csp['script-src-attr']).toEqual(["'none'"]);
    expect(csp['default-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'none'"]);
    for (const [name, sources] of Object.entries(csp)) {
      expect(sources, name).not.toContain("'unsafe-eval'");
      expect(sources, name).not.toContain('*');
      expect(sources.join(' '), name).not.toMatch(/jsdelivr|unpkg|cdnjs|googleapis/);
    }
    expect(csp['style-src']).not.toContain('https:');
  });

  it('lets workers start only from this origin (or blob: URLs it creates), never from another host', async () => {
    const csp = await policy();
    expect(csp['worker-src']).toContain("'self'");
    for (const source of csp['worker-src']) expect(["'self'", 'blob:']).toContain(source);
    expect(csp['connect-src']).toContain("'self'");
  });

  it('sends the policy with every response, including the OCR worker script path', async () => {
    const page = await policy('/ocr/worker.min.js');
    expect(page['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  });
});
