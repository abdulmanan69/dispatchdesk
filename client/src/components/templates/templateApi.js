import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api.js';

/** Template categories shared by both channels (server: TEMPLATE_CATEGORIES in routes/templates.js). */
export const TEMPLATE_CATEGORIES = [
  { value: 'carrier', label: 'Carrier', color: 'blue' },
  { value: 'broker', label: 'Broker', color: 'purple' },
  { value: 'driver', label: 'Driver', color: 'teal' },
  { value: 'follow_up', label: 'Follow-up', color: 'amber' },
  { value: 'other', label: 'Other', color: 'gray' },
];
export const categoryMeta = (v) => TEMPLATE_CATEGORIES.find((c) => c.value === v) || { value: v, label: String(v || 'Other'), color: 'gray' };

export const CHANNELS = { email: 'email', sms: 'sms' };
export const channelLabel = (c) => (c === 'email' ? 'Email' : 'Text message');

/**
 * Email templates live at /api/email/templates (shared with the email center); text templates at /api/templates/text.
 * Both lists share query keys with the rest of the app so an edit anywhere refreshes every picker.
 */
export const templatesKey = (channel) => (channel === 'email' ? ['email', 'templates'] : ['templates', 'sms']);
export const templatesUrl = (channel) => (channel === 'email' ? '/api/email/templates' : '/api/templates/text');
export const starterKey = (channel) => ['templates', 'starter', channel];
export const invalidateFor = (channel) => [templatesKey(channel), starterKey(channel)];

export function useTemplates(channel, { enabled = true } = {}) {
  return useQuery({ queryKey: templatesKey(channel), queryFn: () => api.get(templatesUrl(channel)), enabled, staleTime: 60000 });
}

export function useStarterInfo(channel, { enabled = true } = {}) {
  return useQuery({ queryKey: starterKey(channel), queryFn: () => api.get('/api/templates/starter', { channel }), enabled, staleTime: 300000 });
}

/** Merge-field catalog from the server (static per release). */
export function useMergeFields() {
  return useQuery({ queryKey: ['templates', 'fields'], queryFn: () => api.get('/api/templates/fields'), staleTime: Infinity, gcTime: Infinity });
}

/** POST /api/templates/render -> { subject?, body, signature, unresolved, unknown, fallbacks, template } */
export const renderTemplate = (payload) => api.post('/api/templates/render', payload);
export const installStarter = (channel) => api.post('/api/templates/starter', { channel });

/** Sort for pickers and lists: most used first, then name. */
export const byUse = (a, b) => (b.useCount || 0) - (a.useCount || 0) || String(a.name).localeCompare(String(b.name));

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
export const usesLabel = (n) => (n ? `Used ${plural(n, 'time', 'times')}` : 'Not used yet');

/** Readable list of merge fields that had no value, e.g. "{{pickup_city}} and {{rate}}". */
export function fieldList(keys = []) {
  const t = keys.map((k) => `{{${k}}}`);
  if (t.length <= 1) return t[0] || '';
  return `${t.slice(0, -1).join(', ')} and ${t[t.length - 1]}`;
}
