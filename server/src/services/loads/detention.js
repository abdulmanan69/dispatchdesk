/**
 * Detention clock from the load's timeline (LoadEvent rows): driver check-ins from the driver link and the
 * dispatcher's own "Arrived" / "Departed" buttons.
 *   pickup:   arrived_pickup -> departed_pickup (or loaded when no departure was recorded)
 *   delivery: arrived_delivery -> delivered
 * The clock starts at the later of arrival and the appointment start (an early truck is not on detention), free time
 * is Load.freeTimeHours, and billable time runs from the end of free time to departure (or now while the truck is
 * still on site). Amounts use Load.detentionRateCents per hour. Pure: no I/O.
 */
const HOUR = 3_600_000;
const STOPS = [
  { kind: 'pickup', arrive: ['arrived_pickup'], depart: ['departed_pickup', 'loaded'], appt: 'pickupWindowStart', tz: 'pickupTz' },
  { kind: 'delivery', arrive: ['arrived_delivery'], depart: ['delivered'], appt: 'deliveryWindowStart', tz: 'deliveryTz' },
];
const CLOSED = ['canceled'];

const time = (v) => (v ? new Date(v).getTime() : null);
const round2 = (v) => Math.round(v * 100) / 100;

export function detentionSummary(load, events = [], now = new Date()) {
  const freeHours = Number.isFinite(Number(load.freeTimeHours)) ? Number(load.freeTimeHours) : 2;
  const rate = Number(load.detentionRateCents) || 0;
  const nowMs = now.getTime();
  const stops = STOPS.map((s) => {
    const arrivals = events.filter((e) => s.arrive.includes(e.type)).sort((a, b) => time(a.at) - time(b.at));
    const arrived = arrivals[0] || null;
    const arrivedAt = arrived ? time(arrived.at) : null;
    // Prefer an explicit departure; fall back to "loaded" for the pickup.
    let departed = null;
    if (arrivedAt != null) {
      for (const type of s.depart) {
        const hit = events.filter((e) => e.type === type && time(e.at) >= arrivedAt).sort((a, b) => time(b.at) - time(a.at))[0];
        if (hit) { departed = hit; break; }
      }
    }
    const departedAt = departed ? time(departed.at) : null;
    const apptStart = time(load[s.appt]);
    const clockStart = arrivedAt == null ? null : apptStart != null && apptStart > arrivedAt ? apptStart : arrivedAt;
    const freeEndsAt = clockStart == null ? null : clockStart + freeHours * HOUR;
    const running = arrivedAt != null && departedAt == null && !CLOSED.includes(load.status);
    const end = departedAt ?? (running ? nowMs : null);
    const onSiteMs = arrivedAt != null && end != null ? Math.max(0, end - arrivedAt) : null;
    const billableMs = freeEndsAt != null && end != null ? Math.max(0, end - freeEndsAt) : 0;
    const hours = round2(billableMs / HOUR);
    let state = 'waiting';
    if (arrivedAt != null) state = departedAt != null ? 'departed' : end != null && freeEndsAt != null && end > freeEndsAt ? 'detention' : 'free_time';
    return {
      kind: s.kind,
      tz: load[s.tz] || null,
      state,
      arrivedAt: arrivedAt != null ? new Date(arrivedAt) : null,
      arrivedSource: arrived?.source || null,
      departedAt: departedAt != null ? new Date(departedAt) : null,
      departedSource: departed?.source || null,
      apptStart: apptStart != null ? new Date(apptStart) : null,
      clockStart: clockStart != null ? new Date(clockStart) : null,
      freeEndsAt: freeEndsAt != null ? new Date(freeEndsAt) : null,
      running,
      onSiteHours: onSiteMs != null ? round2(onSiteMs / HOUR) : null,
      billableHours: hours,
      amountCents: Math.round(hours * rate),
    };
  });
  const billableHours = round2(stops.reduce((sum, s) => sum + s.billableHours, 0));
  return {
    freeTimeHours: freeHours,
    rateCents: rate,
    stops,
    billableHours,
    amountCents: Math.round(billableHours * rate),
    running: stops.some((s) => s.running && s.state === 'detention'),
  };
}
