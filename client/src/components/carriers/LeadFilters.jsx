import { useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
import { Button, Checkbox, ComboInput, Field, Input, Select, cx } from '../ui.jsx';

/**
 * Lead filters shared by the lead generator and Find carriers (server: services/carriers/leadFilters.js), so the two
 * screens never drift apart. Form state is LEAD_FILTER_DEFAULTS-shaped (text for numbers and lists); the helpers turn
 * it into generator criteria (JSON) or Find-carriers query parameters.
 */

export const EQUIPMENT_OPTIONS = Object.freeze([
  { value: 'dry_van', label: 'Dry van' }, { value: 'reefer', label: 'Reefer' }, { value: 'flatbed', label: 'Flatbed' },
  { value: 'car_hauler', label: 'Car hauler' }, { value: 'tanker', label: 'Tanker' }, { value: 'hotshot', label: 'Hotshot' }, { value: 'box_truck', label: 'Box truck' },
]);

export const LEAD_FILTER_DEFAULTS = Object.freeze({
  zipPrefixes: '', counties: '',
  interstateOnly: false, forHireOnly: false, hazmat: 'any',
  minDrivers: '', maxDrivers: '', minCdlDrivers: '', maxMilesPerTruck: '', equipment: [],
  mcAgeMinDays: '', mcAgeMaxDays: '', mcs150WithinMonths: '', excludeRatings: ['U'],
  requireCell: false, requireCellOrEmail: false, excludeSharedContacts: true, excludeEmail: 'none',
  insurers: [], insurerMode: 'include',
});

const NUMBER_KEYS = ['minDrivers', 'maxDrivers', 'minCdlDrivers', 'maxMilesPerTruck', 'mcAgeMinDays', 'mcAgeMaxDays', 'mcs150WithinMonths'];
const BOOL_KEYS = ['interstateOnly', 'forHireOnly', 'requireCell', 'requireCellOrEmail', 'excludeSharedContacts'];
const text = (v) => (v == null ? '' : String(v));
const listText = (v) => (Array.isArray(v) ? v.join(', ') : text(v));
const splitList = (v) => String(v || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
const intOrNull = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));

/** Form state from stored criteria (a generator) or any object with the filter keys; missing keys get the defaults. */
export function leadFiltersFromCriteria(c = {}) {
  const out = { ...LEAD_FILTER_DEFAULTS, equipment: [], insurers: [], excludeRatings: [...LEAD_FILTER_DEFAULTS.excludeRatings] };
  if (!c) return out;
  if (c.zipPrefixes != null) out.zipPrefixes = listText(c.zipPrefixes);
  if (c.counties != null) out.counties = listText(c.counties);
  for (const k of NUMBER_KEYS) if (c[k] != null) out[k] = text(c[k]);
  for (const k of BOOL_KEYS) if (c[k] != null) out[k] = !!c[k];
  if (['any', 'yes', 'no'].includes(c.hazmat)) out.hazmat = c.hazmat;
  if (['none', 'free', 'corporate'].includes(c.excludeEmail)) out.excludeEmail = c.excludeEmail;
  if (['include', 'exclude'].includes(c.insurerMode)) out.insurerMode = c.insurerMode;
  if (Array.isArray(c.excludeRatings)) out.excludeRatings = c.excludeRatings.filter((x) => x === 'U' || x === 'C');
  if (Array.isArray(c.equipment)) out.equipment = [...c.equipment];
  if (Array.isArray(c.insurers)) out.insurers = [...c.insurers];
  return out;
}

