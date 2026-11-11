// UI smoke test: every route renders without JS errors, for anonymous, normal and admin users.
// Run: cd e2e && npx playwright test   (BASE_URL defaults to http://localhost:3100)
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const env = Object.fromEntries((fs.existsSync(path.resolve('../.env')) ? fs.readFileSync(path.resolve('../.env'), 'utf8') : '')
  .split(/\r?\n/).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ADMIN = { email: process.env.ADMIN_EMAIL || env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD || env.ADMIN_PASSWORD };

const PUBLIC = ['/', '/features', '/pricing', '/training', '/marketplace', '/community', '/login', '/register', '/forgot-password', '/terms', '/privacy'];
const APP = ['/app', '/app/discover', '/app/carriers', '/app/import', '/app/pipeline', '/app/prospecting', '/app/sequences', '/app/sequences/new',
  '/app/follow-ups', '/app/opportunities', '/app/customers', '/app/brokers', '/app/loads', '/app/loads/calculator', '/app/email', '/app/email?tab=mailboxes',
  '/app/email?tab=templates', '/app/automations', '/app/ai', '/app/ai/knowledge', '/app/training', '/app/training/messages', '/app/marketplace',
  '/app/marketplace/new', '/app/community', '/app/team', '/app/billing', '/app/settings', '/app/notifications',
  '/app/lead-generator', '/app/market', '/app/fleet', '/app/dialer', '/app/call-scripts', '/app/tools', '/app/tools?tool=factoring', '/app/tools?tool=timezones', '/app/extension', '/app/settings?tab=calling',
  '/app/today', '/app/templates', '/app/invoices', '/app/new-authority', '/app/truck-posts', '/app/settings?tab=notifications', '/app/settings?tab=calendar'];
// Pages checked at phone width (375 px) for horizontal overflow.
const MOBILE = ['/', '/app', '/app/carriers', '/app/pipeline', '/app/loads/calculator', '/app/email', '/app/fleet', '/app/loads', '/app/dialer',
  '/app/follow-ups', '/app/discover', '/app/today', '/app/invoices', '/app/templates', '/app/truck-posts'];
const ADMIN_ROUTES = ['/app/admin', '/app/admin/training'];

function watch(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of (4\d\d|503)/.test(m.text())) errors.push(`console: ${m.text()}`); });
  return errors;
}

async function visit(page, errors, route) {
  const res = await page.goto(BASE + route, { waitUntil: 'networkidle' });
  expect(res.status(), route).toBeLessThan(400);
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page.getByText('Something went wrong'), `${route} crashed`).toHaveCount(0);
  await expect(page.getByText('Page not found'), `${route} 404`).toHaveCount(0);
  expect(errors, `JS errors on ${route}`).toEqual([]);
}

