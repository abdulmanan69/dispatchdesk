export const STAGES = [
  // Distinct hue per stage so the pipeline reads at a glance (matches the client categorical palette).
  { key: 'lead', name: 'All Leads', color: '#3b82f6' },
  { key: 'prospecting', name: 'Prospecting', color: '#8b5cf6' },
  { key: 'sequence', name: 'Sequence', color: '#ec4899' },
  { key: 'opportunity', name: 'Opportunities', color: '#f59e0b' },
  { key: 'trial', name: 'Trials', color: '#14b8a6' },
  { key: 'customer', name: 'Customers', color: '#16a34a' },
  { key: 'archived', name: 'Archived', color: '#9ca3af' },
];
export const STAGE_KEYS = STAGES.map((s) => s.key);

// Order matters: the power dialer maps keys 1-9 and 0 to these in order.
// wrong_number: the number does not reach this carrier (no automatic follow-up).
// do_not_call: the carrier asked not to be called again (turns on do-not-call).
export const CALL_OUTCOMES = [
  'no_answer', 'busy', 'voicemail', 'interested', 'not_interested', 'call_back', 'follow_up', 'converted', 'wrong_number', 'do_not_call',
];

export const EQUIPMENT = [
  'dry_van', 'reefer', 'flatbed', 'step_deck', 'power_only', 'hotshot', 'box_truck', 'tanker', 'car_hauler', 'conestoga', 'lowboy', 'other',
];

export const AUTHORITY_STATUSES = ['active', 'inactive', 'pending', 'unknown'];
// lumper_receipt, scale_ticket and fuel_receipt arrive from the driver link (routes/track.js) and from uploads.
export const DOCUMENT_TYPES = ['agreement', 'mc_authority', 'w9', 'coi', 'permit', 'rate_confirmation', 'bol', 'pod', 'lumper_receipt', 'scale_ticket', 'fuel_receipt', 'other'];
export const LOAD_STATUSES = ['planned', 'booked', 'in_transit', 'delivered', 'invoiced', 'paid', 'canceled'];
export const OPPORTUNITY_STATUSES = ['open', 'negotiating', 'trial', 'won', 'lost'];
export const CUSTOMER_STATUSES = ['active', 'paused', 'churned'];
export const MARKET_CATEGORIES = ['dispatch_tools', 'training', 'software', 'services', 'hiring', 'employment', 'consulting'];
export const COMMUNITY_CATEGORIES = ['general', 'prospecting', 'brokers', 'loads', 'compliance', 'tools', 'wins'];
export const TRAINING_CATEGORIES = ['fundamentals', 'sales', 'operations', 'compliance', 'tools', 'business'];
export const TEAM_ROLES = ['owner', 'manager', 'dispatcher'];
export const EMAIL_PROVIDERS = ['smtp', 'hostinger', 'gmail', 'outlook'];

export const ROLES = [
  { key: 'super_admin', name: 'Super Admin', rank: 100, description: 'Full platform control including admin role assignment and secrets.' },
  { key: 'admin', name: 'Admin', rank: 80, description: 'Platform administration, moderation, training and settings.' },
  { key: 'team_manager', name: 'Team Manager', rank: 50, description: 'Creates and manages teams and team reporting.' },
  { key: 'dispatcher', name: 'Dispatcher', rank: 30, description: 'Full CRM, outreach, automations and AI.' },
  { key: 'user', name: 'Standard User', rank: 10, description: 'CRM, training, community and marketplace.' },
];

export const PERMISSIONS = {
  'crm.use': 'Use carrier CRM, pipeline, prospecting, brokers and loads',
  'email.use': 'Connect mailboxes and send email',
  'ai.use': 'Use the AI dispatcher',
  'automation.use': 'Create sequences and automations',
  'community.post': 'Post in the community',
  'marketplace.post': 'Create marketplace listings',
  'team.create': 'Create and own a team',
  'team.reports': 'View team reports',
  'training.manage': 'Manage training courses and trainer inbox',
  'admin.access': 'Open the admin panel',
  'admin.users': 'Manage users',
  'admin.moderate': 'Moderate marketplace and community',
  'admin.billing': 'View subscriptions and revenue',
  'admin.settings': 'Change system settings and integrations',
  'admin.audit': 'Read audit logs',
  'admin.roles': 'Assign admin-level roles',
};

const BASE = ['crm.use', 'email.use', 'ai.use', 'community.post', 'marketplace.post'];
const DISPATCH = [...BASE, 'automation.use', 'team.create'];
const MANAGER = [...DISPATCH, 'team.reports'];
const ADMIN = [...MANAGER, 'training.manage', 'admin.access', 'admin.users', 'admin.moderate', 'admin.billing', 'admin.settings', 'admin.audit'];

export const ROLE_PERMISSIONS = {
  user: BASE,
  dispatcher: DISPATCH,
  team_manager: MANAGER,
  admin: ADMIN,
  super_admin: [...ADMIN, 'admin.roles'],
};
