/**
 * Guided tour definitions (driver.js). Each step's `el` returns an element or null; steps whose element is
 * missing or hidden are dropped when the tour starts, and steps without `el` show as a centered popover.
 * Targets use data-tour attributes in the app shell and visible text/labels on pages, so pages need no tour code.
 */

const visible = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

/** First visible element matching a CSS selector. */
export const q = (selector) => () => [...document.querySelectorAll(selector)].find(visible) || null;

/** First visible element matching `selector` whose text matches `re`; `up` climbs to an ancestor selector. */
export const byText = (selector, re, up) => () => {
  const hit = [...document.querySelectorAll(selector)].find((el) => visible(el) && re.test((el.textContent || '').trim()));
  if (!hit) return null;
  return up ? hit.closest(up) || hit : hit;
};

/** The card (section) whose header title matches `re`. */
export const card = (re) => byText('section h2, section h3', re, 'section');

/** The first of several finders that resolves. */
export const any = (...finders) => () => {
  for (const f of finders) { const el = f(); if (el) return el; }
  return null;
};

export const TOURS = {
  welcome: {
    title: 'Welcome',
    steps: [
      { title: 'Welcome to DispatchDesk', body: 'A quick look around. It takes about a minute, and you can skip it or restart it later from your account menu.' },
      { el: q('[data-tour="nav-group-leads"]'), title: 'Leads', body: 'Find carriers. Generate fresh leads from the FMCSA census, search by state and fleet size, and import CSV files.', side: 'right' },
      { el: q('[data-tour="nav-group-sales"]'), title: 'Sales', body: 'Work your pipeline: the call queue, the power dialer, call scripts, sequences and follow-ups.', side: 'right' },
      { el: q('[data-tour="nav-group-dispatch"]'), title: 'Dispatch', body: 'Once a carrier signs, manage brokers, loads and the fleet map where you plan each truck\'s next trip.', side: 'right' },
      { el: q('[data-tour="nav-group-outreach"]'), title: 'Outreach', body: 'Email from your own mailbox, automations and the AI dispatcher.', side: 'right' },
      { el: q('[data-tour="search"]'), title: 'Search', body: 'Find any carrier by name, MC, USDOT or phone number.', side: 'bottom' },
      { el: q('[data-tour="palette"]'), title: 'Jump anywhere', body: 'Press Ctrl+K to open any page or action by typing.', side: 'bottom' },
      { el: q('[data-tour="notifications"]'), title: 'Notifications', body: 'Follow-up reminders, scheduled lead runs and team activity show up here.', side: 'bottom' },
      { el: q('[data-tour="clocks"]'), title: 'Who you can call now', body: 'Local time in each US time zone. A colored dot means it is business hours there.', side: 'right' },
      { el: q('[data-tour="dock"]'), title: 'AI and map', body: 'Ask the AI dispatcher, or open the market map with time zones, diesel prices and a trip fuel calculator.', side: 'top' },
      { el: any(q('[data-tour="nav-lead-generator"]'), q('[data-tour="nav-discover"]')), title: 'Start here', body: 'Find your first carriers. The lead generator adds fresh, scored carriers to your pipeline and call queue.', side: 'right' },
      { el: q('[data-tour="user-menu"]'), title: 'Choose how you call', body: 'Open Settings → Calling to pick Google Voice, 8x8, RingCentral or another provider. Nothing is ever dialed without your click.', side: 'bottom' },
    ],
  },
  'lead-generator': {
    title: 'Lead generator',
    steps: [
      { el: byText('button', /^New generator$/), title: 'Create a generator', body: 'Save the states, fleet size, authority age and cargo you want. Each run pulls matching carriers from the FMCSA census.', side: 'bottom' },
      { el: byText('section span, section div', /^Leads generated this month$/, 'section'), title: 'Your plan', body: 'How many leads your plan allows this month, and how many generators you can keep.', side: 'bottom' },
      { el: byText('button', /^Run now$/), title: 'Run it', body: 'Adds new carriers only. Anyone already in your CRM is skipped, and every lead gets a score with the reasons.', side: 'top' },
      { el: card(/^Run history$/), title: 'Run history', body: 'What each run scanned, added and skipped.', side: 'top' },
    ],
  },
  dialer: {
    title: 'Power dialer',
    steps: [
      { el: any(byText('div, p, span, label', /^Dial with$/, 'section'), card(/^Session$/)), title: 'Dial with', body: 'Pick the phone service you already use, such as Google Voice or 8x8. Your choice is saved.', side: 'bottom' },
      { el: card(/^Who to work$/), title: 'Who to call', body: 'Your call queue, a prospect list or a sequence. Each carrier\'s local time and calling window are shown.', side: 'right' },
      { el: byText('button', /^Start$/), title: 'Start the session', body: 'Click Call to open your phone service with the number filled in. Then log the outcome with keys 1 to 8, and the next carrier loads.', side: 'top' },
      { body: 'In a sequence, email steps open a ready-to-send email from your mailbox, and text steps open Google Voice with the message copied. Skip either one in a click.', title: 'Email and text steps' },
      { el: byText('a, button', /^Chrome extension$/), title: 'Chrome extension', body: 'Call from any website, and keep the dialer and Google Voice side by side.', side: 'bottom' },
    ],
  },
  fleet: {
    title: 'Fleet map',
    steps: [
      { el: byText('button', /^Available\b/, 'div'), title: 'Truck status', body: 'Counts by status. Click one to filter the map and the list.', side: 'bottom' },
      { el: q('input[aria-label="Search trucks"]'), title: 'Your trucks', body: 'Every carrier with a status or location. Click a truck to focus it on the map.', side: 'right' },
      { el: byText('button', /^Fit all$/, 'div'), title: 'Map layers', body: 'Show or hide trucks, planned trips, open loads and weather alerts.', side: 'bottom' },
      { el: byText('button', /^Plan a trip$/), title: 'Plan the next trip', body: 'Road route, empty and loaded miles, rate per mile, fuel cost and weather at both ends.', side: 'bottom' },
      { el: byText('button', /^Find trucks near$/), title: 'Find trucks near a load', body: 'Ranks your trucks by readiness and distance to a pickup city.', side: 'bottom' },
      { el: byText('button, a', /live location/i), title: 'Live location', body: 'Send a driver a link. When they choose to share, the truck moves on your map while the page is open on their phone.', side: 'bottom' },
    ],
  },
  email: {
    title: 'Email',
    steps: [
      { el: byText('button', /^Connect mailbox$/), title: 'Connect your mailbox', body: 'Continue with Google or Microsoft, or use an app password for Yahoo, Zoho, iCloud and others. Emails go out from your own address.', side: 'bottom' },
      { el: byText('[role="tab"]', /^Templates/), title: 'Templates', body: 'Reusable emails with merge fields like the carrier name and MC number.', side: 'bottom' },
      { el: q('[data-tour="nav-sequences"]'), title: 'Sequences', body: 'Combine call, email and text steps over several days.', side: 'right' },
    ],
  },
  'follow-ups': {
    title: 'Follow-ups',
    steps: [
      { el: byText('[role="tab"]', /^Overdue/, '[role="tablist"]'), title: 'What is due', body: 'Overdue, today, upcoming and done, with live counts.', side: 'bottom' },
      { el: byText('button', /^New follow-up$/), title: 'Quick add', body: 'Pick a carrier, when, priority and whether it repeats. Press N to open it from anywhere on this page.', side: 'bottom' },
      { el: q('input[aria-label="Search follow-ups"]'), title: 'Search and filter', body: 'Press / to search by carrier, title or note.', side: 'bottom' },
      { body: 'Each row has Call, Email, Text, Done and Snooze. Tick several rows to complete, snooze or reschedule them together.', title: 'Act from the list' },
    ],
  },
  'admin-setup': {
    title: 'Admin setup',
    admin: true,
    steps: [
      { el: any(card(/^Setup checklist$/), byText('h2', /^Setup checklist$/)), title: 'Setup checklist', body: 'What is done and what is left: platform email, payments, sign-in with Google or Microsoft, and data sources.', side: 'bottom' },
      { el: byText('button', /^Create products, prices and webhook$/), title: 'Payments in one click', body: 'After you save a Stripe key, this creates the plan prices and the webhook for you.', side: 'top' },
      { el: byText('button, a', /^Open settings$/), title: 'Settings', body: 'Keys and passwords are saved encrypted. Use Test to check each one.', side: 'top' },
    ],
  },
};

/** Which tour belongs to the current page, if any. */
export function tourForPath(pathname, search, user) {
  if (pathname === '/app' || pathname === '/app/') return 'welcome';
  if (pathname.startsWith('/app/lead-generator')) return 'lead-generator';
  if (pathname.startsWith('/app/dialer')) return 'dialer';
  if (pathname.startsWith('/app/fleet')) return 'fleet';
  if (pathname === '/app/email') return 'email';
  if (pathname.startsWith('/app/follow-ups')) return 'follow-ups';
  if (pathname.startsWith('/app/admin') && user?.permissions?.includes('admin.settings')) {
    const tab = new URLSearchParams(search).get('tab');
    if (!tab || tab === 'setup') return 'admin-setup';
  }
  return null;
}
