import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { registerUser, prisma } from './helpers.js';

const CENSUS_ROW = {
  dot_number: '1234567', legal_name: 'ACME HAULING LLC', dba_name: 'ACME', phone: '6145550101', email_address: 'OPS@ACME.TEST',
  phy_street: '1 MAIN ST', phy_city: 'COLUMBUS', phy_state: 'OH', phy_zip: '43004', power_units: '4', total_drivers: '5',
  status_code: 'A', add_date: '20230115', classdef: 'AUTHORIZED FOR HIRE', carrier_operation: 'A', docket1prefix: 'MC', docket1: '998877',
  crgo_genfreight: 'X', crgo_coldfood: 'X',
};

function mockCensus(rows = [CENSUS_ROW]) {
  const fn = vi.fn(async () => ({ ok: true, status: 200, json: async () => rows }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('carriers CRUD and isolation', () => {
  let A; let B; let carrierId;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('creates a carrier with normalised fields and time zone', async () => {
    const res = await A.agent.post('/api/carriers').send({
      companyName: 'Blue Line Freight', dotNumber: 'USDOT 0012345', mcNumber: 'MC-445566', phone: '+1 (312) 555-0199',
      email: 'Dispatch@BlueLine.test', state: 'il', city: 'Chicago', equipment: ['dry_van', 'reefer'], fleetSize: 3, contactName: 'Pat Driver', note: 'Met at truck stop',
    });
    expect(res.status).toBe(201);
    const c = res.body.carrier;
    carrierId = c.id;
    expect(c).toMatchObject({ dotNumber: '12345', mcNumber: '445566', phone: '3125550199', email: 'dispatch@blueline.test', state: 'IL', timezone: 'America/Chicago', equipment: 'dry_van,reefer', source: 'manual' });
  });

  it('detects duplicates by DOT, MC or phone', async () => {
    const dot = await A.agent.post('/api/carriers').send({ companyName: 'Copy', dotNumber: '12345' });
    expect(dot.status).toBe(409);
    expect(dot.body.details.existingId).toBe(carrierId);
    const phone = await A.agent.post('/api/carriers').send({ companyName: 'Phone copy', phone: '312-555-0199' });
    expect(phone.status).toBe(409);
    expect(phone.body.details.canOverride).toBe(true);
    const forced = await A.agent.post('/api/carriers').send({ companyName: 'Phone copy', phone: '312-555-0199', allowDuplicate: true });
    expect(forced.status).toBe(201);
    // Same DOT is fine for a different owner (tenant-scoped uniqueness).
    const other = await B.agent.post('/api/carriers').send({ companyName: 'B carrier', dotNumber: '12345' });
    expect(other.status).toBe(201);
  });

  it('searches by name, MC, DOT and phone digits and filters', async () => {
    for (const q of ['Blue Line', '445566', '12345', '5550199']) {
      const res = await A.agent.get(`/api/carriers?q=${encodeURIComponent(q)}`);
      expect(res.body.items.some((c) => c.id === carrierId), q).toBe(true);
    }
    const st = await A.agent.get('/api/carriers?state=TX');
    expect(st.body.items.some((c) => c.id === carrierId)).toBe(false);
    const eq = await A.agent.get('/api/carriers?equipment=reefer&fleetMin=2&fleetMax=5');
    expect(eq.body.items.map((c) => c.id)).toContain(carrierId);
    const stage = await A.agent.get('/api/carriers?stage=lead');
    expect(stage.body.total).toBeGreaterThanOrEqual(1);
  });

  it('returns a full profile with call window and contacts', async () => {
    const res = await A.agent.get(`/api/carriers/${carrierId}`);
    expect(res.status).toBe(200);
    expect(res.body.carrier.contacts[0].name).toBe('Pat Driver');
    expect(res.body.carrier.notes[0].body).toBe('Met at truck stop');
    expect(res.body.callWindow.timezone).toBe('America/Chicago');
    expect(res.body.canWrite).toBe(true);
  });

  it('patch only touches sent fields', async () => {
    const res = await A.agent.patch(`/api/carriers/${carrierId}`).send({ fleetSize: 7, doNotEmail: true });
    expect(res.status).toBe(200);
    expect(res.body.carrier).toMatchObject({ fleetSize: 7, doNotEmail: true, email: 'dispatch@blueline.test', mcNumber: '445566' });
  });

  it('enforces tenant isolation (404 for other users)', async () => {
    expect((await B.agent.get(`/api/carriers/${carrierId}`)).status).toBe(404);
    expect((await B.agent.patch(`/api/carriers/${carrierId}`).send({ companyName: 'Hacked' })).status).toBe(404);
    expect((await B.agent.delete(`/api/carriers/${carrierId}`)).status).toBe(404);
    expect((await B.agent.post(`/api/carriers/${carrierId}/notes`).send({ body: 'x' })).status).toBe(404);
    expect((await B.agent.post('/api/calls').send({ carrierId, outcome: 'busy' })).status).toBe(404);
    const list = await B.agent.get('/api/carriers?q=Blue%20Line');
    expect(list.body.items.length).toBe(0);
    const bulk = await B.agent.post('/api/carriers/bulk').send({ action: 'delete', ids: [carrierId] });
    expect(bulk.body.affected).toBe(0);
    expect(await prisma.carrier.findUnique({ where: { id: carrierId } })).not.toBeNull();
  });

  it('refuses to assign to a user outside the team', async () => {
    const res = await A.agent.patch(`/api/carriers/${carrierId}`).send({ assignedToId: B.user.id });
    expect(res.status).toBe(400);
  });

  it('manages notes, contacts and tags', async () => {
    const n = await A.agent.post(`/api/carriers/${carrierId}/notes`).send({ body: 'Prefers texts', pinned: true });
    expect(n.status).toBe(201);
    expect((await A.agent.patch(`/api/carriers/${carrierId}/notes/${n.body.note.id}`).send({ body: 'Prefers calls' })).body.note.body).toBe('Prefers calls');
    expect((await A.agent.delete(`/api/carriers/${carrierId}/notes/${n.body.note.id}`)).status).toBe(200);
    const ct = await A.agent.post(`/api/carriers/${carrierId}/contacts`).send({ name: 'Sam Owner', phone: '3125550000', isPrimary: true });
    expect(ct.body.contact.isPrimary).toBe(true);
    expect((await A.agent.delete(`/api/carriers/${carrierId}/contacts/${ct.body.contact.id}`)).status).toBe(200);
    const t = await A.agent.post(`/api/carriers/${carrierId}/tags`).send({ name: 'Hot lead' });
    expect(t.body.tag.name).toBe('Hot lead');
    const tags = await A.agent.get('/api/tags');
    expect(tags.body.items.find((x) => x.name === 'Hot lead').carrierCount).toBe(1);
    const filtered = await A.agent.get(`/api/carriers?tagId=${t.body.tag.id}`);
    expect(filtered.body.items.map((c) => c.id)).toEqual([carrierId]);
    expect((await A.agent.delete(`/api/carriers/${carrierId}/tags/${t.body.tag.id}`)).status).toBe(200);
  });

  it('moves stages with side effects (opportunity, customer)', async () => {
    const opp = await A.agent.post(`/api/carriers/${carrierId}/stage`).send({ stage: 'opportunity' });
    expect(opp.body.stage.key).toBe('opportunity');
    expect(await prisma.opportunity.findUnique({ where: { carrierId } })).toMatchObject({ status: 'open' });
    await A.agent.post(`/api/carriers/${carrierId}/stage`).send({ stage: 'customer' });
    expect(await prisma.customer.findUnique({ where: { carrierId } })).not.toBeNull();
    expect((await prisma.opportunity.findUnique({ where: { carrierId } })).status).toBe('won');
    const acts = await A.agent.get(`/api/carriers/${carrierId}/activities`);
    expect(acts.body.items.some((a) => a.type === 'stage_change')).toBe(true);
    const board = await A.agent.get('/api/pipeline/board');
    expect(board.body.columns.find((c) => c.key === 'customer').items.map((c) => c.id)).toContain(carrierId);
    const stages = await A.agent.get('/api/pipeline/stages');
    expect(stages.body.items.find((s) => s.key === 'customer').count).toBe(1);
  });

  it('imports CSV with header aliases, skips duplicates, reports row errors', async () => {
    const csv = [
      'Legal Name,USDOT Number,MC #,Phone Number,Email Address,State,Trailer Type,Power Units,Contact',
      'Red River Trucking,7654321,MC123123,(214) 555-0101,rr@example.test,TX,Flatbed,2,Jo',
      'Duplicate Of Blue,12345,,,,IL,,,',
      ',,,,,,,,',
      'Green Acres Transport,,,(405) 555-0123,,OK,"Dry Van, Reefer",1,',
    ].join('\n');
    const res = await A.agent.post('/api/carriers/import').attach('file', Buffer.from(csv), { filename: 'leads.csv', contentType: 'text/csv' }).field('mode', 'skip');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ created: 2, skipped: 1 });
    expect(res.body.errors.length).toBe(1);
    const red = await prisma.carrier.findFirst({ where: { ownerId: A.user.id, dotNumber: '7654321' }, include: { contacts: true } });
    expect(red).toMatchObject({ mcNumber: '123123', equipment: 'flatbed', fleetSize: 2, source: 'csv', timezone: 'America/Chicago' });
    expect(red.contacts[0].name).toBe('Jo');
    const green = await prisma.carrier.findFirst({ where: { ownerId: A.user.id, companyName: 'Green Acres Transport' } });
    expect(green.equipment).toBe('dry_van,reefer');
  });

  it('rejects non-CSV uploads', async () => {
    const res = await A.agent.post('/api/carriers/import').attach('file', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
  });

  it('exports CSV respecting filters', async () => {
    const res = await A.agent.get('/api/carriers/export.csv?state=TX');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Red River Trucking');
    expect(res.text).not.toContain('Blue Line Freight');
  });

  it('bulk actions: tag, stage, do-not-call, delete', async () => {
    const ids = (await A.agent.get('/api/carriers?state=TX')).body.items.map((c) => c.id);
    expect((await A.agent.post('/api/carriers/bulk').send({ action: 'add_tag', ids, value: 'Texas' })).body.affected).toBe(ids.length);
    expect((await A.agent.post('/api/carriers/bulk').send({ action: 'move_stage', ids, value: 'prospecting' })).body.affected).toBe(ids.length);
    expect((await A.agent.post('/api/carriers/bulk').send({ action: 'set_do_not_call', ids, value: true })).body.affected).toBe(ids.length);
    const c = await prisma.carrier.findUnique({ where: { id: ids[0] }, include: { stage: true } });
    expect(c.stage.key).toBe('prospecting');
    expect(c.doNotCall).toBe(true);
    expect((await A.agent.post('/api/carriers/bulk').send({ action: 'delete', ids })).body.affected).toBe(ids.length);
  });

  it('discovery search annotates existing carriers and saves verified records', async () => {
    const fetchMock = mockCensus();
    const res = await A.agent.get('/api/discovery/search?state=OH');
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalled();
    expect(new URL(String(fetchMock.mock.calls[0][0])).searchParams.get('$where')).toContain("phy_state='OH'");
    expect(res.body.source).toContain('FMCSA');
    const item = res.body.items[0];
    expect(item).toMatchObject({ dotNumber: '1234567', mcNumber: '998877', phone: '6145550101', state: 'OH', fleetSize: 4, authorityStatus: 'active', equipment: 'reefer', existsInCrm: false });

    const saved = await A.agent.post('/api/discovery/save').send({ dotNumbers: ['1234567'] });
    expect(saved.body).toMatchObject({ created: 1, skipped: 0 });
    const c = await prisma.carrier.findFirst({ where: { ownerId: A.user.id, dotNumber: '1234567' } });
    expect(c.source).toBe('fmcsa_census');
    expect(c.verifiedAt).not.toBeNull();

    const again = await A.agent.post('/api/discovery/save').send({ dotNumbers: ['1234567'] });
    expect(again.body).toMatchObject({ created: 0, skipped: 1 });
    const res2 = await A.agent.get('/api/discovery/search?state=OH');
    expect(res2.body.items[0].existsInCrm).toBe(true);
  });

  it('discovery reports upstream rate limiting honestly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) })));
    const res = await A.agent.get('/api/discovery/search?state=OH');
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/rate limit/i);
  });

  it('providers show QCMobile as not configured without a key', async () => {
    const res = await A.agent.get('/api/discovery/providers');
    const qc = res.body.items.find((p) => p.id === 'fmcsa_qc');
    expect(qc.configured).toBe(false);
    expect(res.body.items.find((p) => p.id === 'fmcsa_census').available).toBe(true);
  });

  it('enriches a carrier from FMCSA and reports changed fields', async () => {
    const created = await A.agent.post('/api/carriers').send({ companyName: 'Acme Hauling', dotNumber: '1234568' });
    mockCensus([{ ...CENSUS_ROW, dot_number: '1234568', docket1: '998878', phone: '6145550102' }]);
    const res = await A.agent.post(`/api/carriers/${created.body.carrier.id}/enrich`);
    expect(res.status).toBe(200);
    expect(res.body.changes.phone).toEqual({ from: null, to: '6145550102' });
    expect(res.body.carrier.authorityStatus).toBe('active');
    expect(res.body.sources).toContain('fmcsa_census');
  });
});

