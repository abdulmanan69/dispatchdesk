/**
 * Layout for platform email: the mail DispatchDesk itself sends (verification, password reset, team invitations,
 * carrier sign-in codes, the daily digest). Mail from a dispatcher to carriers, brokers or customers never uses it:
 * that goes out from the dispatcher's own connected mailbox, in their own words (services/email/compose.js).
 *
 * platformEmail({
 *   appName = 'DispatchDesk', preheader, heading, paragraphs = [], code, button: { label, url }, after = [],
 *   bodyHtml, footer, footerLink: { label, url },
 * }) -> { text, html }
 *
 * Every string is plain text and is escaped. `bodyHtml` is the one exception: markup the caller already escaped
 * (the digest's lists); it goes between the paragraphs and the button. Inline styles and tables only, because
 * Gmail and Outlook drop <style> blocks; 560px wide on a light background, so it reads the same in dark-mode clients.
 */

const BRAND = '#0f766e';
const INK = '#111827';
const BODY = '#374151';
const MUTED = '#6b7280';
const LINE = '#e5e7eb';
const PAGE = '#f4f5f4';
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

export const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const para = (s, extra = '') => `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:${BODY};${extra}">${escHtml(s)}</p>`;

export function platformEmail({
  appName = 'DispatchDesk', preheader = '', heading, paragraphs = [], code = '', button = null, after = [],
  bodyHtml = '', footer = '', footerLink = null,
} = {}) {
  const text = [
    heading,
    '',
    ...paragraphs.flatMap((p) => [p, '']),
    ...(code ? [`Your code: ${code}`, ''] : []),
    ...(button ? [`${button.label}: ${button.url}`, ''] : []),
    ...after.flatMap((p) => [p, '']),
    '--',
    [footer, footerLink ? `${footerLink.label}: ${footerLink.url}` : ''].filter(Boolean).join(' '),
    `${appName}, the CRM for truck dispatchers`,
  ].join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const codeBlock = code ? `
          <tr><td style="padding:4px 0 20px">
            <div style="display:inline-block;padding:14px 22px;border:1px solid #99d6cf;border-radius:10px;background:#f0faf8;font-family:${MONO};font-size:30px;font-weight:600;letter-spacing:8px;color:${BRAND}">${escHtml(code)}</div>
          </td></tr>` : '';

  const buttonBlock = button ? `
          <tr><td style="padding:4px 0 20px">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              <td style="border-radius:8px;background:${BRAND}">
                <a href="${escHtml(button.url)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px">${escHtml(button.label)}</a>
              </td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:0 0 20px;font-size:13px;line-height:1.5;color:${MUTED}">
            If the button does not work, paste this link into your browser:<br>
            <a href="${escHtml(button.url)}" style="color:${BRAND};word-break:break-all">${escHtml(button.url)}</a>
          </td></tr>` : '';

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escHtml(heading)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE}">${escHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${PAGE}">
  <tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:${FONT}">
      <tr><td style="padding:0 4px 16px">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="width:22px;height:22px;border-radius:6px;background:${BRAND}"></td>
          <td style="padding-left:10px;font-size:16px;font-weight:600;color:${INK}">${escHtml(appName)}</td>
        </tr></table>
      </td></tr>
      <tr><td style="background:#ffffff;border:1px solid ${LINE};border-radius:12px;padding:32px 32px 16px">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="padding:0 0 16px;font-size:20px;line-height:1.3;font-weight:600;color:${INK}">${escHtml(heading)}</td></tr>
          <tr><td>${paragraphs.map((p) => para(p)).join('')}</td></tr>${codeBlock}
          ${bodyHtml ? `<tr><td style="padding:0 0 8px;font-size:15px;line-height:1.6;color:${BODY}">${bodyHtml}</td></tr>` : ''}${buttonBlock}
          ${after.length ? `<tr><td>${after.map((p) => para(p, `font-size:14px;color:${MUTED}`)).join('')}</td></tr>` : ''}
        </table>
      </td></tr>
      <tr><td style="padding:16px 4px 0;font-size:12px;line-height:1.5;color:${MUTED}">
        ${escHtml(footer)}${footerLink ? ` <a href="${escHtml(footerLink.url)}" style="color:${MUTED};text-decoration:underline">${escHtml(footerLink.label)}</a>` : ''}
        <br>${escHtml(appName)}, the CRM for truck dispatchers
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
  return { text, html };
}

// ---------------------------------------------------------------------------------------------------------------
// The platform messages. Each returns { subject, text, html }; the routes that send them and the admin preview page
// (GET /api/admin/email-previews) both use these, so the preview is exactly what goes out.
// ---------------------------------------------------------------------------------------------------------------

export function verifyEmailMessage({ appName = 'DispatchDesk', name, email, link }) {
  return {
    subject: `Verify your ${appName} email`,
    ...platformEmail({
      appName,
      preheader: 'Confirm your email address to finish setting up your account.',
      heading: 'Confirm your email address',
      paragraphs: [`Hi ${name || 'there'},`, `Confirm that ${email} is your email address. Then you can use everything in ${appName}.`],
      button: { label: 'Confirm email address', url: link },
      after: ['The link works for 48 hours.'],
      footer: `You get this email because someone created a ${appName} account with this address. If it was not you, ignore it.`,
    }),
  };
}

export function resetPasswordMessage({ appName = 'DispatchDesk', name, link }) {
  return {
    subject: 'Reset your password',
    ...platformEmail({
      appName,
      preheader: 'Choose a new password. The link works for 1 hour.',
      heading: 'Reset your password',
      paragraphs: [`Hi ${name || 'there'},`, `Someone asked to reset the password of your ${appName} account. Choose a new one with the button below.`],
      button: { label: 'Choose a new password', url: link },
      after: ['The link works for 1 hour. If you did not ask for this, ignore this email: your password stays the same.'],
      footer: `You get this email because a password reset was requested for your ${appName} account.`,
    }),
  };
}

export function inviteMessage({ appName = 'DispatchDesk', inviter, team, role, link }) {
  return {
    subject: `${inviter} invited you to ${team} on ${appName}`,
    ...platformEmail({
      appName,
      preheader: `Join ${team} on ${appName}.`,
      heading: `Join ${team} on ${appName}`,
      paragraphs: [`${inviter} invited you to join the team "${team}" as ${role}.`, 'You will share carriers, loads and follow-ups with the team.'],
      button: { label: 'Accept invitation', url: link },
      after: ['The link works for 7 days.'],
      footer: `You get this email because ${inviter} invited this address. If you do not know them, ignore it.`,
    }),
  };
}

export function carrierCodeMessage({ appName = 'DispatchDesk', code, name, dot, signInUrl }) {
  return {
    subject: `${code} is your ${appName} carrier sign-in code`,
    ...platformEmail({
      appName,
      preheader: `Your sign-in code for ${name}. It works for 10 minutes.`,
      heading: 'Your sign-in code',
      paragraphs: [`Use this code to sign in to the ${appName} carrier profile of ${name} (USDOT ${dot}).`],
      code,
      after: [
        'It works for 10 minutes. We sent it to the email address FMCSA has on file for this USDOT number.',
        'If you did not ask for it, ignore this email: nobody can sign in without the code.',
      ],
      footer: 'Your carrier profile keeps your documents in one place and shares them only with the dispatchers you pick.',
      footerLink: { label: 'Carrier sign-in', url: signInUrl },
    }),
  };
}
