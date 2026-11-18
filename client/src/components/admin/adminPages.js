import {
  CreditCard, Flag, GraduationCap, LayoutDashboard, ListChecks, Mail, Megaphone, Package, Plug, Repeat, ScrollText,
  Server, SlidersHorizontal, Sparkles, Ticket, Users, Wallet,
} from 'lucide-react';
import { LABELS, HINTS, SETTINGS_PAGES } from './settingsMeta.js';

const SETTINGS_ICON = { app: SlidersHorizontal, billing: CreditCard, email: Mail, ai: Sparkles, integrations: Plug, announcement: Megaphone };

/**
 * The admin menu: every page with where it lives (`tab`, and `section` for a settings page), who may open it, what it
 * is for and the words people search for. `count` names a number from /api/admin/attention shown next to the page.
 */
export const ADMIN_MENU = [
  {
    group: 'Home',
    items: [
      { tab: 'overview', label: 'Overview', icon: LayoutDashboard, perm: 'admin.access', desc: 'Users, revenue, trials and plans at a glance', keywords: 'dashboard stats revenue mrr growth registrations cancel reasons' },
      { tab: 'setup', label: 'Setup checklist', icon: ListChecks, perm: 'admin.settings', count: 'setupTodo', desc: 'Everything this site needs, checked against its real configuration', keywords: 'setup checklist domain dns https app url deploy set up paddle polar stripe products webhook' },
    ],
  },
  {
    group: 'People',
    items: [
      { tab: 'users', label: 'Users', icon: Users, perm: 'admin.users', desc: 'Find accounts, change roles, suspend, give plans and email users', keywords: 'accounts suspend role gift grant plan email users password reset delete account' },
      { tab: 'moderation', label: 'Moderation', icon: Flag, perm: 'admin.moderate', count: 'openReports', desc: 'Reports about content on the site', keywords: 'reports abuse content flag hide remove' },
      { to: '/app/admin/training', label: 'Training admin', icon: GraduationCap, perm: 'training.manage', desc: 'Courses, lessons and live training requests', keywords: 'courses lessons trainers course library seat requests' },
    ],
  },
  {
    group: 'Billing',
    items: [
      { tab: 'payments', label: 'Payments to check', icon: Wallet, perm: 'admin.billing', count: 'paymentsToCheck', desc: 'Bank wire, USDT and Taptap Send payments reported by customers', keywords: 'manual payment approve reject bank wire usdt crypto taptap send transfer reference' },
      { tab: 'subscriptions', label: 'Subscriptions', icon: Repeat, perm: 'admin.billing', desc: 'Every subscription and every payment received', keywords: 'subscribers invoices payments history mrr cancel' },
      { tab: 'plans', label: 'Plans & prices', icon: Package, perm: 'admin.billing', desc: 'What each plan costs and includes', keywords: 'price pricing limits features pro annual teams free seats' },
      { tab: 'codes', label: 'Codes & discounts', icon: Ticket, perm: 'admin.billing', desc: 'Discount codes and free-month codes', keywords: 'coupon promo promotion discount voucher free months code' },
    ],
  },
  {
    group: 'Settings',
    items: SETTINGS_PAGES.map((p) => ({
      tab: 'settings', section: p.group, label: p.label, icon: SETTINGS_ICON[p.group] || SlidersHorizontal, perm: 'admin.settings', desc: p.desc,
      keywords: p.sections.map((s) => s.title).join(' '),
    })),
  },
  {
    group: 'System',
    items: [
      { tab: 'system', label: 'Jobs & backups', icon: Server, perm: 'admin.settings', count: 'failedJobs', urgent: true, desc: 'Background jobs and database backups', keywords: 'jobs cron schedule backup restore download database run now' },
      { tab: 'audit', label: 'Audit log', icon: ScrollText, perm: 'admin.audit', desc: 'Who changed what, and when', keywords: 'history log activity changes security' },
    ],
  },
];

/** A stable id for a menu item: "users", "settings:billing". */
export const itemId = (it) => (it.to ? it.to : it.section ? `${it.tab}:${it.section}` : it.tab);

/** The menu limited to what `can` allows, empty groups dropped. */
export function visibleMenu(can) {
  return ADMIN_MENU.map((g) => ({ ...g, items: g.items.filter((it) => can(it.perm)) })).filter((g) => g.items.length);
}

/** The menu item for the current address (?tab=…&section=…); settings without a section open General. */
export function currentItem(menu, tab, section) {
  const items = menu.flatMap((g) => g.items).filter((it) => !it.to);
  if (tab === 'settings') return items.find((it) => it.tab === 'settings' && it.section === (section || 'app')) || items.find((it) => it.tab === 'settings') || items[0];
  return items.find((it) => it.tab === tab) || items[0];
}

const norm = (s) => String(s || '').toLowerCase();

/**
 * Search the admin: pages by name, purpose and keywords, and every setting by its label and explanation.
 * Returns up to `limit` results, best first: [{ kind: 'page' | 'setting', label, sub, item, settingKey? }].
 */
export function searchAdmin(menu, query, limit = 8) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const score = (label, rest) => {
    const l = norm(label);
    const all = `${l} ${norm(rest)}`;
    if (!words.every((w) => all.includes(w))) return 0;
    let s = 1;
    if (l.startsWith(words[0])) s += 4;
    if (words.every((w) => l.includes(w))) s += 2;
    return s;
  };
  const out = [];
  const items = menu.flatMap((g) => g.items.map((it) => ({ ...it, group: g.group })));
  for (const it of items) {
    const s = score(it.label, `${it.group} ${it.desc} ${it.keywords}`);
    if (s) out.push({ kind: 'page', label: it.label, sub: it.desc, item: it, score: s + 1 });
  }
  const settingsItems = items.filter((it) => it.tab === 'settings');
  for (const page of SETTINGS_PAGES) {
    const item = settingsItems.find((it) => it.section === page.group);
    if (!item) continue; // no permission
    for (const section of page.sections) {
      for (const key of section.keys) {
        const label = LABELS[key] || key;
        const s = score(label, `${section.title} ${page.label} ${HINTS[key] || ''} ${key}`);
        if (s) out.push({ kind: 'setting', label, sub: `${page.label} → ${section.title}`, item, settingKey: key, score: s });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