/** Generator criteria (JSON body) for the shared filters. */
export function leadFiltersToCriteria(f = LEAD_FILTER_DEFAULTS) {
  return {
    zipPrefixes: splitList(f.zipPrefixes),
    counties: splitList(f.counties),
    interstateOnly: !!f.interstateOnly,
    forHireOnly: !!f.forHireOnly,
    hazmat: f.hazmat || 'any',
    ...Object.fromEntries(NUMBER_KEYS.map((k) => [k, intOrNull(f[k])])),
    excludeRatings: [...(f.excludeRatings || [])].sort(),
    requireCell: !!f.requireCell,
    requireCellOrEmail: !!f.requireCellOrEmail,
    excludeSharedContacts: f.excludeSharedContacts !== false,
    excludeEmail: f.excludeEmail || 'none',
    equipment: [...(f.equipment || [])],
    insurers: [...(f.insurers || [])],
    insurerMode: f.insurerMode || 'include',
  };
}

/**
 * Find-carriers query parameters: only what differs from the server defaults (short URLs, stable cache keys). Lists
 * are comma separated; an empty rating list is sent as 'none' (a query string cannot send an empty list).
 */
export function leadFiltersToQuery(f = LEAD_FILTER_DEFAULTS) {
  const c = leadFiltersToCriteria(f);
  const q = {};
  if (c.zipPrefixes.length) q.zipPrefixes = c.zipPrefixes.join(',');
  if (c.counties.length) q.counties = c.counties.join(',');
  for (const k of ['interstateOnly', 'forHireOnly', 'requireCell', 'requireCellOrEmail']) if (c[k]) q[k] = 'true';
  if (!c.excludeSharedContacts) q.excludeSharedContacts = 'false';
  if (c.hazmat !== 'any') q.hazmat = c.hazmat;
  for (const k of NUMBER_KEYS) if (c[k] != null) q[k] = String(c[k]);
  const ratings = c.excludeRatings.join(',');
  if (ratings !== 'U') q.excludeRatings = ratings || 'none';
  if (c.excludeEmail !== 'none') q.excludeEmail = c.excludeEmail;
  if (c.equipment.length) q.equipment = c.equipment.join(',');
  if (c.insurers.length) {
    q.insurers = c.insurers.join(',');
    if (c.insurerMode !== 'include') q.insurerMode = c.insurerMode;
  }
  return q;
}

/** Filters in each group that differ from the defaults (the group header shows the count). */
const GROUP_KEYS = {
  location: ['zipPrefixes', 'counties'],
  operation: ['interstateOnly', 'forHireOnly', 'hazmat'],
  size: ['minDrivers', 'maxDrivers', 'minCdlDrivers', 'maxMilesPerTruck', 'equipment'],
  safety: ['mcAgeMinDays', 'mcAgeMaxDays', 'mcs150WithinMonths', 'excludeRatings'],
  contact: ['requireCell', 'requireCellOrEmail', 'excludeSharedContacts', 'excludeEmail'],
  insurer: ['insurers'],
};
const changed = (f, k) => JSON.stringify(f[k]) !== JSON.stringify(LEAD_FILTER_DEFAULTS[k]);
export const activeLeadFilters = (f, group) => (group ? GROUP_KEYS[group] : Object.values(GROUP_KEYS).flat()).filter((k) => changed(f, k)).length;

function Group({ id, title, hint, active, children, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen || active > 0);
  return (
    <section className="rounded-lg border border-line">
      <h3>
        <button type="button" aria-expanded={open} aria-controls={`${id}-body`} onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] font-medium hover:bg-surface-2">
          <span>{title}{active > 0 && <span className="ml-1.5 font-normal text-muted">({active} on)</span>}</span>
          <ChevronDown className={cx('size-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
      </h3>
      {open && (
        <div id={`${id}-body`} className="space-y-3 border-t border-line px-3 py-3">
          {hint && <p className="text-xs text-muted">{hint}</p>}
          {children}
        </div>
      )}
    </section>
  );
}

function Chip({ on, children, ...props }) {
  return (
    <button type="button" aria-pressed={on} {...props}
      className={cx('rounded-md border px-2 py-1 text-xs transition-ui', on ? 'border-brand-600 bg-brand-600 text-white' : 'border-line bg-surface text-fg-2 hover:bg-surface-2')}>
      {children}
    </button>
  );
}

/** Equipment chips (also used by the playbook picker). */
export function EquipmentChips({ value = [], onChange, options }) {
  const toggle = (v) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label="Equipment">
      {(options?.length ? options : EQUIPMENT_OPTIONS).map((o) => <Chip key={o.value} on={value.includes(o.value)} onClick={() => toggle(o.value)}>{o.label}</Chip>)}
    </div>
  );
}

