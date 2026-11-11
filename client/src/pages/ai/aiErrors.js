// Wording for AI errors and the AI source line. Codes come from the server (services/ai/providers/common.js):
// AI_NOT_CONFIGURED (503), AI_QUOTA (429, the plan's monthly limit), AI_KEY_REJECTED / AI_KEY_UNREADABLE /
// AI_MODEL_NOT_FOUND (the user's own key or model).

export const AI_SETTINGS = '/app/settings?tab=ai';
export const AI_OFF = 'AI is off: ask your admin or add your own key in Settings → AI.';

/** { message, links: [{ label, to }] } for an error from an AI endpoint. */
export function describeAiError(err) {
  const code = err?.details?.code || err?.code;
  if (code === 'AI_NOT_CONFIGURED') return { message: AI_OFF, links: [{ label: 'Add your own key', to: AI_SETTINGS }] };
  if (code === 'AI_QUOTA') {
    return {
      message: err?.message || 'Monthly AI limit reached for your plan. Upgrade or add your own key in Settings → AI.',
      links: [{ label: 'See plans', to: '/app/billing' }, { label: 'Add your own key', to: AI_SETTINGS }],
    };
  }
  if (code === 'AI_KEY_REJECTED' || code === 'AI_KEY_UNREADABLE' || code === 'AI_MODEL_NOT_FOUND') {
    const base = String(err?.message || 'The AI provider rejected your key').replace(/\.$/, '');
    return { message: `${base}. Check your key and model in Settings → AI.`, links: [{ label: 'Open Settings → AI', to: AI_SETTINGS }] };
  }
  return { message: err?.message || 'The AI request failed. Try again.', links: [] };
}

/** "Using your own key" or "Using DispatchDesk AI · N of M this month" (from GET /api/ai/status). */
export function aiSourceLabel(s) {
  if (!s?.configured) return null;
  if (s.source === 'byok') return 'Using your own key';
  const u = s.usage;
  if (!u) return 'Using DispatchDesk AI';
  return u.limit < 0 ? `Using DispatchDesk AI · ${u.used} this month` : `Using DispatchDesk AI · ${u.used} of ${u.limit} this month`;
}
