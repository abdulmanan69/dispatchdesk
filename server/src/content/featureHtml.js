import { FEATURE_PAGES, FEATURE_BY_SLUG, breadcrumbsFor } from './featurePages.js';

/**
 * Text of /features and /features/<slug> written into the HTML for crawlers that do not run JavaScript.
 * React replaces it with the full page when the app starts.
 */
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function crumbsHtml(pathname, appUrl) {
  const crumbs = breadcrumbsFor(pathname) || [];
  const items = crumbs.map((c, i) => (i === crumbs.length - 1
    ? `<li aria-current="page">${esc(c.name)}</li>`
    : `<li><a href="${esc(appUrl)}${c.path === '/' ? '/' : esc(c.path)}">${esc(c.name)}</a></li>`));
  return `<nav aria-label="Breadcrumb"><ol>${items.join('')}</ol></nav>`;
}

export function featuresHtml({ appName = 'DispatchDesk', appUrl = '' } = {}) {
  const n = esc(appName);
  const list = FEATURE_PAGES.map((f) => `<li><a href="${esc(appUrl)}/features/${f.slug}">${esc(f.title)}</a>: ${esc(f.text)}</li>`).join('\n');
  return `<main class="mx-auto max-w-3xl px-4 py-14" data-ssr="features">
${crumbsHtml('/features', appUrl)}
<h1>${n} features for truck dispatchers</h1>
<p>Everything a dispatcher needs in one desk, from the first carrier lead to the truck’s next load.</p>
<ul>
${list}
</ul>
<p>14-day free trial, no card needed. <a href="${esc(appUrl)}/register">Create an account</a> · <a href="${esc(appUrl)}/pricing">Pricing</a></p>
</main>`;
}

export function featurePageHtml(slug, { appName = 'DispatchDesk', appUrl = '' } = {}) {
  const f = FEATURE_BY_SLUG[slug];
  if (!f) return null;
  const n = esc(appName);
  const li = (arr) => arr.map((x) => `<li>${esc(x)}</li>`).join('');
  const related = f.related.map((r) => FEATURE_BY_SLUG[r]).filter(Boolean)
    .map((r) => `<li><a href="${esc(appUrl)}/features/${r.slug}">${esc(r.title)}</a></li>`).join('');
  return `<main class="mx-auto max-w-3xl px-4 py-14" data-ssr="feature">
${crumbsHtml(`/features/${slug}`, appUrl)}
<h1>${esc(f.title)}</h1>
<p>${esc(f.text)}</p>
<ul>${li(f.points)}</ul>
${f.steps.length ? `<h2>How it works</h2>\n<ol>${li(f.steps)}</ol>` : ''}
${f.details.map((d) => `<p>${esc(d)}</p>`).join('\n')}
<h2>Related features</h2>
<ul>${related}</ul>
<p>Try ${n} free for 14 days, no card needed. <a href="${esc(appUrl)}/register">Create an account</a> · <a href="${esc(appUrl)}/features">All features</a></p>
</main>`;
}
