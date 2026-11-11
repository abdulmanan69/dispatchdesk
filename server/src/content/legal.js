/**
 * Public legal pages (privacy policy, terms of service) and a plain-HTML summary of the home page.
 *
 * The server writes this HTML into index.html for /, /privacy and /terms, so crawlers and reviewers that do not run
 * JavaScript (search engines, Google's OAuth brand verification) read the full text. The React pages show the same
 * HTML (GET /api/public/legal/:doc), so there is one source of truth. Every interpolated value is escaped.
 */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const LEGAL_UPDATED = 'November 11, 2026';

function contactLine({ supportEmail, appUrl }) {
  return supportEmail
    ? `email <a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a>`
    : `use the contact details on <a href="${esc(appUrl)}">${esc(appUrl)}</a>`;
}

export function privacyHtml({ appName = 'DispatchDesk', appUrl = '', supportEmail = '' } = {}) {
  const n = esc(appName);
  return `<article class="prose-dd mx-auto max-w-3xl px-4 py-14 text-[15px]" data-legal="privacy">
<h1>Privacy policy</h1>
<p>Last updated: ${LEGAL_UPDATED}</p>
<p>${n} (${esc(appUrl)}) is a CRM and dispatch desk for truck dispatchers. This policy explains what information ${n} collects, how it is used and shared, how long it is kept, and the choices you have. It applies to the ${n} website and web app, the ${n} browser extension, and the links ${n} users send to drivers, brokers and carriers.</p>

<h2>Information we collect</h2>
<h3>Account information</h3>
<p>When you create an account: your name, email address, password (stored only as a salted hash), and optionally your phone number, company name, time zone and profile photo. If you choose Continue with Google, we receive your name, email address, profile picture and Google account ID from Google (scopes <code>openid</code>, <code>email</code>, <code>profile</code>).</p>
<h3>Information you add to the app</h3>
<p>The business records you create or import: carriers, contacts, brokers, loads, rates, notes, call logs, follow-ups, email templates, sequences, invoices, statements, and documents you upload (for example rate confirmations, BOLs, PODs, W-9s and insurance certificates).</p>
<h3>Connected mailboxes</h3>
<p>If you connect a mailbox so ${n} can send email on your behalf:</p>
<ul>
<li><strong>Gmail:</strong> with your permission we request the <code>gmail.send</code> scope, which lets ${n} send the emails you write or schedule from your Gmail account. We do not read, index or store your Gmail inbox through this permission.</li>
<li><strong>Outlook / Microsoft 365:</strong> we request <code>Mail.Send</code> to send the emails you write or schedule.</li>
<li><strong>SMTP and optional IMAP:</strong> if you enter mail server details, we use them to send your emails and, only if you turn on reply detection, to check new messages for replies and bounces to emails sent from ${n}.</li>
</ul>
<p>Access tokens and mailbox passwords are encrypted at rest (AES-256-GCM) and used only to provide these features.</p>
<h3>Location information from drivers</h3>
<p>A dispatcher can send a driver a live-location link. The driver's location is collected only after the driver opens that link, enters the PIN if one is required, and agrees to share. Location is sent only while the page is open and sharing is on; the driver can stop at any time. The link works on one phone only. Location points are deleted after 30 days.</p>
<h3>Information from public sources</h3>
<p>To help you vet carriers and brokers, ${n} looks up public FMCSA records (company census and licensing data published by the U.S. Department of Transportation) by MC or USDOT number. We also show public diesel price data from the U.S. Energy Information Administration.</p>
<h3>Usage and technical information</h3>
<p>Session records (to keep you signed in), security and audit logs (for example sign-ins and changes to sensitive settings), IP address and browser details for security and rate limiting, and basic error logs. We do not use third-party advertising or tracking cookies.</p>
<h3>Payments</h3>
<p>Paid plans are processed by Stripe. Card details are entered on Stripe's pages and are never stored by ${n}; we keep the subscription status and plan.</p>

<h2>How we use information</h2>
<ul>
<li>To provide the service: show and organize your records, place calls through the phone service you choose, send the emails you write or schedule, plan trips and routes, track loads, and create invoices and statements.</li>
<li>To send service email: account verification, password reset, team invitations, notifications and the optional daily digest.</li>
<li>To keep the service secure: authentication, preventing abuse and fraud, rate limiting and audit logs.</li>
<li>To operate and improve the service: troubleshooting, performance and reliability.</li>
</ul>
<p>We do not sell personal information, and we do not use your information for advertising.</p>

<h2>Google user data</h2>
<p>${n}'s use and transfer of information received from Google APIs to any other app will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements. Specifically:</p>
<ul>
<li>Google sign-in data (name, email, profile picture, account ID) is used only to create your account and sign you in.</li>
<li>The Gmail permission is used only to send the emails you write or schedule in ${n}, from your own account.</li>
<li>We do not use Google user data for advertising, we do not sell it, and we do not transfer it to third parties except as needed to provide or improve the features you use, to comply with law, or with your consent.</li>
<li>No person at ${n} reads Google user data unless you ask us to for support, it is needed for security or abuse investigations, or the law requires it.</li>
<li>Google user data is not used to train artificial intelligence models.</li>
</ul>
<p>You can disconnect Google at any time in Settings (Security for sign-in, Email for a connected Gmail mailbox) or from your Google account permissions page.</p>

<h2>How we share information</h2>
<p>We share information only with service providers that help us run ${n}, and only as needed for the feature you use:</p>
<ul>
<li>Hosting and storage provider (servers where the app and database run).</li>
<li>Brevo (service email such as verification and password reset).</li>
<li>Stripe (payments for paid plans).</li>
<li>Google and Microsoft (sign-in and the mailboxes you connect).</li>
<li>Map and routing services based on OpenStreetMap (map tiles, routing and address search). They receive coordinates and place names needed to draw maps and routes, not your account details.</li>
<li>Browser push services (if you turn on notifications on a device).</li>
<li>An AI provider, only if the operator turned on AI features and you use them; requests include only your own records needed for that request.</li>
</ul>
<p>Within a team, the team owner and managers can see team members' records as the team's permissions allow. Links you create (driver location, broker tracking, carrier portal, onboarding) show the people you send them to only the information on that page. We may also disclose information if the law requires it or to protect the rights and safety of users and the public.</p>

<h2>Retention</h2>
<ul>
<li>Your account and records are kept while your account is active.</li>
<li>Driver location points: 30 days.</li>
<li>Read notifications: 90 days; unread notifications: 1 year.</li>
<li>Routine activity history: 18 months.</li>
<li>Audit logs: 1 year.</li>
<li>Database backups: the newest 7 daily backups.</li>
</ul>
<p>When you delete your account, your records and uploaded files are deleted. Copies in backups disappear as those backups are replaced, within 7 days.</p>

<h2>Security</h2>
<p>Connections use HTTPS. Passwords are hashed, integration secrets are encrypted at rest, each workspace's records are kept separate, and sensitive actions are logged. No system is perfectly secure, but we work to protect your information and fix problems quickly.</p>

<h2>Your choices and rights</h2>
<ul>
<li>Export all of your data as a file at any time (Settings → Data).</li>
<li>Correct your information in the app, or delete your account (Settings → Data).</li>
<li>Disconnect Google, Microsoft or other mailboxes at any time.</li>
<li>Turn notifications and the daily digest on or off in Settings.</li>
<li>Recipients of outreach email can unsubscribe with the link in each email.</li>
</ul>
<p>Depending on where you live (for example California or the European Economic Area), you may have rights to access, correct, delete or port your information and to object to certain processing. To make a request, ${contactLine({ supportEmail, appUrl })}.</p>

<h2>Children</h2>
<p>${n} is a business tool and is not intended for anyone under 16. We do not knowingly collect information from children.</p>

<h2>Changes to this policy</h2>
<p>We will post any changes on this page and update the date above. If a change is significant, we will tell signed-in users in the app.</p>

<h2>Contact</h2>
<p>Questions about this policy or your information: ${contactLine({ supportEmail, appUrl })}.</p>
</article>`;
}

