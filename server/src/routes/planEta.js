import { Router } from 'express';
import { ah } from '../lib/errors.js';
import { parse, z, optStr, optNum } from '../lib/validate.js';
import { requirePermission } from '../middleware/auth.js';
import { loadCarrier, loadOwned } from '../lib/access.js';
import { validTimezone } from '../services/loads/facilityTz.js';
import { planEta } from '../services/fleet/planEta.js';

/**
 * Legal ETA for a planned trip (before booking): drive time from the road route plus required breaks, resets and the
 * hours the driver has left, checked against the delivery appointment. POST / (see services/fleet/planEta.js).
 */
const r = Router();
r.use(requirePermission('crm.use'));

const state = z.preprocess((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{2}$/, 'Use a 2-letter state code'));
const lat = z.coerce.number().min(-90).max(90);
const lng = z.coerce.number().min(-180).max(180);
const place = z.object({
  city: z.preprocess((v) => (v === '' ? null : v), z.string().trim().max(100).nullable().optional()),
  state,
  lat: lat.nullable().optional(),
  lng: lng.nullable().optional(),
});
/** An ISO instant, or a facility-local wall time without an offset ("2026-11-12T08:00", converted with the stop's zone). */
const LOCAL_DT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
const when = z.preprocess((v) => (v === '' ? null : v), z.union([z.string().regex(LOCAL_DT), z.coerce.date()]).nullable().optional());
const tz = z.preprocess((v) => (v === '' ? null : v), z.string().max(60).refine(validTimezone, 'Unknown time zone').nullable().optional());

const schema = z.object({
  carrierId: optStr(40),
  loadId: optStr(40),
  origin: place,
  dest: place,
  startAt: when,
  pickupWindowStart: when,
  pickupWindowEnd: when,
  deliveryWindowStart: when,
  deliveryWindowEnd: when,
  pickupTz: tz,
  deliveryTz: tz,
  hoursLeft: z.object({ drive: optNum(0, 11), duty: optNum(0, 14), cycle: optNum(0, 70) }).nullable().optional(),
  dwellHours: optNum(0, 48),
  deadhead: z.object({ from: z.object({ lat, lng }) }).nullable().optional(),
});

r.post('/', ah(async (req, res) => {
  const body = parse(schema, req.body);
  const load = body.loadId ? await loadOwned('load', req.user, body.loadId) : null;
  if (body.carrierId) await loadCarrier(req.user, body.carrierId);
  res.json(await planEta(req.user, body, { load }));
}));

export default r;