function InsurerPicker({ value = [], mode, onChange, onMode, suggestions = [] }) {
  const [draft, setDraft] = useState('');
  const add = (name) => {
    const v = String(name || '').trim().slice(0, 60);
    if (!v || value.some((x) => x.toLowerCase() === v.toLowerCase()) || value.length >= 20) { setDraft(''); return; }
    onChange([...value, v]);
    setDraft('');
  };
  return (
    <div className="space-y-2">
      <Select aria-label="Insurer rule" value={mode} onChange={(e) => onMode(e.target.value)}>
        <option value="include">Insurer is one of these</option>
        <option value="exclude">Insurer is not one of these</option>
      </Select>
      <div className="flex gap-2">
        <ComboInput aria-label="Insurer name" placeholder="Type or pick an insurer" value={draft} options={suggestions.filter((s) => !value.includes(s))}
          onChange={(e) => {
            // A picked suggestion arrives without a native event: add it right away. Typing only edits the draft.
            if (!e.nativeEvent && e.target.value) add(e.target.value);
            else setDraft(e.target.value);
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(draft); } }} />
        <Button type="button" variant="secondary" className="shrink-0" disabled={!draft.trim()} onClick={() => add(draft)}>Add</Button>
      </div>
      {value.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Insurers">
          {value.map((name) => (
            <li key={name} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 py-0.5 pl-2 pr-1 text-xs">
              {name}
              <button type="button" aria-label={`Remove ${name}`} className="rounded p-0.5 text-muted hover:bg-surface hover:text-fg" onClick={() => onChange(value.filter((x) => x !== name))}>
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The filter form. `value` is the form state, `onChange(next)` gets the whole new state.
 * `columns`: 1 for a narrow sidebar (Find carriers), 2 for the generator dialog.
 */
export default function LeadFilters({ value, onChange, equipmentOptions, insurerSuggestions = [], columns = 1, idPrefix = 'lf' }) {
  const f = value || LEAD_FILTER_DEFAULTS;
  const set = (k) => (e) => onChange({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  const setRating = (code) => (e) => onChange({ ...f, excludeRatings: e.target.checked ? [...new Set([...(f.excludeRatings || []), code])].sort() : (f.excludeRatings || []).filter((x) => x !== code) });
  const num = (k, label, props = {}) => <Field label={label}><Input type="number" min="0" inputMode="numeric" value={f[k]} onChange={set(k)} {...props} /></Field>;
  const eqOptions = equipmentOptions?.length ? equipmentOptions : EQUIPMENT_OPTIONS;
  return (
    <div className={cx('grid gap-2', columns === 2 && 'md:grid-cols-2 md:items-start')}>
      <Group id={`${idPrefix}-location`} title="Location" active={activeLeadFilters(f, 'location')}>
        <Field label="ZIP prefixes" hint="First 3 to 5 digits, separated by commas (773, 750).">
          <Input value={f.zipPrefixes} onChange={set('zipPrefixes')} placeholder="773, 750" />
        </Field>
        <Field label="Counties" hint="3-digit county FIPS codes (201 = Harris County, TX). They apply inside the chosen states.">
          <Input value={f.counties} onChange={set('counties')} placeholder="201, 339" />
        </Field>
      </Group>

      <Group id={`${idPrefix}-operation`} title="Operation" active={activeLeadFilters(f, 'operation')}>
        <div className="flex flex-col gap-1.5">
          <Checkbox label="Interstate only" checked={f.interstateOnly} onChange={set('interstateOnly')} />
          <Checkbox label="For-hire only (authorized for hire)" checked={f.forHireOnly} onChange={set('forHireOnly')} />
        </div>
        <Field label="Hazmat">
          <Select value={f.hazmat} onChange={set('hazmat')}>
            <option value="any">Any</option><option value="yes">Hazmat carriers only</option><option value="no">No hazmat</option>
          </Select>
        </Field>
      </Group>

      <Group id={`${idPrefix}-size`} title="Size and equipment" active={activeLeadFilters(f, 'size')}>
        <div className="grid grid-cols-2 gap-2">
          {num('minDrivers', 'Drivers min')}
          {num('maxDrivers', 'Drivers max')}
          {num('minCdlDrivers', 'CDL drivers min')}
          {num('maxMilesPerTruck', 'Miles per truck max', { step: 5000, placeholder: '60000' })}
        </div>
        <p className="text-xs text-muted">Miles per truck come from the MCS-150 mileage of the last full year. Under 60,000 means trucks sit idle.</p>
        <fieldset className="space-y-1.5">
          <legend className="text-[13px] font-medium">Equipment <span className="font-normal text-muted">inferred from cargo classes and vehicle counts</span></legend>
          <EquipmentChips value={f.equipment} options={eqOptions} onChange={set('equipment')} />
        </fieldset>
      </Group>

      <Group id={`${idPrefix}-safety`} title="Authority and safety" active={activeLeadFilters(f, 'safety')}>
        <div className="grid grid-cols-2 gap-2">
          {num('mcAgeMinDays', 'MC age from (days)')}
          {num('mcAgeMaxDays', 'MC age up to (days)')}
        </div>
        <p className="text-xs text-muted">Days since the MC was granted (FMCSA authority history). 0–90 = new authority, 90–180 = broker-ready.</p>
        <Field label="MCS-150 updated within">
          <Select value={f.mcs150WithinMonths} onChange={set('mcs150WithinMonths')}>
            <option value="">Any time</option><option value="3">3 months</option><option value="6">6 months</option><option value="12">12 months</option><option value="24">2 years</option>
          </Select>
        </Field>
        <div className="flex flex-col gap-1.5">
          <Checkbox label="Leave out Unsatisfactory safety ratings" checked={(f.excludeRatings || []).includes('U')} onChange={setRating('U')} />
          <Checkbox label="Leave out Conditional safety ratings" checked={(f.excludeRatings || []).includes('C')} onChange={setRating('C')} />
        </div>
      </Group>

      <Group id={`${idPrefix}-contact`} title="Contact quality" active={activeLeadFilters(f, 'contact')}>
        <div className="flex flex-col gap-1.5">
          <Checkbox label="Has a cell phone" checked={f.requireCell} onChange={set('requireCell')} />
          <Checkbox label="Has a cell phone or an email" checked={f.requireCellOrEmail} onChange={set('requireCellOrEmail')} />
          <Checkbox label="Leave out shared contacts" checked={f.excludeSharedContacts} onChange={set('excludeSharedContacts')} />
        </div>
        <p className="text-xs text-muted">The same phone or email on 3 or more carriers usually belongs to a dispatch service or agent: that carrier likely has a dispatcher already.</p>
        <Field label="Email type">
          <Select value={f.excludeEmail} onChange={set('excludeEmail')}>
            <option value="none">Any email</option>
            <option value="free">Leave out free email (Gmail, Yahoo, Outlook)</option>
            <option value="corporate">Leave out company email domains</option>
          </Select>
        </Field>
      </Group>

      <Group id={`${idPrefix}-insurer`} title="Insurer" active={activeLeadFilters(f, 'insurer')}
        hint="Company on the current primary liability (BIPD) policy, from FMCSA insurance filings. Progressive includes United Financial and Artisan & Truckers.">
        <InsurerPicker value={f.insurers} mode={f.insurerMode} suggestions={insurerSuggestions}
          onChange={(insurers) => onChange({ ...f, insurers })} onMode={(insurerMode) => onChange({ ...f, insurerMode })} />
      </Group>
    </div>
  );
}