async function login(page, email, password) {
  await page.goto(`${BASE}/login`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await page.waitForURL(/\/app/);
}

test('public pages render', async ({ page }) => {
  const errors = watch(page);
  for (const r of PUBLIC) await visit(page, errors, r);
});

test('register through the UI and visit every app page', async ({ page }) => {
  const errors = watch(page);
  await page.goto(`${BASE}/register`);
  await page.getByLabel('Full name').fill('UI Smoke');
  await page.getByLabel('Email').fill(`ui.${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('UiSmoke123');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/app/);
  for (const r of APP) await visit(page, errors, r);
  // non-admins are blocked from admin UI
  await page.goto(`${BASE}/app/admin`);
  await expect(page.getByText('Access denied')).toBeVisible();
});

test('add a carrier through the UI and open its profile', async ({ page }) => {
  const errors = watch(page);
  await page.goto(`${BASE}/register`);
  await page.getByLabel('Full name').fill('UI Carrier');
  await page.getByLabel('Email').fill(`uic.${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('UiSmoke123');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/app/);
  await page.goto(`${BASE}/app/carriers`);
  await page.getByRole('button', { name: /add carrier/i }).first().click();
  await page.getByLabel(/company name/i).fill('Smoke Test Trucking');
  // Themed dropdown: open it, type to filter, pick the option.
  await page.getByRole('dialog').getByRole('combobox', { name: /^state/i }).first().click();
  await page.getByRole('option', { name: 'TX', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: /save|create|add/i }).last().click();
  await expect(page.getByText('Smoke Test Trucking').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('themed controls: no native select or datalist anywhere in the app', async ({ page }) => {
  await page.goto(`${BASE}/register`);
  await page.getByLabel('Full name').fill('UI Controls');
  await page.getByLabel('Email').fill(`uictl.${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('UiSmoke123');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/app/);
  for (const r of ['/app/carriers', '/app/discover', '/app/loads', '/app/email?tab=templates', '/app/settings?tab=calling', '/app/lead-generator',
    '/app/templates', '/app/invoices', '/app/today', '/app/truck-posts', '/app/new-authority']) {
    await page.goto(BASE + r, { waitUntil: 'networkidle' });
    expect(await page.locator('select, datalist').count(), `native dropdown on ${r}`).toBe(0);
  }
});

test('detail pages render with real data (uses e2e/.state.json from workflow.mjs setup)', async ({ page }) => {
  const stateFile = path.resolve('.state.json');
  test.skip(!fs.existsSync(stateFile), 'run `node workflow.mjs setup` first');
  const st = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const errors = watch(page);
  await login(page, st.email, st.password);
  await visit(page, errors, `/app/carriers/${st.carrierId}`);
  for (const tab of await page.getByRole('tablist').first().getByRole('tab').all()) {
    if (!(await tab.isVisible())) continue;
    await tab.click({ timeout: 10000 });
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('Something went wrong')).toHaveCount(0);
  }
  expect(errors, 'carrier tabs').toEqual([]);
  for (const r of [`/app/customers/${st.customerId}`, `/app/brokers/${st.brokerId}`, '/app/loads', '/app/opportunities?status=all', '/app/pipeline', '/app/prospecting', `/app/sequences/${st.sequenceId}`, '/app/team', '/app/email?tab=sent', '/app']) {
    await visit(page, errors, r);
  }
  // open a row-detail modal on the loads and opportunities lists
  await page.goto(`${BASE}/app/opportunities?status=all`, { waitUntil: 'networkidle' });
  await page.getByText('E2E Freight Lines LLC').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // training course + lesson
  await page.goto(`${BASE}/app/training`, { waitUntil: 'networkidle' });
  const course = page.locator('a[href^="/app/training/"]').filter({ hasNotText: /messages/i }).first();
  await course.click();
  await page.waitForLoadState('networkidle');
  const lesson = page.locator('a[href*="/app/training/"][href$=""]').filter({ hasText: /./ }).nth(1);
  if (await lesson.count()) { await lesson.click(); await page.waitForLoadState('networkidle'); }
  await expect(page.getByText('Something went wrong')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('admin pages render for the admin account', async ({ page }) => {
  test.skip(!ADMIN.email, 'ADMIN_EMAIL not set');
  const errors = watch(page);
  await login(page, ADMIN.email, ADMIN.password);
  for (const r of ADMIN_ROUTES) await visit(page, errors, r);
  for (const tab of ['Setup', 'Overview', 'Users', 'Subscriptions', 'Plans', 'Moderation', 'Settings', 'Audit']) {
    const t = page.getByRole('tab', { name: new RegExp(tab, 'i') });
    if (await t.count()) { await t.first().click(); await page.waitForLoadState('networkidle'); }
  }
  expect(errors).toEqual([]);
});

test('mobile viewport: app shell has no horizontal overflow', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 375, height: 800 } });
  const errors = watch(page);
  await page.goto(`${BASE}/register`);
  await page.getByLabel('Full name').fill('Mobile');
  await page.getByLabel('Email').fill(`m.${Date.now()}@example.test`);
  await page.getByLabel('Password').fill('UiSmoke123');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/\/app/);
  for (const r of MOBILE) {
    await page.goto(BASE + r, { waitUntil: 'networkidle' });
    // In the app shell <main> is the scroll container, so wide content overflows inside it, not the document.
    const overflow = await page.evaluate(() => {
      const main = document.querySelector('main');
      const inner = main ? main.scrollWidth - main.clientWidth : 0;
      return Math.max(document.documentElement.scrollWidth - window.innerWidth, inner);
    });
    expect(overflow, `horizontal overflow on ${r}`).toBeLessThanOrEqual(1);
  }
  expect(errors).toEqual([]);
});
