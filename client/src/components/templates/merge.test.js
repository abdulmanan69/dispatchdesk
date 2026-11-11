import { describe, it, expect } from 'vitest';
import { canonicalField, mergeText, scriptValues, smsInfo, tokensIn } from './merge.js';

describe('merge helpers', () => {
  it('maps older names and other spellings to the canonical fields', () => {
    expect(canonicalField('sender_name')).toBe('my_name');
    expect(canonicalField('firstName')).toBe('first_name');
    expect(canonicalField('COMPANY')).toBe('company');
    expect([...tokensIn('Hi {{firstName}}, {{ sender_name }} at {{company}}')]).toEqual(['first_name', 'my_name', 'company']);
  });

  it('keeps unknown or empty tokens visible, or shows them in brackets for previews', () => {
    const values = { company: 'Red River', mc: '' };
    expect(mergeText('{{company}} MC {{mc}} {{typo}}', values)).toBe('Red River MC {{mc}} {{typo}}');
    expect(mergeText('{{company}} MC {{mc}} {{first_name}}', values, { missing: 'bracket' })).toBe('Red River MC [mc] [first name]');
  });

  it('fills call scripts from the primary contact and the signed-in user', () => {
    const v = scriptValues({
      carrier: { companyName: 'Red River', mcNumber: '1184420', state: 'LA', equipment: 'dry_van,reefer' },
      contacts: [{ name: 'Ann Lee' }, { name: 'Marcus Hill', isPrimary: true }],
      user: { name: 'Dana Ruiz', phone: '2145550101' },
    });
    expect(v).toMatchObject({ company: 'Red River', first_name: 'Marcus', contact_name: 'Marcus Hill', mc: '1184420', equipment: 'dry van, reefer', my_name: 'Dana Ruiz', my_first_name: 'Dana' });
    expect(scriptValues({ carrier: { companyName: 'X' }, user: {} }).first_name).toBe('there');
    expect(mergeText('This is {{sender_name}}', scriptValues({ user: { name: 'Dana Ruiz' } }))).toBe('This is Dana Ruiz');
  });

  it('fills {{my_company}} from the team, else the company name, else leaves the token', () => {
    const line = 'Calling from {{my_company}}';
    expect(mergeText(line, scriptValues({ user: { team: { name: 'Lee Dispatch' }, companyName: 'Solo Co' } }))).toBe('Calling from Lee Dispatch');
    expect(mergeText(line, scriptValues({ user: { team: null, companyName: '  Solo Co ' } }))).toBe('Calling from Solo Co');
    expect(mergeText(line, scriptValues({ user: { team: null, companyName: null } }))).toBe(line);
    expect(mergeText(line, scriptValues({ user: { companyName: '' } }), { missing: 'bracket' })).toBe('Calling from [my company]');
  });

  it('counts SMS segments for plain and Unicode text', () => {
    expect(smsInfo('')).toMatchObject({ chars: 0, segments: 0 });
    expect(smsInfo('a'.repeat(160))).toMatchObject({ segments: 1, unicode: false });
    expect(smsInfo('a'.repeat(161))).toMatchObject({ segments: 2 });
    expect(smsInfo('a'.repeat(306)).segments).toBe(2);
    expect(smsInfo('a'.repeat(307)).segments).toBe(3);
    expect(smsInfo(`${'a'.repeat(69)}é`).segments).toBe(1); // é is in the GSM set
    expect(smsInfo(`${'a'.repeat(70)}✓`)).toMatchObject({ unicode: true, segments: 2 });
    expect(smsInfo('{}').chars).toBe(2); // extension characters count double for segments only
  });
});