export function termsHtml({ appName = 'DispatchDesk', appUrl = '', supportEmail = '' } = {}) {
  const n = esc(appName);
  return `<article class="prose-dd mx-auto max-w-3xl px-4 py-14 text-[15px]" data-legal="terms">
<h1>Terms of service</h1>
<p>Last updated: ${LEGAL_UPDATED}</p>
<p>These terms govern your use of ${n} (${esc(appUrl)}). By creating an account or using the service you agree to them. If you use ${n} for a company, you accept these terms for that company.</p>

<h2>The service</h2>
<p>${n} is software for truck dispatchers: a CRM for carrier leads, calling and email outreach, and a dispatch desk for loads, trucks, invoices and documents. ${n} is not a freight broker or motor carrier, does not arrange transportation, and is not a party to any agreement between you, carriers, brokers or shippers.</p>

<h2>Your account</h2>
<ul>
<li>Give accurate information and keep your sign-in details secure. You are responsible for activity in your account.</li>
<li>Team owners are responsible for the members they invite and the permissions they grant.</li>
<li>Tell us promptly if you believe your account was accessed without permission.</li>
</ul>

<h2>Acceptable use</h2>
<p>You agree not to:</p>
<ul>
<li>break any law, including laws on calls, text messages and email (for example the TCPA and CAN-SPAM), privacy and data protection;</li>
<li>contact people who asked not to be contacted, or remove unsubscribe links from outreach email;</li>
<li>share someone's location without their consent, or misuse driver, broker or carrier links;</li>
<li>upload unlawful, infringing or malicious content, or try to break, overload or reverse engineer the service;</li>
<li>access other users' data or use the service to build a competing data set.</li>
</ul>
<p>Calls and texts are placed through your own phone service; ${n} never dials or texts automatically, and you are responsible for the messages you send.</p>

<h2>Your data</h2>
<p>You own the records and files you put into ${n}. You give us permission to store and process them only to provide the service, as described in the <a href="${esc(appUrl)}/privacy">privacy policy</a>. You can export or delete your data at any time.</p>

<h2>Public and third-party data</h2>
<p>Carrier, broker and fuel information from public sources (FMCSA, EIA and others), map and route information, and estimates such as ETAs, legal ETAs and rate calculations are provided for convenience and may be incomplete, delayed or wrong. Always confirm authority, insurance, bonds, appointments and rates before you rely on them. Third-party services you connect (mailboxes, phone services, Stripe) have their own terms.</p>

<h2>Plans and payment</h2>
<ul>
<li>The Free plan has usage limits. Paid plans are billed in advance through Stripe and renew until cancelled.</li>
<li>You can cancel at any time in Billing; the plan stays active until the end of the paid period. Fees are not refunded except where the law requires.</li>
<li>We may change prices with at least 30 days' notice before your next renewal.</li>
</ul>

<h2>Availability and changes</h2>
<p>We work to keep ${n} available and secure but do not guarantee it will be uninterrupted or error free. We may change or discontinue features, and will give reasonable notice of changes that materially reduce the service you pay for.</p>

<h2>Suspension and termination</h2>
<p>You may stop using ${n} and delete your account at any time. We may suspend or close accounts that break these terms or put the service or other users at risk. When an account is closed, its data is deleted as described in the privacy policy.</p>

<h2>Disclaimers and limitation of liability</h2>
<p>${n} is provided "as is". To the extent the law allows, we disclaim implied warranties, and we are not liable for indirect or consequential damages, lost profits or lost freight revenue. Our total liability for any claim is limited to the amount you paid us in the 12 months before the claim.</p>

<h2>Changes to these terms</h2>
<p>We may update these terms. We will post the new version here with a new date and, for significant changes, tell signed-in users in the app. Continuing to use ${n} after a change means you accept the updated terms.</p>

<h2>Contact</h2>
<p>Questions about these terms: ${contactLine({ supportEmail, appUrl })}.</p>
</article>`;
}

/** Plain summary of the home page for crawlers and reviewers that do not run JavaScript (React replaces it). */
export function homeHtml({ appName = 'DispatchDesk', appUrl = '' } = {}) {
  const n = esc(appName);
  return `<main class="mx-auto max-w-3xl px-4 py-14" data-ssr="home">
<h1>${n}: the CRM and dispatch desk for truck dispatchers</h1>
<p>${n} helps independent truck dispatchers find carriers, call and email them, and keep their trucks moving, all in one place.</p>
<ul>
<li>Carrier leads from public FMCSA data, a power dialer that uses your own phone service, email sequences and follow-ups.</li>
<li>Loads, rate confirmation import, broker checks, a live fleet map with road routes and ETAs, and driver location links shared with consent.</li>
<li>Invoices, detention, weekly carrier statements and profit reports.</li>
</ul>
<p>Free plan, no card needed. <a href="${esc(appUrl)}/register">Create an account</a> or <a href="${esc(appUrl)}/login">sign in</a>.</p>
<p><a href="${esc(appUrl)}/privacy">Privacy policy</a> · <a href="${esc(appUrl)}/terms">Terms of service</a></p>
</main>`;
}

export const LEGAL_DOCS = { privacy: privacyHtml, terms: termsHtml };
