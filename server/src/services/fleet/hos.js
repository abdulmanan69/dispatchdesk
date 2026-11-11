/**
 * Hours-of-service planning for property-carrying drivers (49 CFR 395.3), used for the "legal ETA".
 * A planning estimate, never a log: it assumes the driver drives whenever the rules allow and ignores sleeper-berth
 * splits, adverse-conditions extensions and the rolling recapture of the 70-hour cycle.
 *
 * Rules simulated:
 *   - 11 hours of driving after 10 consecutive hours off duty
 *   - no driving after the 14th hour since coming on duty (the window keeps running during breaks)
 *   - a 30-minute break (off duty or on duty not driving) after 8 hours of driving
 *   - 10 consecutive hours off duty restore the 11- and 14-hour clocks
 *   - 70 hours on duty in 8 days; a 34-hour restart restores the cycle
 *
 * Clocks are minutes left: { driveLeft, shiftLeft, cycleLeft, breakDue } (breakDue = driving minutes until a break is required).
 */
export const LIMITS = { drive: 11 * 60, shift: 14 * 60, cycle: 70 * 60, breakAfter: 8 * 60, break: 30, rest: 10 * 60, restart: 34 * 60 };

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const MIN = 60_000;

export const freshClocks = () => ({ driveLeft: LIMITS.drive, shiftLeft: LIMITS.shift, cycleLeft: LIMITS.cycle, breakDue: LIMITS.breakAfter });

/** Validate and clamp clocks entered by a dispatcher or driver (minutes). breakDue defaults to "no break taken this shift". */
export function normalizeClocks(input = {}) {
  const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const driveLeft = num(input.driveLeftMin ?? input.driveLeft);
  const shiftLeft = num(input.shiftLeftMin ?? input.shiftLeft);
  const cycleLeft = num(input.cycleLeftMin ?? input.cycleLeft);
  if (driveLeft == null && shiftLeft == null && cycleLeft == null) return null;
  const drive = clamp(driveLeft ?? LIMITS.drive, 0, LIMITS.drive);
  const shift = clamp(shiftLeft ?? LIMITS.shift, 0, LIMITS.shift);
  const cycle = clamp(cycleLeft ?? LIMITS.cycle, 0, LIMITS.cycle);
  const explicitBreak = num(input.breakDueMin ?? input.breakDue);
  // Without an answer, assume no 30-minute break yet in this shift: driving so far counts toward the 8 hours.
  const breakDue = clamp(explicitBreak ?? LIMITS.breakAfter - (LIMITS.drive - drive), 0, LIMITS.breakAfter);
  return { driveLeft: Math.round(drive), shiftLeft: Math.round(shift), cycleLeft: Math.round(cycle), breakDue: Math.round(breakDue) };
}

/**
 * Clocks "now" from a report made `elapsedMin` ago. The 14-hour window runs on the wall clock; the driving clocks run
 * for the minutes the truck was moving (pass movingMin from GPS, or leave it out to assume driving the whole time).
 * A report older than 10 hours is stale: the driver may have reset, so it is not used.
 */
export function clocksAt(clocks, elapsedMin, movingMin = null) {
  if (!clocks) return null;
  const e = Math.max(0, elapsedMin);
  if (e >= LIMITS.rest) return null;
  const m = clamp(movingMin == null ? e : movingMin, 0, e);
  return {
    driveLeft: Math.max(0, clocks.driveLeft - m),
    shiftLeft: Math.max(0, clocks.shiftLeft - e),
    cycleLeft: Math.max(0, clocks.cycleLeft - m),
    breakDue: Math.max(0, clocks.breakDue - m),
  };
}

/**
 * Run a sequence of segments through the rules.
 *   segments: [{ drive: minutes } | { onDuty: minutes } | { waitUntil: ms } | { mark: 'label' }]
 * Returns { endMs, marks: { [label]: ms }, events: [{ type: 'drive'|'break'|'rest'|'restart'|'on_duty'|'wait', startMs, endMs }],
 * breaks, rests, restarts }. With `legal: false` the clocks are ignored (plain drive-time arithmetic).
 */
export function simulate(startMs, segments, clocks = freshClocks(), { legal = true, maxEvents = 200 } = {}) {
  let t = startMs;
  const c = { ...freshClocks(), ...(clocks || {}) };
  const events = [];
  const marks = {};
  let breaks = 0;
  let rests = 0;
  let restarts = 0;
  const push = (type, startMsE, endMsE) => {
    if (endMsE <= startMsE) return;
    const last = events[events.length - 1];
    if (last && last.type === type && last.endMs === startMsE) last.endMs = endMsE;
    else if (events.length < maxEvents) events.push({ type, startMs: startMsE, endMs: endMsE });
  };
  const offDuty = (minutes, type) => {
    push(type, t, t + minutes * MIN);
    t += minutes * MIN;
  };

  for (const seg of segments) {
    if (seg.mark) { marks[seg.mark] = t; continue; }
    if (seg.waitUntil != null) {
      const wait = Math.max(0, (seg.waitUntil - t) / MIN);
      if (wait <= 0) continue;
      offDuty(wait, 'wait');
      if (!legal) continue;
      if (wait >= LIMITS.rest) Object.assign(c, { driveLeft: LIMITS.drive, shiftLeft: LIMITS.shift, breakDue: LIMITS.breakAfter });
      else {
        c.shiftLeft = Math.max(0, c.shiftLeft - wait);
        if (wait >= LIMITS.break) c.breakDue = LIMITS.breakAfter;
      }
      continue;
    }
    if (seg.onDuty != null) {
      const m = Math.max(0, seg.onDuty);
      push('on_duty', t, t + m * MIN);
      t += m * MIN;
      if (legal) {
        c.shiftLeft = Math.max(0, c.shiftLeft - m);
        c.cycleLeft = Math.max(0, c.cycleLeft - m);
        // Since 2020, 30 minutes on duty not driving (loading, unloading) also satisfies the break.
        if (m >= LIMITS.break) c.breakDue = LIMITS.breakAfter;
      }
      continue;
    }
    let left = Math.max(0, seg.drive || 0);
    let guard = 0;
    while (left > 0.01 && guard++ < 500) {
      if (!legal) {
        push('drive', t, t + left * MIN);
        t += left * MIN;
        left = 0;
        break;
      }
      if (c.cycleLeft <= 0) {
        offDuty(LIMITS.restart, 'restart');
        restarts++;
        Object.assign(c, freshClocks());
        continue;
      }
      if (c.driveLeft <= 0 || c.shiftLeft <= 0) {
        offDuty(LIMITS.rest, 'rest');
        rests++;
        Object.assign(c, { driveLeft: LIMITS.drive, shiftLeft: LIMITS.shift, breakDue: LIMITS.breakAfter });
        continue;
      }
      if (c.breakDue <= 0) {
        offDuty(LIMITS.break, 'break');
        breaks++;
        c.shiftLeft = Math.max(0, c.shiftLeft - LIMITS.break);
        c.breakDue = LIMITS.breakAfter;
        continue;
      }
      const d = Math.min(left, c.driveLeft, c.shiftLeft, c.cycleLeft, c.breakDue);
      push('drive', t, t + d * MIN);
      t += d * MIN;
      left -= d;
      c.driveLeft -= d;
      c.shiftLeft -= d;
      c.cycleLeft -= d;
      c.breakDue -= d;
    }
  }
  return { endMs: t, marks, events, breaks, rests, restarts, clocks: c };
}

/** "6 h 30 min" style text for minutes. */
export function hoursText(min) {
  if (min == null) return '';
  const m = Math.max(0, Math.round(min));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
}