describe('carrier profile: activity filters, counts, texts, enrich preview', () => {
  let A; let B; let called; let texted; let quiet;
  beforeAll(async () => {
    A = await registerUser();
    B = await registerUser();
    called = (await A.agent.post('/api/carriers').send({ companyName: 'Called Freight', phone: '6145550111' })).body.carrier;
    texted = (await A.agent.post('/api/carriers').send({ companyName: 'Texted Freight', phone: '6145550112' })).body.carrier;
    quiet = (await A.agent.post('/api/carriers').send({ companyName: 'Quiet Freight', phone: '6145550113' })).body.carrier;
    await A.agent.post('/api/calls').send({ carrierId: called.id, outcome: 'no_answer' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('logs a text by hand and counts it; others cannot', async () => {
    expect((await A.agent.post(`/api/carriers/${texted.id}/texts`).send({ body: 'Hi, this is Dana' })).status).toBe(201);
    expect((await B.agent.post(`/api/carriers/${texted.id}/texts`).send({ body: 'x' })).status).toBe(404);
    const d = await A.agent.get(`/api/carriers/${texted.id}`);
    expect(d.body.carrier.activityCounts).toEqual({ calls: 0, emails: 0, texts: 1 });
    const acts = await A.agent.get(`/api/carriers/${texted.id}/activities?type=text`);
    expect(acts.body.items[0].summary).toMatch(/Text sent to Texted Freight: Hi, this is Dana/);
  });

  it('filters by no activity and returns last call / last activity', async () => {
    const names = async (qs) => (await A.agent.get(`/api/carriers?pageSize=200&${qs}`)).body.items.map((c) => c.companyName);
    const noCall = await names('noActivity=no_call');
    expect(noCall).toEqual(expect.arrayContaining(['Texted Freight', 'Quiet Freight']));
    expect(noCall).not.toContain('Called Freight');
    const none = await names('noActivity=none');
    expect(none).toContain('Quiet Freight');
    expect(none).not.toContain('Texted Freight');
    expect(none).not.toContain('Called Freight');
    expect(await names('noActivity=no_call&activityDays=7')).not.toContain('Called Freight');
    const list = (await A.agent.get('/api/carriers?pageSize=200')).body.items;
    expect(list.find((c) => c.id === called.id).lastCallAt).toBeTruthy();
    expect(list.find((c) => c.id === quiet.id).lastCallAt).toBeNull();
    // B never sees A's carriers through the filter
    expect((await B.agent.get('/api/carriers?noActivity=none')).body.items).toHaveLength(0);
  });

  it('enrich dryRun previews without saving; fields applies only the chosen ones', async () => {
    const c = (await A.agent.post('/api/carriers').send({ companyName: 'Preview Hauling', dotNumber: '1234570' })).body.carrier;
    mockCensus([{ ...CENSUS_ROW, dot_number: '1234570', docket1: '998870', phone: '6145550199', email_address: 'ops@preview.test' }]);
    const prev = await A.agent.post(`/api/carriers/${c.id}/enrich`).send({ dryRun: true });
    expect(prev.body.dryRun).toBe(true);
    expect(prev.body.changes.phone.to).toBe('6145550199');
    expect((await prisma.carrier.findUnique({ where: { id: c.id } })).phone).toBeNull();
    const applied = await A.agent.post(`/api/carriers/${c.id}/enrich`).send({ fields: ['phone'] });
    expect(Object.keys(applied.body.changes)).toEqual(['phone']);
    const after = await prisma.carrier.findUnique({ where: { id: c.id } });
    expect(after.phone).toBe('6145550199');
    expect(after.email).toBeNull();
  });
});
