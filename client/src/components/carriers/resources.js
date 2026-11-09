/**
 * Public research links for a carrier, built from its USDOT / MC / name / address.
 * URL formats confirmed against archived public pages (FMCSA blocks some regions and automated checks,
 * so a link may show 403 outside the US). Links open in a new tab with rel="noopener noreferrer".
 */
const digits = (v) => String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');

export function carrierResources(c = {}) {
  const dot = digits(c.dotNumber);
  const mc = digits(c.mcNumber);
  const out = [];
  if (dot) {
    out.push({
      key: 'safer', label: 'SAFER', title: 'FMCSA SAFER company snapshot',
      href: `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dot}`,
    });
    out.push({
      key: 'sms', label: 'SMS', title: 'FMCSA Safety Measurement System (inspections, crashes, BASICs)',
      href: `https://ai.fmcsa.dot.gov/SMS/Carrier/${dot}/CarrierRegistration.aspx`,
    });
    out.push({
      key: 'li', label: 'Licensing', title: 'FMCSA licensing and insurance (authority, insurance on file)',
      href: `https://li-public.fmcsa.dot.gov/LIVIEW/pkg_carrquery.prc_carrlist?n_dotno=${dot}`,
    });
  }
  const name = String(c.companyName || '').trim();
  if (name) {
    const q = [name, mc ? `MC ${mc}` : dot ? `USDOT ${dot}` : '', c.state || ''].filter(Boolean).join(' ');
    out.push({ key: 'google', label: 'Google', title: 'Search the web for this company', href: `https://www.google.com/search?q=${encodeURIComponent(q)}` });
  }
  const addr = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
  if (addr && (c.address || c.city)) {
    out.push({ key: 'maps', label: 'Map', title: 'Open the address in Google Maps', href: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addr)}` });
  }
  return out;
}
