import { describe, it, expect } from 'vitest';
import { registerUser, prisma } from './helpers.js';
import { renderContent, renderPreview, sampleValues, myCompany } from '../src/services/email/render.js';

describe('company name', () => {
  it('is saved through the profile (trimmed, blank clears it, at most 120 characters) and returned in /me', async () => {
    const A = await registerUser();
    expect((await A.agent.get('/api/auth/me')).body.user.companyName).toBeNull();
    const saved = await A.agent.patch('/api/profile').send({ companyName: '  Ruiz Dispatch LLC  ' });
    expect(saved.status).toBe(200);
    expect(saved.body.user.companyName).toBe('Ruiz Dispatch LLC');
    expect((await A.agent.get('/api/auth/me')).body.user.companyName).toBe('Ruiz Dispatch LLC');
    // Other fields leave it alone.
    expect((await A.agent.patch('/api/profile').send({ phone: '2145550101' })).body.user.companyName).toBe('Ruiz Dispatch LLC');
    expect((await A.agent.patch('/api/profile').send({ companyName: 'x'.repeat(121) })).status).toBe(400);
    expect((await A.agent.patch('/api/profile').send({ companyName: 42 })).status).toBe(400);
    expect((await prisma.user.findUnique({ where: { id: A.user.id } })).companyName).toBe('Ruiz Dispatch LLC');
    for (const blank of ['   ', '', null]) {
      await A.agent.patch('/api/profile').send({ companyName: 'Again' });
      const cleared = await A.agent.patch('/api/profile').send({ companyName: blank });
      expect(cleared.status).toBe(200);
      expect(cleared.body.user.companyName).toBeNull();
    }
  });

  it('fills {{my_company}}: the team name first, else the company name, else unresolved', () => {
    const solo = { name: 'Dana Ruiz', companyName: 'Ruiz Dispatch' };
    const team = { name: 'Dana Ruiz', companyName: 'Ruiz Dispatch', teamMembership: { team: { name: 'Lone Star Dispatch' } } };
    const none = { name: 'Dana Ruiz', companyName: '   ' };
    expect(myCompany(team)).toBe('Lone Star Dispatch');
    expect(myCompany(solo)).toBe('Ruiz Dispatch');
    expect(myCompany(none)).toBeNull();
    expect(renderContent({ subject: '', body: 'Dana from {{my_company}}', user: solo, channel: 'sms' }).body).toBe('Dana from Ruiz Dispatch');
    expect(renderContent({ subject: '', body: 'Dana from {{sender_company}}', user: team, channel: 'sms' }).body).toBe('Dana from Lone Star Dispatch');
    expect(renderContent({ subject: '', body: 'Dana from {{my_company}}', user: none, channel: 'sms' }).body).toBe('Dana from ');
    const preview = renderPreview({ subject: '', body: 'From {{my_company}}', channel: 'sms', user: none });
    expect(preview.body).toBe('From {{my_company}}');
    expect(preview.unresolved).toEqual(['my_company']);
    expect(renderPreview({ subject: '', body: 'From {{my_company}}', channel: 'sms', user: solo }).unresolved).toEqual([]);
    expect(sampleValues({ user: solo }).my_company).toBe('Ruiz Dispatch');
    expect(sampleValues({ user: team }).my_company).toBe('Lone Star Dispatch');
  });

  it('the template preview endpoint uses the saved company name, and a team name once on a team', async () => {
    const A = await registerUser();
    await A.agent.patch('/api/profile').send({ companyName: 'Ruiz Dispatch' });
    const solo = await A.agent.post('/api/templates/render').send({ channel: 'sms', body: 'From {{my_company}}' });
    expect(solo.status).toBe(200);
    expect(solo.body.body).toBe('From Ruiz Dispatch');
    expect((await A.agent.post('/api/teams').send({ name: 'Lone Star Dispatch' })).status).toBe(201);
    const team = await A.agent.post('/api/templates/render').send({ channel: 'sms', body: 'From {{my_company}}' });
    expect(team.body.body).toBe('From Lone Star Dispatch');
  });
});
