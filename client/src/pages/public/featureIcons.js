import {
  Crosshair, ShieldCheck, PhoneOutgoing, ListOrdered, CalendarClock, Mail, Handshake, FileSignature, Truck, Receipt,
  MapPinned, Map as MapIcon, Puzzle, Bot, Users, Calculator,
} from 'lucide-react';
import { FEATURE_PAGES, FEATURE_BY_SLUG, breadcrumbsFor } from '../../../../server/src/content/featurePages.js';

/** Product areas (server/src/content/featurePages.js is the one source for their text) with the icon each one uses. */
const ICONS = {
  'lead-generator': Crosshair, 'carrier-check': ShieldCheck, 'power-dialer': PhoneOutgoing, sequences: ListOrdered, 'follow-ups': CalendarClock,
  email: Mail, pipeline: Handshake, 'carrier-onboarding': FileSignature, 'loads-and-brokers': Truck, invoices: Receipt,
  'fleet-map': MapPinned, 'market-map': MapIcon, 'chrome-extension': Puzzle, 'ai-dispatcher': Bot, teams: Users, 'dispatch-tools': Calculator,
};

export const AREAS = FEATURE_PAGES.map((f) => ({ ...f, icon: ICONS[f.slug] || Crosshair }));
export const areaBySlug = (slug) => (FEATURE_BY_SLUG[slug] ? { ...FEATURE_BY_SLUG[slug], icon: ICONS[slug] || Crosshair } : null);
export { breadcrumbsFor };
