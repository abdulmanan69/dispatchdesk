import { useState } from 'react';
import { ArrowUpRight, ChevronDown, Copy } from 'lucide-react';
import { useToast } from '../Toast.jsx';
import { cx } from '../ui.jsx';

const GUIDES = {
  gmail: {
    name: 'Google (Gmail and Workspace)',
    console: 'https://console.cloud.google.com/apis/credentials',
    steps: [
      'In Google Cloud Console, create or pick a project and enable the Gmail API.',
      'Open OAuth consent screen. Choose External (or Internal for one Workspace), add your app name, support email and the scopes below.',
      'While the app is in Testing, add each user as a test user. Publish it for everyone; Google may ask for verification because gmail.send is a sensitive scope.',
      'Credentials → Create credentials → OAuth client ID → Web application. Add both redirect URIs below exactly: one connects mailboxes, the other is for Continue with Google.',
      'Paste the client ID and client secret into the fields below, save, then press Check Google.',
    ],
    // Continue with Google (sign-in) uses the same OAuth client with its own redirect URI and only the basic scopes.
    signIn: { path: '/api/auth/google/callback', scopes: ['openid', 'email', 'profile'] },
  },
  outlook: {
    name: 'Microsoft (Outlook.com and Microsoft 365)',
    console: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    steps: [
      'In Microsoft Entra admin center, App registrations → New registration.',
      'Supported account types: "Accounts in any organizational directory and personal Microsoft accounts" (tenant "common"). Use your tenant ID below to limit sign-in to your organisation.',
      'Redirect URI: platform Web, value below exactly.',
      'API permissions → Microsoft Graph → Delegated: the scopes below. Grant admin consent if your organisation requires it.',
      'Certificates & secrets → New client secret. Copy the secret value (not the ID), paste both here, save, then press Check Microsoft.',
    ],
  },
};

function CopyRow({ value }) {
  const toast = useToast();
  return (
    <div className="flex items-center gap-2 rounded-md border border-line bg-surface px-2 py-1.5">
      <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
      <button type="button" aria-label="Copy" className="text-muted transition-ui hover:text-fg"
        onClick={async () => { try { await navigator.clipboard.writeText(value); toast.success('Copied'); } catch { toast.error('Copy failed'); } }}>
        <Copy className="size-3.5" />
      </button>
    </div>
  );
}

function Scopes({ list }) {
  return <div className="flex flex-wrap gap-1">{list.map((s) => <code key={s} className="rounded border border-line bg-surface px-1.5 py-0.5 font-mono">{s}</code>)}</div>;
}

/** Step-by-step OAuth app registration guide with the exact redirect URIs and scopes for this server. */
export default function OAuthSetupGuide({ oauth, appUrl }) {
  const [open, setOpen] = useState(null);
  if (!oauth) return null;
  const insecure = !/^https:\/\//.test(appUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(appUrl);
  return (
    <div className="mb-4 space-y-2">
      <p className="text-xs text-muted">Register one OAuth app per provider. After that every user connects their own mailbox with one click from Email → Mailboxes. The Google app also turns on Continue with Google for sign-in.</p>
      {insecure && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">APP_URL is {appUrl}. Google and Microsoft only accept HTTPS redirect URIs (localhost is the exception). Set APP_URL to your public HTTPS address first.</p>}
      {Object.entries(GUIDES).map(([key, g]) => (
        <div key={key} className="rounded-lg border border-line">
          <button type="button" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}
            className="flex w-full items-center justify-between px-3 py-2 text-[13px] font-medium transition-ui hover:bg-surface-2">
            Set up {g.name}
            <ChevronDown className={cx('size-4 text-muted transition-ui', open === key && 'rotate-180')} />
          </button>
          {open === key && (
            <div className="space-y-3 border-t border-line p-3 text-xs">
              <ol className="list-decimal space-y-1 pl-4 text-fg-2">{g.steps.map((s) => <li key={s}>{s}</li>)}</ol>
              <div><p className="mb-1 text-muted">{g.signIn ? 'Redirect URI for mailboxes' : 'Redirect URI'}</p><CopyRow value={oauth[key].redirectUri} /></div>
              <div><p className="mb-1 text-muted">Scopes</p><Scopes list={oauth[key].scopes} /></div>
              {g.signIn && (
                <div className="space-y-2 rounded-md bg-surface-2 p-2.5">
                  <div><p className="mb-1 text-muted">Redirect URI for Continue with Google</p><CopyRow value={`${appUrl}${g.signIn.path}`} /></div>
                  <p className="text-fg-2">Sign-in needs only the basic profile scopes below, not the Gmail API. Once the client ID and secret are saved, Continue with Google appears on the log in and sign up pages.</p>
                  <Scopes list={g.signIn.scopes} />
                </div>
              )}
              <a href={g.console} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-brand-700 hover:underline dark:text-brand-300">Open console <ArrowUpRight className="size-3.5" /></a>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
