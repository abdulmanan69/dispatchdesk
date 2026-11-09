// Screenshot key screens for design review. Usage: node shots.mjs <outDir> [light|dark]
import { chromium } from '@playwright/test';
import fs from 'node:fs';

const BASE = process.env.BASE_URL || 'http://localhost:3100';
const out = process.argv[2] || 'shots';
const scheme = process.argv[3] || 'light';
fs.mkdirSync(out, { recursive: true });
const st = JSON.parse(fs.readFileSync('.state.json', 'utf8'));
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme });
const page = await ctx.newPage();
await page.addInitScript((t) => { try { localStorage.setItem('dd_theme', t); } catch {} }, scheme);

for (const [name, path] of [['home', '/'], ['pricing', '/pricing'], ['login', '/login']]) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: name === 'home' });
}
await page.goto(`${BASE}/login`);
await page.getByLabel('Email').fill(st.email);
await page.getByLabel('Password').fill(st.password);
await page.getByRole('button', { name: 'Log in' }).click();
await page.waitForURL(/\/app/);
await page.evaluate(async (t) => {
  const c = document.cookie.match(/dd_csrf=([^;]+)/)[1];
  await fetch('/api/profile', { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-csrf-token': decodeURIComponent(c) }, body: JSON.stringify({ theme: t }) });
}, scheme);
for (const [name, path] of [['dashboard', '/app'], ['carriers', '/app/carriers'], ['carrier', `/app/carriers/${st.carrierId}`], ['pipeline', '/app/pipeline'], ['prospecting', '/app/prospecting'], ['loads-calc', '/app/loads/calculator'], ['email', '/app/email'], ['ai', '/app/ai']]) {
  await page.goto(BASE + path, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png` });
}
await browser.close();
console.log('ok');
