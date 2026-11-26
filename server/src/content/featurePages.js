/**
 * The product areas shown on /features and on one page each at /features/<slug>.
 * One source for the client pages (imported by client/src/pages/public), the server's page titles, descriptions,
 * sitemap, breadcrumbs (BreadcrumbList structured data) and the page text written into the HTML for crawlers.
 * Plain data only: no imports, so the client build can bundle it (the Dockerfile copies this file into the client stage).
 * Describe only what the product does today.
 */
export const FEATURE_PAGES = [
  {
    slug: 'lead-generator', anchor: 'leads', hue: 'blue', label: 'Lead generator',
    title: 'Lead generator and carrier discovery',
    seoTitle: 'Carrier lead generator from FMCSA data',
    description: 'Find new trucking carriers to dispatch in the FMCSA census. Filter by state, fleet size, cargo and authority age; every lead is scored 0 to 100 with reasons.',
    text: 'Search the public FMCSA Company Census by state, city, fleet size, cargo and authority age, or save the search as a generator that adds new leads for you.',
    points: ['Skips carriers already in your CRM', 'Scores each lead 0–100 with the reasons', 'Adds leads to a prospect list and a sequence', 'Scheduled daily or weekly runs on paid plans', 'CSV import and export'],
    steps: [
      'Open Lead generator and click New generator. Start from a playbook, like New MC launch for carriers whose MC is one to four months old.',
      'Pick the states you dispatch in and adjust the filters: fleet size, equipment, cargo and authority age.',
      'Choose where the leads go: a minimum score, a prospect list and a sequence to enroll them in.',
      'Click Preview matches to see who fits, then Create generator and Run now.',
    ],
    details: [
      'Only carriers with active authority and insurance on file pass. If the authority data does not answer, the carrier is not saved.',
      'Carriers that share a phone or email with many others, which usually means they already have a dispatch service, are left out.',
      'Every lead is saved with its score, its tier (A is 75 and up) and each reason, so you know why it is worth a call.',
    ],
    related: ['carrier-check', 'power-dialer', 'sequences'],
  },
  {
    slug: 'carrier-check', anchor: 'check', hue: 'red', label: 'Carrier check',
    title: 'Carrier check',
    seoTitle: 'Carrier check: vet carriers by USDOT or MC',
    description: 'Vet any carrier before you call or book: authority, insurance, safety rating, inspections and identity from FMCSA public records, with one clear verdict.',
    text: 'Type a USDOT or MC number and get five checks from FMCSA public records, the evidence behind each one, and one verdict.',
    points: ['Authority, insurance, safety rating, inspections and identity', 'Out-of-service rates next to the national average', 'Related carriers that share a phone, email or address', 'Bulk check up to 25 numbers at once', 'Save as a lead or open the carrier in your list'],
    steps: [
      'Open Carrier check and type a USDOT or MC number, or use Bulk check for up to 25 numbers.',
      'Read the verdict: no red flags, Review before booking, or Do not book.',
      'Click any check to see its evidence from FMCSA records.',
      'Save the carrier as a lead, or open it in your list. The next step bar says what to do now.',
    ],
    details: [
      'A shared phone, email or street address is shown as a reason to ask, not as proof of anything.',
    ],
    related: ['lead-generator', 'carrier-onboarding', 'pipeline'],
  },
  {
    slug: 'power-dialer', anchor: 'calling', hue: 'green', label: 'Power dialer', visual: 'hero',
    title: 'Prospecting and power dialer',
    seoTitle: 'Power dialer for truck dispatchers',
    description: 'Call carriers through Google Voice, 8x8, RingCentral or your phone app, in each carrier’s local time, and log the outcome with one key. Nothing dials by itself.',
    text: 'A daily call queue ordered by priority and each carrier’s local time. Call with your own phone service and log the outcome with one key.',
    points: ['Google Voice, 8x8, RingCentral, Dialpad, Teams, Zoom Phone, Twilio or your phone app', 'Calling-hours and do-not-call guards', 'Call scripts library', 'Outcome keys 1–8, notes and next follow-up', 'Nothing is ever dialed without your click'],
    steps: [
      'Pick who to work: today’s call queue, a sequence or a prospect list.',
      'Choose how you dial: Google Voice, 8x8, RingCentral or your phone app.',
      'Press Start. Each carrier shows its local time and the step it is on. Press C to call.',
      'Press one key to log the outcome, choose the follow-up date and click Save and next.',
    ],
    details: [
      'Every call starts from your click. DispatchDesk never places a call for you.',
    ],
    related: ['sequences', 'follow-ups', 'chrome-extension'],
  },
  {
    slug: 'sequences', anchor: 'sequences', hue: 'purple', label: 'Sequences', visual: 'sequence',
    title: 'Sequences',
    seoTitle: 'Sequences: call, email and text steps',
    description: 'Call, email, text and task steps for carrier outreach. Emails send from your own mailbox on schedule, in business hours in each carrier’s time zone.',
    text: 'Cadences of call, email, text and task steps. Emails send from your mailbox on schedule; calls and texts wait in your queue.',
    points: ['Business hours and weekends', 'Daily limits and cooldown per sequence', 'Merge fields for carrier and contact details', 'Start a dialer session for a sequence in one click'],
    steps: [
      'Create a sequence and give it a name. It keeps to business hours in each carrier’s time zone and skips weekends.',
      'Add the steps, for example a call on day one, an email the next day, then a text.',
      'Enroll carriers. Each one moves through the steps on its own.',
      'Press Start to work today’s calls in the power dialer, one by one.',
    ],
    details: [
      'Emails go out from your connected mailbox, with merge fields for the company and first name.',
    ],
    related: ['power-dialer', 'email', 'follow-ups'],
  },
  {
    slug: 'follow-ups', anchor: 'followups', hue: 'pink', label: 'Follow-ups',
    title: 'Follow-ups',
    seoTitle: 'Follow-ups for truck dispatchers',
    description: 'Overdue, today and upcoming follow-ups in one workspace, in each carrier’s local time, with repeats, reminders, snooze and one-click call, email or text.',
    text: 'Overdue, today and upcoming in one workspace with live counts, a week view and bulk actions.',
    points: ['Priority, repeat and reminder lead time', 'Snooze to later today, tomorrow or next week', 'Call, email or text from the row', 'Complete with an outcome; repeats schedule themselves'],
    steps: [
      'Open Follow-ups and click New follow-up. Search for the carrier and pick it.',
      'Pick a preset, like In 2 days. It uses the carrier’s local time and shows yours too.',
      'When it is due, it shows under Today. Anything you missed shows under Overdue.',
      'Click Done and pick the outcome. A repeating follow-up schedules the next one for you.',
    ],
    details: [
      'The Today page puts follow-ups beside appointments, check calls and overdue invoices.',
    ],
    related: ['power-dialer', 'sequences', 'pipeline'],
  },
  {
    slug: 'email', anchor: 'email', hue: 'blue', label: 'Email',
    title: 'Email from your own mailbox',
    seoTitle: 'Email carriers from your own mailbox',
    description: 'Send carrier and broker email from your own Google, Microsoft or SMTP mailbox, with templates, merge fields, scheduling, daily limits and unsubscribe links.',
    text: 'Connect Google or Microsoft in one click once your administrator enables it, or any SMTP mailbox with an app password.',
    points: ['Templates, drafts and scheduling', 'Daily limits, cooldown and retries', 'Unsubscribe links and suppression list', 'Passwords and tokens stored encrypted'],
    steps: [
      'Open Email, go to Mailboxes and connect your mailbox. It is checked before it is saved.',
      'Open Templates and click Add starter templates, then make them yours with merge fields.',
      'On a carrier’s page, click Email, insert a template, check it and click Send now.',
      'In Automations, enroll new carriers in your outreach sequence automatically.',
    ],
    details: [
      'Emails go out from your own address, within your mailbox’s and your plan’s daily limits.',
    ],
    related: ['sequences', 'invoices', 'ai-dispatcher'],
  },
  {
    slug: 'pipeline', anchor: 'deals', hue: 'green', label: 'Pipeline',
    title: 'Pipeline, opportunities and customers',
    seoTitle: 'Carrier pipeline and customer CRM',
    description: 'A board from new lead to signed carrier, with fees, lanes, compliance documents and expiry dates, plus CSV import of the carriers you already have.',
    text: 'A board from new lead to signed customer, with trials, fees, lanes, compliance checklists and documents.',
    points: ['Drag and drop or keyboard board', 'Agreement, W-9, COI and permits with expiry dates', 'Brokers, loads and lane history', 'Rate calculator and load-text parser', 'CSV import with duplicate checks'],
    steps: [
      'Import your carriers from a CSV file. Duplicates by USDOT, MC or phone are skipped or updated.',
      'Open Pipeline. Each stage is a column, from new lead to signed customer.',
      'Drag a carrier to the next stage, or pick a stage from the card’s menu.',
      'Keep each customer’s documents, fees and lanes on its page.',
    ],
    details: [],
    related: ['carrier-onboarding', 'lead-generator', 'loads-and-brokers'],
  },
  {
    slug: 'carrier-onboarding', anchor: 'onboarding', hue: 'teal', label: 'Carrier onboarding',
    title: 'Carrier onboarding and carrier portal',
    seoTitle: 'Carrier onboarding with e-signed agreements',
    description: 'Send carriers one link to e-sign your dispatch agreement and upload the W-9, insurance and authority letter, then share weekly statements in a private portal.',
    text: 'A yes on the phone becomes a signed carrier: one link for the agreement and documents, and a private portal for weekly statements.',
    points: ['Your agreement template with your dispatch fee', 'Electronic signature with a full record', 'W-9, insurance certificate and MC authority letter uploads', 'Private carrier portal with weekly statements', 'Send the link by text or copy it'],
    steps: [
      'On the carrier’s page, click Send agreement. Set your dispatch fee and the documents you need.',
      'Create the link and send it as a text message, or copy it.',
      'On their phone, the carrier reads the agreement, signs and uploads the documents.',
      'Back on your desk, the agreement shows as signed, with its full record.',
    ],
    details: [
      'The carrier portal is a private link. The carrier sees its statements and load documents, and nothing else in your workspace.',
    ],
    related: ['pipeline', 'carrier-check', 'invoices'],
  },
  {
    slug: 'loads-and-brokers', anchor: 'loads', hue: 'orange', label: 'Loads and brokers',
    title: 'Loads, brokers and the rate calculator',
    seoTitle: 'Loads, brokers and rate per mile calculator',
    description: 'Paste a load board row to see rate per mile with deadhead, fuel at the EIA price and the carrier’s net, then save the load and track each broker.',
    text: 'See a load’s real margin before you book it, then keep every load and broker in one place.',
    points: ['Fill in a load from pasted text', 'Rate per mile, loaded and all-in with deadhead', 'Fuel at the weekly EIA average', 'Load board from booked to paid', 'Broker FMCSA check, terms and days to pay'],
    steps: [
      'On Loads, open the Rate calculator and paste the load board row.',
      'Check the rate per mile, fuel cost and the carrier’s net after your dispatch fee.',
      'Click Save as load and pick the broker.',
      'Move the load across the board as it is booked, delivered and paid.',
    ],
    details: [
      'Each broker page adds up your loads, revenue and average rate per mile, and how fast they pay your invoices.',
    ],
    related: ['invoices', 'fleet-map', 'dispatch-tools'],
  },
  {
    slug: 'invoices', anchor: 'invoices', hue: 'amber', label: 'Invoices and reports',
    title: 'Invoices and reports',
    seoTitle: 'Invoices and reports for dispatchers',
    description: 'Invoice delivered loads with line haul, detention and broker terms filled in, email them, record payments, and see profit by carrier, broker and lane.',
    text: 'Invoice every load, track payments, and see what your loads earn.',
    points: ['Invoice drafts filled in from the load', 'Email invoices from your connected mailbox', 'Record payments; paid in full marks the load paid', 'Gross, dispatch fees and estimated profit', 'How fast each broker pays, from your own invoices'],
    steps: [
      'Open Invoices, click New invoice and create a draft for a delivered load.',
      'Line haul, detention, the broker’s terms and the remit-to fill in from the load.',
      'Click Email invoice to send it, then Record payment when the broker pays.',
      'Open Reports to compare months, carriers, brokers and lanes.',
    ],
    details: [],
    related: ['loads-and-brokers', 'carrier-onboarding', 'email'],
  },
  {
    slug: 'fleet-map', anchor: 'fleet', hue: 'amber', label: 'Fleet map', visual: 'fleet',
    title: 'Fleet map and trip planning',
    seoTitle: 'Fleet map and driver live location links',
    description: 'Your carriers’ trucks on a live map. Plan the next trip with road miles, fuel and weather, and share a PIN-protected live location link with the driver.',
    text: 'Your carriers’ trucks on a live street map. Plan the next trip with road miles, rate per mile, fuel and weather.',
    points: ['Truck status, location and available time', 'Road routes with deadhead and loaded miles', 'Find the closest available truck for a load', 'Week board of every carrier’s trips', 'Driver live-location links with a PIN'],
    steps: [
      'Open the fleet map to see every truck’s status, location and trip.',
      'Click a truck to see its route, the miles to go and the delivery time.',
      'Share a live-location link with the driver and keep Require a PIN switched on.',
      'The driver enters the PIN and taps Start sharing. From then on the link works only on that phone.',
    ],
    details: [
      'Location is shared only with the driver’s consent, and the driver can stop at any time.',
    ],
    related: ['market-map', 'loads-and-brokers', 'dispatch-tools'],
  },
  {
    slug: 'market-map', anchor: 'market', hue: 'teal', label: 'Market map', visual: 'map',
    title: 'Market map and data',
    seoTitle: 'Market map: diesel prices and time zones',
    description: 'The US by time zone, active carriers per state from the FMCSA census, EIA weekly diesel and gasoline by region, weather alerts and a trip fuel planner.',
    text: 'The US by time zone, active carriers per state, diesel and gasoline by region, weather alerts and freight holidays.',
    points: ['FMCSA carrier counts per state', 'EIA weekly diesel and gasoline', 'National Weather Service alerts', 'Trip fuel calculator with your own spot rates'],
    steps: [
      'Open Market to see the US diesel average and the price in each region.',
      'Color the map by time zone, or by active carriers per state.',
      'Click a state for its local time, carriers and diesel price, or find carriers there.',
      'In the trip fuel planner, pick an origin and a destination and type your rate per mile.',
    ],
    details: [],
    related: ['fleet-map', 'lead-generator', 'dispatch-tools'],
  },
  {
    slug: 'chrome-extension', anchor: 'extension', hue: 'orange', label: 'Chrome extension', visual: 'extension',
    title: 'Chrome extension',
    seoTitle: 'Chrome extension for truck dispatchers',
    description: 'Call a carrier or add it to your CRM from SAFER, a load board or any page, and work the power dialer and Google Voice side by side.',
    text: 'A workspace that places the dialer and Google Voice side by side, and a side panel for the call in progress.',
    points: ['Calls load into your open Google Voice tab', 'Disposition, notes, follow-up and template email', 'Look up and add carriers from any page', 'Personal access token; no access to admin or billing'],
    steps: [
      'In DispatchDesk, open Browser extension and download it, then load it in Chrome.',
      'Create a token, paste it into the extension’s settings and click Save and test.',
      'On any carrier page, click the toolbar button to see every phone, USDOT and MC number on it.',
      'Press Alt+Shift+D for the workspace: the power dialer and Google Voice side by side.',
    ],
    details: [
      'It reads a page only when you click it, and a call starts only when you click Call.',
    ],
    related: ['power-dialer', 'lead-generator', 'carrier-check'],
  },
  {
    slug: 'ai-dispatcher', anchor: 'ai', hue: 'purple', label: 'AI dispatcher',
    title: 'AI dispatcher',
    seoTitle: 'AI dispatcher that cites your documents',
    description: 'Ask dispatch questions and draft broker emails, call scripts and objection replies from your own training documents, with sources. It never invents rates.',
    text: 'Answers dispatch questions and drafts emails and scripts using your own training documents and optional web search.',
    points: ['Objection replies and broker emails', 'Cites the documents it used', 'Says so when it is not configured', 'Never invents rates', 'Use your own AI provider key'],
    steps: [
      'Open AI dispatcher. If AI is off, add your own provider key and click Test.',
      'Upload a PDF, text, Markdown or CSV file to the knowledge base.',
      'Ask a question. The answer cites your document as a numbered source.',
      'Use the Email drafts, Call scripts, Objections and Load analysis tabs.',
    ],
    details: [],
    related: ['email', 'power-dialer', 'teams'],
  },
  {
    slug: 'teams', anchor: 'teams', hue: 'green', label: 'Teams',
    title: 'Teams',
    seoTitle: 'Dispatch team CRM with sales and dispatch roles',
    description: 'Sales signs carriers, the manager hands them to dispatchers, and every carrier, call and file stays in the team CRM, with roles and a manager overview.',
    text: 'Sales signs carriers, the manager hands them to dispatchers, and every carrier, call and file stays in the team CRM.',
    points: ['Manager, sales and dispatcher roles', 'Signed carriers handed to dispatch', 'Work areas the manager turns on per member', 'Work stays with the team when someone leaves', 'Manager overview and leaderboard'],
    steps: [
      'Open Team, name your team and invite members by email.',
      'Choose each member’s role and the work areas they see.',
      'Sales signs a carrier; the manager hands it to a dispatcher.',
      'Follow the work in the manager overview and leaderboard.',
    ],
    details: [],
    related: ['pipeline', 'power-dialer', 'carrier-onboarding'],
  },
  {
    slug: 'dispatch-tools', anchor: 'tools', hue: 'amber', label: 'Dispatch tools',
    title: 'Dispatch tools',
    seoTitle: 'Dispatch tools: rate, factoring and detention',
    description: 'Calculators and lookups dispatchers reach for between calls: rate per mile and profit, factoring fees, detention, time zones and calling hours.',
    text: 'Calculators and lookups that dispatchers reach for between calls.',
    points: ['Rate per mile and profit', 'Factoring fees and detention', 'Time zones and calling hours', 'Command palette with Ctrl+K'],
    steps: [],
    details: [],
    related: ['loads-and-brokers', 'market-map', 'invoices'],
  },
];

export const FEATURE_BY_SLUG = Object.fromEntries(FEATURE_PAGES.map((f) => [f.slug, f]));

const PAGE_NAMES = {
  '/features': 'Features', '/pricing': 'Pricing', '/training': 'Training', '/marketplace': 'Marketplace', '/community': 'Community',
  '/terms': 'Terms of service', '/privacy': 'Privacy policy', '/refunds': 'Refund policy',
};

/**
 * Breadcrumb trail for a public page, or null when the page has none (home, app, private links).
 * [{ name, path }], first is Home, last is the page itself.
 */
export function breadcrumbsFor(pathname) {
  const p = pathname.replace(/\/+$/, '') || '/';
  const home = { name: 'Home', path: '/' };
  const m = /^\/features\/([a-z0-9-]+)$/.exec(p);
  if (m) {
    const f = FEATURE_BY_SLUG[m[1]];
    return f ? [home, { name: 'Features', path: '/features' }, { name: f.label, path: p }] : null;
  }
  return PAGE_NAMES[p] ? [home, { name: PAGE_NAMES[p], path: p }] : null;
}
