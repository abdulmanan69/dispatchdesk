import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { hostRedirect } from '../src/middleware/hostRedirect.js';

function app(opts) {
  const a = express();
  a.use(hostRedirect(opts));
  a.all(/.*/, (req, res) => res.json({ served: true }));
  return a;
}

const OPTS = { hosts: 'dispatchdesk.work.gd, WWW.dispatchdesk.work.gd', target: 'https://dispatchdesk.eu.org' };

describe('old domain redirect', () => {
  it('sends an old-domain link to the same path on the new domain, keeping the method', async () => {
    const r = await request(app(OPTS)).get('/portal/abc?x=1').set('Host', 'dispatchdesk.work.gd');
    expect(r.status).toBe(308);
    expect(r.headers.location).toBe('https://dispatchdesk.eu.org/portal/abc?x=1');
    const p = await request(app(OPTS)).post('/api/extension/lookup').set('Host', 'www.dispatchdesk.work.gd').send({ a: 1 });
    expect(p.status).toBe(308);
    expect(p.headers.location).toBe('https://dispatchdesk.eu.org/api/extension/lookup');
  });

  it('serves the new domain, other hosts and health checks normally', async () => {
    expect((await request(app(OPTS)).get('/').set('Host', 'dispatchdesk.eu.org')).body).toEqual({ served: true });
    expect((await request(app(OPTS)).get('/api/health').set('Host', 'localhost')).body).toEqual({ served: true });
  });

  it('is off without REDIRECT_HOSTS and never redirects the app to itself', async () => {
    expect((await request(app({ hosts: '', target: OPTS.target })).get('/').set('Host', 'dispatchdesk.work.gd')).status).toBe(200);
    expect((await request(app({ hosts: 'dispatchdesk.eu.org', target: OPTS.target })).get('/').set('Host', 'dispatchdesk.eu.org')).status).toBe(200);
  });
});
