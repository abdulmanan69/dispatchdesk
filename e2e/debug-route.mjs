// Debug helper: register a throwaway user, open a route, print console/page errors.
// Usage: node debug-route.mjs /app/opportunities
import { chromium } from '@playwright/test';

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const route = process.argv[2] || '/app';
const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
page.on('pageerror', (e) => console.log('pageerror:', e.message, '\n', e.stack?.split('\n').slice(0, 4).join('\n')));
await page.goto(`${BASE}/register`);
await page.getByLabel('Full name').fill('Debug');
await page.getByLabel('Email').fill(`dbg.${Date.now()}@example.test`);
await page.getByLabel('Password').fill('Debug12345');
await page.getByRole('checkbox').check();
await page.getByRole('button', { name: 'Create account' }).click();
await page.waitForURL(/\/app/);
await page.goto(BASE + route, { waitUntil: 'networkidle' });
console.log('title text:', (await page.locator('h1').allTextContents()).join(' | '));
await browser.close();
