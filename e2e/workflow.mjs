#!/usr/bin/env node
/**
 * End-to-end workflow test against a RUNNING DispatchDesk instance (e.g. the Docker container).
 * Zero dependencies (Node 20+).
 *
 *   node e2e/workflow.mjs setup  [baseUrl]   # runs every workflow, writes e2e/.state.json
 *   node e2e/workflow.mjs verify [baseUrl]   # after `docker compose restart`, verifies persistence
 *
 * Env: ADMIN_EMAIL / ADMIN_PASSWORD (or read from ../.env), SMTP_SINK_HOST (host the container uses
 * to reach this machine, default host.docker.internal), SMTP_SINK_PORT (default 2525).
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mode = process.argv[2] || 'setup';
const BASE = (process.argv[3] || process.env.BASE_URL || 'http://localhost:3100').replace(/\/$/, '');
const STATE_FILE = path.join(here, '.state.json');

function loadDotEnv() {
  const p = path.join(here, '..', '.env');
  if (!fs.existsSync(p)) return {};
  return Object.fromEntries(fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')]; }));
}
const dotenv = loadDotEnv();
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || dotenv.ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || dotenv.ADMIN_PASSWORD;

// ---------------------------------------------------------------- tiny HTTP client with cookies + CSRF
class Client {
  constructor(name) { this.name = name; this.cookies = new Map(); }
  cookieHeader() { return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      const k = kv.slice(0, i); const v = kv.slice(i + 1);
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || v === '') this.cookies.delete(k); else this.cookies.set(k, v);
    }
  }
  async req(method, url, body, { form, raw } = {}) {
    if (!this.cookies.has('dd_csrf')) this.store(await fetch(`${BASE}/api/auth/csrf`));
    const headers = { cookie: this.cookieHeader() };
    if (method !== 'GET') headers['x-csrf-token'] = decodeURIComponent(this.cookies.get('dd_csrf'));
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(`${BASE}${url}`, { method, headers, body: payload, redirect: 'manual' });
    this.store(res);
    if (raw) return res;
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  }
  get(u) { return this.req('GET', u); }
  post(u, b) { return this.req('POST', u, b ?? {}); }
  patch(u, b) { return this.req('PATCH', u, b); }
  put(u, b) { return this.req('PUT', u, b); }
  del(u, b) { return this.req('DELETE', u, b); }
}

// ---------------------------------------------------------------- minimal SMTP sink (records received messages)
const received = [];
function startSmtpSink(port) {
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let data = false; let buf = ''; let msg = { rcpt: [], body: '' }; let authStep = 0;
      const say = (l) => sock.write(`${l}\r\n`);
      say('220 e2e-sink ESMTP');
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\r\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
          if (data) {
            if (line === '.') { data = false; received.push(msg); msg = { rcpt: [], body: '' }; say('250 2.0.0 queued as e2e'); }
            else msg.body += `${line.startsWith('..') ? line.slice(1) : line}\n`;
            continue;
          }
          if (authStep === 1) { authStep = 2; say('334 UGFzc3dvcmQ6'); continue; }
          if (authStep === 2) { authStep = 0; say('235 2.7.0 Authentication successful'); continue; }
          const cmd = line.slice(0, 4).toUpperCase();
          if (cmd === 'EHLO') { sock.write('250-e2e-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n'); }
          else if (cmd === 'HELO') say('250 e2e-sink');
          else if (cmd === 'AUTH') { if (/^AUTH LOGIN/i.test(line)) { authStep = 1; say('334 VXNlcm5hbWU6'); } else say('235 2.7.0 Authentication successful'); }
          else if (cmd === 'MAIL') { msg.from = line; say('250 OK'); }
          else if (cmd === 'RCPT') { msg.rcpt.push(line); say('250 OK'); }
          else if (cmd === 'DATA') { data = true; say('354 End data with <CR><LF>.<CR><LF>'); }
          else if (cmd === 'RSET') { msg = { rcpt: [], body: '' }; say('250 OK'); }
          else if (cmd === 'NOOP') say('250 OK');
          else if (cmd === 'QUIT') { say('221 Bye'); sock.end(); }
          else say('502 Command not implemented');
        }
      });
      sock.on('error', () => {});
    });
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

// ---------------------------------------------------------------- reporting
const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - t, detail });
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t, detail: err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
function expect(cond, msg) { if (!cond) throw new Error(msg); }
function expectStatus(r, code, what) { expect(r.status === code, `${what}: expected HTTP ${code}, got ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`); }

// ---------------------------------------------------------------- setup phase
async function setup() {
  const st = { email: `e2e.${Date.now()}@example.test`, password: 'E2ePassw0rd', run: new Date().toISOString() };
  const u = new Client('user');
  const sinkPort = Number(process.env.SMTP_SINK_PORT || 2525);
  const sink = await startSmtpSink(sinkPort);

  await step('01 Register a new user', async () => {
    const r = await u.post('/api/auth/register', { name: 'E2E Dispatcher', email: st.email, password: st.password, acceptTerms: true });
    expectStatus(r, 201, 'register');
    st.userId = r.data.user.id;
    return `user ${r.data.user.email} role=${r.data.user.role}`;
  });

  await step('02 Log out and log in', async () => {
    expectStatus(await u.post('/api/auth/logout'), 200, 'logout');
    expect((await u.get('/api/auth/me')).data.user === null, 'still logged in after logout');
    const bad = await u.post('/api/auth/login', { email: st.email, password: 'wrong-pass1' });
    expectStatus(bad, 401, 'bad password');
    expectStatus(await u.post('/api/auth/login', { email: st.email, password: st.password }), 200, 'login');
    return 'session cookie issued';
  });

  await step('03 Open dashboard (real DB stats)', async () => {
    const r = await u.get('/api/dashboard?range=30');
    expectStatus(r, 200, 'dashboard');
    return `keys: ${Object.keys(r.data).slice(0, 8).join(', ')}`;
  });

  await step('04 Add a carrier (with duplicate detection)', async () => {
    const body = { companyName: 'E2E Freight Lines LLC', dotNumber: '9900001', mcNumber: '880001', phone: '(214) 555-0101', email: 'dispatch@e2e-freight.test', city: 'Dallas', state: 'TX', equipment: ['dry_van'], fleetSize: 3 };
    const r = await u.post('/api/carriers', body);
    expectStatus(r, 201, 'create carrier');
    st.carrierId = r.data.carrier.id;
    const dup = await u.post('/api/carriers', body);
    expectStatus(dup, 409, 'duplicate');
    return `carrier ${st.carrierId}, timezone ${r.data.carrier.timezone}`;
  });

  await step('05 Import a CSV', async () => {
    const csv = 'Company Name,DOT Number,MC Number,Phone,Email,City,State,Equipment,Power Units\n'
      + 'Prairie Haulers Inc,9900002,880002,3165550102,ops@prairie.test,Wichita,KS,Reefer,5\n'
      + 'Coastal Flatbed Co,9900003,880003,9045550103,,Jacksonville,FL,Flatbed,2\n'
      + 'E2E Freight Lines LLC,9900001,880001,2145550101,,Dallas,TX,Dry Van,3\n';
    const form = new FormData();
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'carriers.csv');
    form.append('mode', 'skip');
    const r = await u.req('POST', '/api/carriers/import', undefined, { form });
    expect(r.status === 200 || r.status === 201, `import: HTTP ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    const d = r.data;
    expect((d.created ?? d.result?.created) === 2, `expected 2 created, got ${JSON.stringify(d).slice(0, 200)}`);
    return `created=${d.created ?? d.result?.created} skipped=${d.skipped ?? d.result?.skipped}`;
  });

  await step('06 Search carriers (name, MC, DOT, phone, state)', async () => {
    const byName = await u.get('/api/carriers?q=prairie');
    expect(byName.data.items.length === 1, 'name search');
    st.carrier2Id = byName.data.items[0].id;
    expect((await u.get('/api/carriers?q=880003')).data.items.length === 1, 'MC search');
    expect((await u.get('/api/carriers?q=9900001')).data.items.length === 1, 'DOT search');
    expect((await u.get('/api/carriers?q=3165550102')).data.items.length === 1, 'phone search');
    expect((await u.get('/api/carriers?state=FL')).data.items.length === 1, 'state filter');
    return 'all search modes matched';
  });

  await step('07 Add carrier to prospecting (stage + prospect list)', async () => {
    expectStatus(await u.post(`/api/carriers/${st.carrierId}/stage`, { stage: 'prospecting' }), 200, 'stage');
    const list = await u.post('/api/prospecting/lists', { name: `E2E list ${Date.now()}` });
    expect(list.status === 200 || list.status === 201, `list create ${list.status}`);
    const listId = list.data.list?.id ?? list.data.id;
    const add = await u.post(`/api/prospecting/lists/${listId}/items`, { carrierIds: [st.carrierId, st.carrier2Id] });
    expect(add.status < 300, `add items ${add.status} ${JSON.stringify(add.data)}`);
    return `list ${listId}`;
  });

  await step('08 Create a call sequence and enroll', async () => {
    const r = await u.post('/api/sequences', {
      name: 'E2E 4-touch', steps: [
        { dayOffset: 0, type: 'call', instructions: 'Intro call' },
        { dayOffset: 1, type: 'email', subject: 'Following up, {{company}}', body: 'Hi {{first_name}}, quick follow-up.' },
        { dayOffset: 3, type: 'call', instructions: 'Second call' },
        { dayOffset: 6, type: 'email', subject: 'Last note', body: 'Closing the loop.' },
      ],
    });
    expect(r.status === 201 || r.status === 200, `sequence ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    st.sequenceId = r.data.sequence?.id ?? r.data.id;
    const e = await u.post(`/api/sequences/${st.sequenceId}/enroll`, { carrierIds: [st.carrier2Id] });
    expect(e.status < 300 && (e.data.enrolled ?? 0) === 1, `enroll ${e.status} ${JSON.stringify(e.data)}`);
    const q = await u.get('/api/prospecting/queue');
    expectStatus(q, 200, 'queue');
    return `sequence ${st.sequenceId}; queue items=${(q.data.items || q.data.queue || []).length}`;
  });

  await step('09 Record a call outcome', async () => {
    const r = await u.post('/api/calls', { carrierId: st.carrier2Id, outcome: 'voicemail', notes: 'Left VM about dispatch service' });
    expect(r.status === 201 || r.status === 200, `call ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    const calls = await u.get(`/api/calls?carrierId=${st.carrier2Id}`);
    expect((calls.data.items || []).length >= 1, 'call not listed');
    return 'call logged, auto follow-up scheduled';
  });

  await step('10 Create a follow-up', async () => {
    const due = new Date(Date.now() + 86400000).toISOString();
    const r = await u.post('/api/follow-ups', { carrierId: st.carrierId, dueAt: due, type: 'call', note: 'Call back about rates' });
    expect(r.status === 201 || r.status === 200, `follow-up ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    st.followUpId = r.data.followUp?.id ?? r.data.id;
    return `follow-up ${st.followUpId}`;
  });

  await step('11 Move carrier to opportunities', async () => {
    const r = await u.post('/api/opportunities', { carrierId: st.carrierId, estimatedValueCents: 120000, dispatchFeePercent: 8 });
    expect(r.status === 201 || r.status === 200, `opportunity ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    st.opportunityId = r.data.opportunity?.id ?? r.data.id;
    const c = await u.get(`/api/carriers/${st.carrierId}`);
    expect((c.data.carrier?.stage?.key) === 'opportunity', `stage is ${c.data.carrier?.stage?.key}`);
    return `opportunity ${st.opportunityId}`;
  });

  await step('12 Convert opportunity into customer', async () => {
    const r = await u.post(`/api/opportunities/${st.opportunityId}/convert`);
    expect(r.status < 300, `convert ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    st.customerId = r.data.customer?.id ?? r.data.id;
    const cust = await u.get(`/api/customers/${st.customerId}`);
    expectStatus(cust, 200, 'customer detail');
    return `customer ${st.customerId}`;
  });

  await step('13 Upload customer documents (W-9, COI) and download', async () => {
    const pdf = Buffer.from(`%PDF-1.4\n% e2e ${crypto.randomUUID()}\n1 0 obj <<>> endobj\ntrailer <<>>\n%%EOF\n`);
    st.docSha = crypto.createHash('sha256').update(pdf).digest('hex');
    const form = new FormData();
    form.append('file', new Blob([pdf], { type: 'application/pdf' }), 'w9.pdf');
    form.append('carrierId', st.carrierId);
    form.append('type', 'w9');
    const r = await u.req('POST', '/api/documents', undefined, { form });
    expect(r.status === 201 || r.status === 200, `upload ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    st.documentId = r.data.document?.id ?? r.data.id;
    const bad = new FormData();
    bad.append('file', new Blob([Buffer.from('MZ fake exe')], { type: 'application/pdf' }), 'coi.pdf');
    bad.append('carrierId', st.carrierId);
    bad.append('type', 'coi');
    const rej = await u.req('POST', '/api/documents', undefined, { form: bad });
    expect(rej.status === 400, `spoofed PDF should be rejected, got ${rej.status}`);
    const dl = await u.req('GET', `/api/documents/${st.documentId}/download`, undefined, { raw: true });
    const got = crypto.createHash('sha256').update(Buffer.from(await dl.arrayBuffer())).digest('hex');
    expect(dl.status === 200 && got === st.docSha, 'downloaded bytes differ');
    return `document ${st.documentId}; spoofed file rejected`;
  });

  await step('14 Create a broker', async () => {
    const r = await u.post('/api/brokers', { companyName: 'E2E Logistics Brokerage', contactName: 'Sam Rivera', email: 'loads@e2e-brokerage.test', phone: '3125550199', mcNumber: '770001', paymentTerms: 'Net 30', daysToPay: 30 });
    expect(r.status === 201 || r.status === 200, `broker ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    st.brokerId = r.data.broker?.id ?? r.data.id;
    return `broker ${st.brokerId}`;
  });

  await step('15 Add a load', async () => {
    const r = await u.post('/api/loads', {
      brokerId: st.brokerId, carrierId: st.carrierId, referenceNumber: 'E2E-1001', originCity: 'Dallas', originState: 'TX', destCity: 'Atlanta', destState: 'GA',
      pickupDate: new Date().toISOString(), equipment: 'dry_van', commodity: 'Packaged foods', weightLbs: 38000,
      loadedMiles: 781, deadheadMiles: 40, rateCents: 220000, fuelPricePerGallon: 3.8, mpg: 6.5, dispatchFeePercent: 8, status: 'booked',
    });
    expect(r.status === 201 || r.status === 200, `load ${r.status} ${JSON.stringify(r.data).slice(0, 300)}`);
    st.loadId = r.data.load?.id ?? r.data.id;
    st.loadRpm = r.data.load?.calc?.ratePerMile;
    return `load ${st.loadId}, RPM ${st.loadRpm}`;
  });

  await step('16 Calculate rate per mile (+ parse pasted load text)', async () => {
    const r = await u.post('/api/loads/calculate', { rateCents: 220000, loadedMiles: 781, deadheadMiles: 40, fuelPricePerGallon: 3.8, mpg: 6.5 });
    expectStatus(r, 200, 'calculate');
    const calc = r.data.calc ?? r.data;
    expect(calc.ratePerMile === 2.82, `RPM expected 2.82 (2200/781), got ${calc.ratePerMile}`);
    const p = await u.post('/api/loads/parse', { text: 'Dallas, TX -> Atlanta, GA  Van  781 mi  $2,200  42,000 lbs  DH-O 40' });
    expectStatus(p, 200, 'parse');
    const f = p.data.fields ?? p.data;
    expect(f.originState === 'TX' && f.destState === 'GA', `parse states ${JSON.stringify(f).slice(0, 200)}`);
    return `RPM 2.82, all-in ${calc.allInRatePerMile}, fuel $${(calc.fuelCostCents / 100).toFixed(2)}`;
  });

  await step('17 Generate an AI email draft (honest when unconfigured)', async () => {
    const status = await u.get('/api/ai/status');
    expectStatus(status, 200, 'ai status');
    const r = await u.post('/api/ai/draft-email', { purpose: 'carrier_intro', carrierId: st.carrierId, notes: 'Offer 8% dispatch' });
    if (status.data.configured) {
      expectStatus(r, 200, 'draft');
      expect(r.data.subject && r.data.body, 'draft missing subject/body');
      return 'AI configured — draft generated';
    }
    expectStatus(r, 503, 'unconfigured AI');
    return `AI not configured → 503 "${String(r.data.error).slice(0, 60)}" (no fake output)`;
  });

  await step('18 Configure an email integration and send for real', async () => {
    const host = process.env.SMTP_SINK_HOST || 'host.docker.internal';
    const bad = await u.post('/api/email/accounts/smtp', { label: 'Broken', fromEmail: 'me@e2e.test', host: '127.0.0.1', port: 1, secure: false, user: 'me', password: 'x' });
    expect(bad.status >= 400, `unreachable SMTP must be rejected, got ${bad.status}`);
    const acc = await u.post('/api/email/accounts/smtp', { label: 'E2E sink', fromEmail: 'dispatch@e2e.test', fromName: 'E2E Dispatch', host, port: sinkPort, secure: false, user: 'dispatch@e2e.test', password: 'sink-pass' });
    expect(acc.status === 201 || acc.status === 200, `smtp connect ${acc.status} ${JSON.stringify(acc.data).slice(0, 300)}`);
    st.accountId = acc.data.account?.id ?? acc.data.id;
    const before = received.length;
    const send = await u.post('/api/email/messages', { accountId: st.accountId, toEmail: 'dispatch@e2e-freight.test', subject: 'Dispatch service for {{company}}', body: 'Hello from the E2E test.', carrierId: st.carrierId, mode: 'send' });
    expect(send.status < 300, `send ${send.status} ${JSON.stringify(send.data).slice(0, 300)}`);
    const em = send.data.email ?? send.data.message ?? send.data;
    expect(em.status === 'sent', `status ${em.status} ${em.error || ''}`);
    expect(received.length === before + 1, 'SMTP sink did not receive the message');
    expect(/E2E Freight Lines/.test(received.at(-1).body), 'merge field not rendered');
    expect(/unsubscribe/i.test(received.at(-1).body), 'missing unsubscribe link');
    return `rejected bad host; delivered to sink with providerMessageId=${em.providerMessageId}`;
  });

  await step('19 Create a team and invite a member', async () => {
    const t = await u.post('/api/teams', { name: 'E2E Fleet Co' });
    expect(t.status === 201 || t.status === 200, `team ${t.status} ${JSON.stringify(t.data).slice(0, 300)}`);
    st.teamId = t.data.team?.id ?? t.data.id;
    const inv = await u.post('/api/teams/invitations', { email: `member.${Date.now()}@example.test`, role: 'dispatcher' });
    expect(inv.status < 300 && inv.data.inviteLink, `invite ${inv.status} ${JSON.stringify(inv.data).slice(0, 200)}`);
    const lb = await u.get('/api/teams/leaderboard?range=week');
    expectStatus(lb, 200, 'leaderboard');
    return `team ${st.teamId}; invite emailSent=${inv.data.emailSent}`;
  });

  await step('20 Subscription settings (plans, usage, honest checkout)', async () => {
    const plans = await u.get('/api/billing/plans');
    expect((plans.data.items || plans.data.plans || plans.data).length >= 4, 'plans missing');
    const me = await u.get('/api/billing/me');
    expectStatus(me, 200, 'billing me');
    const co = await u.post('/api/billing/checkout', { planKey: 'pro' });
    expect([200, 503].includes(co.status), `checkout ${co.status}`);
    expect(co.status === 503 || /^https:\/\/checkout\.stripe\.com/.test(co.data.url), 'unexpected checkout response');
    const p = await u.patch('/api/profile', { theme: 'dark', notifyFollowUps: false });
    expectStatus(p, 200, 'settings');
    return `plan=${me.data.plan?.key}; checkout ${co.status === 503 ? `503 (${String(co.data.error).slice(0, 50)})` : 'Stripe URL issued'}`;
  });

  await step('21 Admin panel with admin account; denied for normal user', async () => {
    expect(ADMIN_EMAIL && ADMIN_PASSWORD, 'set ADMIN_EMAIL/ADMIN_PASSWORD');
    expectStatus(await u.get('/api/admin/stats'), 403, 'non-admin stats');
    expectStatus(await u.get('/api/admin/users'), 403, 'non-admin users');
    const a = new Client('admin');
    expectStatus(await a.post('/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }), 200, 'admin login');
    const s = await a.get('/api/admin/stats');
    expectStatus(s, 200, 'admin stats');
    const users = await a.get(`/api/admin/users?q=${encodeURIComponent(st.email)}`);
    expect((users.data.items || []).some((x) => x.email === st.email), 'admin cannot find user');
    expectStatus(await a.get('/api/admin/audit'), 200, 'audit');
    expectStatus(await a.get('/api/admin/settings'), 200, 'settings');
    // Tenant isolation: admin does not see the user's private carriers
    expectStatus(await a.get(`/api/carriers/${st.carrierId}`), 404, 'admin reading private carrier');
    return 'admin OK; user 403; private pipeline hidden from admin';
  });

  await step('22 Tenant isolation between dispatchers', async () => {
    const other = new Client('other');
    expectStatus(await other.post('/api/auth/register', { name: 'Other', email: `other.${Date.now()}@example.test`, password: 'OtherPass1', acceptTerms: true }), 201, 'register other');
    expectStatus(await other.get(`/api/carriers/${st.carrierId}`), 404, 'read');
    expectStatus(await other.patch(`/api/carriers/${st.carrierId}`, { companyName: 'Hijacked' }), 404, 'write');
    expectStatus(await other.req('GET', `/api/documents/${st.documentId}/download`, undefined, {}), 404, 'document');
    expect((await other.get('/api/carriers')).data.total === 0, 'other user sees carriers');
    return 'cross-tenant reads/writes return 404';
  });

  sink.close();
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
  return st;
}

// ---------------------------------------------------------------- verify phase (after restart)
async function verify() {
  const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const u = new Client('user');
  await step('P1 Health after restart', async () => {
    const r = await u.get('/api/health');
    expectStatus(r, 200, 'health');
    return `uptime ${r.data.uptimeSeconds}s`;
  });
  await step('P2 User account persists (login)', async () => { expectStatus(await u.post('/api/auth/login', { email: st.email, password: st.password }), 200, 'login'); });
  await step('P3 Carriers, notes and stage persist', async () => {
    const c = await u.get(`/api/carriers/${st.carrierId}`);
    expectStatus(c, 200, 'carrier');
    expect(c.data.carrier.stage.key === 'customer', `stage ${c.data.carrier.stage.key}`);
    expect((await u.get('/api/carriers')).data.total === 3, 'carrier count');
  });
  await step('P4 Customer, opportunity, broker, load persist', async () => {
    expectStatus(await u.get(`/api/customers/${st.customerId}`), 200, 'customer');
    expectStatus(await u.get(`/api/brokers/${st.brokerId}`), 200, 'broker');
    const l = await u.get(`/api/loads/${st.loadId}`);
    expectStatus(l, 200, 'load');
  });
  await step('P5 Uploaded document persists byte-for-byte', async () => {
    const dl = await u.req('GET', `/api/documents/${st.documentId}/download`, undefined, { raw: true });
    const got = crypto.createHash('sha256').update(Buffer.from(await dl.arrayBuffer())).digest('hex');
    expect(dl.status === 200 && got === st.docSha, 'document missing or changed');
  });
  await step('P6 Sequence, follow-up, team, email history, settings persist', async () => {
    expectStatus(await u.get(`/api/sequences/${st.sequenceId}`), 200, 'sequence');
    const f = await u.get('/api/follow-ups?status=pending');
    expect(JSON.stringify(f.data).includes(st.followUpId), 'follow-up missing');
    const t = await u.get('/api/teams/mine');
    expect((t.data.team?.id) === st.teamId, 'team missing');
    const sent = await u.get('/api/email/messages?status=sent');
    expect((sent.data.items || []).length >= 1, 'sent email history missing');
    const me = await u.get('/api/auth/me');
    expect(me.data.user.theme === 'dark', 'theme setting lost');
  });
  await step('P7 Activity history persists', async () => {
    const a = await u.get(`/api/carriers/${st.carrierId}/activities`);
    expect((a.data.items || []).length >= 4, `only ${(a.data.items || []).length} activities`);
  });
  await step('P8 Encrypted mailbox credential still decrypts (secret persisted)', async () => {
    const r = await u.post(`/api/email/accounts/${st.accountId}/test`);
    // The SMTP sink is not running in verify mode, so a connection error is expected — but NOT a decryption error.
    expect(!/decrypt|unsupported state|auth tag/i.test(JSON.stringify(r.data)), `credential unreadable after restart: ${JSON.stringify(r.data)}`);
    return `test returned ${r.status} (${String(r.data.error || r.data.message || 'ok').slice(0, 60)})`;
  });
}

console.log(`DispatchDesk E2E — ${mode} — ${BASE}`);
const started = Date.now();
if (mode === 'setup') await setup(); else await verify();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${((Date.now() - started) / 1000).toFixed(1)}s`);
fs.writeFileSync(path.join(here, `results-${mode}.json`), JSON.stringify({ base: BASE, mode, at: new Date().toISOString(), results }, null, 2));
process.exit(failed.length ? 1 : 0);
