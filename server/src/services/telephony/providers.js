import { badRequest } from '../../lib/errors.js';
import { digitsOf } from './phone.js';

/**
 * Calling providers. "link" providers open a URL/app on the user's device and the user presses call there;
 * nothing is dialed by the server. "bridge" (Twilio) rings the dispatcher's own phone first, then connects
 * the carrier after they answer — still started by one explicit click per call.
 *
 * Only documented / standard link formats are used. Desktop softphones (8x8 Work, RingCentral, Dialpad)
 * register as the operating system's tel: handler, so they use tel: links.
 */
export const PROVIDERS = [
  {
    key: 'tel', label: 'Default phone app', kind: 'link',
    description: 'Opens a tel: link. Your computer or phone uses whatever calling app is set as default.',
    setup: ['Pick a default calling app in your operating system (for example FaceTime/iPhone, Phone Link on Windows, or your softphone).'],
  },
  {
    key: 'google_voice', label: 'Google Voice', kind: 'link',
    description: 'Opens Google Voice on the web with the number filled in. Press Call there. Google Voice has no public calling API, so calls cannot be started automatically.',
    setup: ['Sign in at voice.google.com in this browser with the account that owns your Google Voice number.', 'Allow microphone access for voice.google.com.', 'Optional: in Google Voice settings choose whether calls ring from the web or your linked phone.'],
  },
  {
    key: 'eight_by_eight', label: '8x8 Work', kind: 'link',
    description: 'Opens a tel: link that the 8x8 Work desktop app handles when it is your default calling app.',
    setup: ['Install the 8x8 Work desktop app and sign in.', 'In 8x8 Work settings, enable it as the default app for tel: links (or set it as the default calling app in Windows/macOS settings).'],
  },
  {
    key: 'ringcentral', label: 'RingCentral app', kind: 'link',
    description: 'Opens a tel: link that the RingCentral desktop app handles when it is your default calling app.',
    setup: ['Install the RingCentral desktop app and sign in.', 'Set RingCentral as the default calling app in its settings or in your operating system.'],
  },
  {
    key: 'dialpad', label: 'Dialpad app', kind: 'link',
    description: 'Opens a tel: link that the Dialpad desktop app handles when it is your default calling app.',
    setup: ['Install the Dialpad desktop app and sign in.', 'Enable “Make Dialpad the default calling app” in Dialpad settings.'],
  },
  {
    key: 'zoom_phone', label: 'Zoom Phone', kind: 'link',
    description: 'Opens the Zoom desktop app with the number ready to call (zoomphonecall: link).',
    setup: ['Install the Zoom desktop app and sign in with a Zoom Phone licence.'],
  },
  {
    key: 'teams', label: 'Microsoft Teams', kind: 'link',
    description: 'Opens a Microsoft Teams call to the number. Requires a Teams Phone (PSTN calling) licence.',
    setup: ['Sign in to Microsoft Teams with an account that has Teams Phone / calling plan enabled.'],
  },
  {
    key: 'callto', label: 'callto: link', kind: 'link',
    description: 'Opens a callto: link for softphones that register that scheme.',
    setup: ['Make sure your softphone registers the callto: scheme.'],
  },
  {
    key: 'sip', label: 'SIP softphone', kind: 'link', needs: ['urlTemplate'],
    description: 'Opens a sip: address for a SIP softphone. Enter a template such as sip:{number}@pbx.example.com.',
    setup: ['Install a SIP softphone (for example Zoiper or Bria) registered with your PBX.', 'Enter your SIP template using {number} (E.164) or {digits}.'],
  },
  {
    key: 'custom', label: 'Custom link', kind: 'link', needs: ['urlTemplate'],
    description: 'Any web dialer or app link. Use {number} for E.164 (+15551234567) or {digits} for 10 digits.',
    setup: ['Enter the link template your provider documents, for example https://dialer.example.com/call?to={number}.'],
  },
  {
    key: 'twilio', label: 'Twilio bridge (automatic logging)', kind: 'bridge', needs: ['twilioAccountSid', 'twilioAuthToken', 'callerId', 'myNumber'],
    description: 'One click rings your phone first, then connects the carrier when you answer. Ringing, answer and duration are tracked, and unanswered calls can be logged automatically.',
    setup: ['Create a Twilio account and buy or verify a phone number to use as caller ID.', 'Enter your Account SID and Auth Token from the Twilio console.', 'Enter your own phone number — Twilio rings it first.', 'Twilio must reach this app at APP_URL for status updates, so APP_URL must be a public https address.'],
  },
];

export const PROVIDER_KEYS = PROVIDERS.map((p) => p.key);
export const providerByKey = (k) => PROVIDERS.find((p) => p.key === k);

const SAFE_TEMPLATE = /^(https:\/\/|sip:|sips:|tel:|callto:|[a-z][a-z0-9+.-]{1,30}:)/i;
const BLOCKED_SCHEMES = /^(javascript|data|vbscript|file|blob):/i;

/** Validate a custom / sip URL template. */
export function validateTemplate(template) {
  const t = String(template || '').trim();
  if (!t) throw badRequest('Enter a link template');
  if (BLOCKED_SCHEMES.test(t)) throw badRequest('That link scheme is not allowed');
  if (/^http:\/\//i.test(t)) throw badRequest('Use an https:// link');
  if (!SAFE_TEMPLATE.test(t)) throw badRequest('The template must start with https:// or an app scheme such as sip:');
  if (!t.includes('{number}') && !t.includes('{digits}')) throw badRequest('Include {number} or {digits} where the phone number goes');
  if (t.length > 500) throw badRequest('Template is too long');
  return t;
}

/** Build the link a link-provider opens for an E.164 number. */
export function buildLink(provider, e164, settings = {}) {
  const digits = digitsOf(e164);
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  switch (provider) {
    case 'google_voice':
      return `https://voice.google.com/u/0/calls?a=nc,${encodeURIComponent(e164)}`;
    case 'teams':
      return `https://teams.microsoft.com/l/call/0/0?users=4:${encodeURIComponent(e164)}`;
    case 'zoom_phone':
      return `zoomphonecall://${encodeURIComponent(e164)}`;
    case 'callto':
      return `callto:${e164}`;
    case 'sip':
    case 'custom': {
      const t = validateTemplate(settings.urlTemplate);
      return t.replaceAll('{number}', encodeURIComponent(e164)).replaceAll('{digits}', national);
    }
    case 'tel':
    case 'eight_by_eight':
    case 'ringcentral':
    case 'dialpad':
    default:
      return `tel:${e164}`;
  }
}
