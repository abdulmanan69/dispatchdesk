import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { errorToast } from '../../lib/hooks.js';
import { useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';

const FINAL = new Set(['completed', 'no_answer', 'busy', 'failed', 'canceled']);
const POLL_MS = 2000;
const FIRST_POLL_MS = 1500;
const MAX_BACKOFF_MS = 30000;
/** A bridge call that has not finished after this long is no longer polled (the webhook still records it). */
export const MAX_POLL_MS = 15 * 60 * 1000;

/**
 * Hand the provider link to the browser/OS. https links open a tab; app schemes (tel:, zoomphonecall:, sip:) go to the
 * OS handler. Returns false when the browser blocked the tab (a slow save or dial request can outlast the click's
 * user activation), so the caller can offer a button that opens it.
 */
export function openDialLink(url) {
  if (!url) return true;
  if (!/^https:\/\//i.test(url)) { window.location.href = url; return true; }
  // No 'noopener' feature: with it window.open always returns null, and a blocked tab could not be detected.
  const w = window.open(url, '_blank');
  if (!w) return false;
  try { w.opener = null; } catch { /* cross-origin already */ }
  return true;
}

/**
 * One place to start a call. Every call starts from an explicit click; nothing here dials on its own.
 *  - link providers: opens the provider link, returns the attempt
 *  - bridge (Twilio): server rings the user's phone; `attempt` is polled until it finishes
 * Handles do-not-call (blocked) and outside-calling-hours (explicit "Call anyway").
 *
 * Polling is guarded by a generation number: reset(), a new dial or unmounting bumps it (and aborts the request in
 * flight), so a late answer can never restart the timer or hand an old attempt to the next carrier.
 * It stops on 4xx errors, backs off on other errors and gives up after MAX_POLL_MS.
 */
export function useDialer() {
  const confirm = useConfirm();
  const toast = useToast();
  const qc = useQueryClient();
  const [attempt, setAttempt] = useState(null);
  const [mode, setMode] = useState(null);
  const [dialing, setDialing] = useState(false);
  const [autoOpenLog, setAutoOpenLog] = useState(true);
  const timer = useRef(null);
  const gen = useRef(0);
  const inflight = useRef(null); // AbortController of the poll request in flight
  const dialingRef = useRef(false);

  const stopPolling = useCallback(() => {
    gen.current += 1;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    if (inflight.current) { inflight.current.abort(); inflight.current = null; }
  }, []);
  useEffect(() => stopPolling, [stopPolling]);

  const poll = useCallback((id) => {
    stopPolling();
    const my = gen.current;
    const startedAt = Date.now();
    let failures = 0;
    const schedule = (ms) => { if (my === gen.current) timer.current = setTimeout(tick, ms); };
    async function tick() {
      timer.current = null;
      if (my !== gen.current) return;
      if (Date.now() - startedAt > MAX_POLL_MS) return;
      let a;
      const ctrl = new AbortController();
      inflight.current = ctrl;
      try {
        ({ attempt: a } = await api.get(`/api/telephony/attempts/${id}`, undefined, { signal: ctrl.signal }));
      } catch (err) {
        if (my !== gen.current) return;
        if (err?.status >= 400 && err.status < 500) return; // gone or not ours: stop
        failures += 1;
        schedule(Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** failures));
        return;
      } finally {
        if (inflight.current === ctrl) inflight.current = null;
      }
      if (my !== gen.current) return; // reset, redialed or unmounted while the request was in flight
      failures = 0;
      setAttempt(a);
      if (FINAL.has(a.status)) {
        if (a.callId) { toast.info(`${a.carrier?.companyName || a.toPretty}: ${a.status === 'busy' ? 'busy' : 'no answer'}. Logged automatically.`); qc.invalidateQueries({ queryKey: a.carrier?.id || a.carrierId ? ['carrier', a.carrier?.id || a.carrierId] : ['carrier'] }); qc.invalidateQueries({ queryKey: ['queue'] }); }
        else if (a.status === 'failed' && a.error) toast.error(a.error);
        return;
      }
      schedule(POLL_MS);
    }
    schedule(FIRST_POLL_MS);
  }, [toast, qc, stopPolling]);

  const dial = useCallback(async ({ carrierId, phone }) => {
    if (dialingRef.current) return null;
    dialingRef.current = true;
    setDialing(true);
    stopPolling();
    try {
      let res;
      try {
        res = await api.post('/api/telephony/dial', { carrierId, phone });
      } catch (err) {
        const code = err.details?.code;
        if (code === 'outside_hours') {
          const ok = await confirm({ title: 'Outside calling hours', message: `${err.message} Call anyway?`, confirmLabel: 'Call anyway' });
          if (!ok) return null;
          res = await api.post('/api/telephony/dial', { carrierId, phone, force: true });
        } else {
          errorToast(toast, err);
          return null;
        }
      }
      setMode(res.mode);
      setAttempt(res.attempt);
      setAutoOpenLog(res.autoOpenLog !== false);
      if (res.mode === 'link' && !openDialLink(res.url)) {
        toast.info('Your browser blocked the call tab.', { action: { label: 'Open call', onClick: () => openDialLink(res.url) } });
      }
      else { toast.info(res.message || 'Ringing your phone'); poll(res.attempt.id); }
      return res;
    } catch (err) {
      errorToast(toast, err);
      return null;
    } finally {
      dialingRef.current = false;
      setDialing(false);
    }
  }, [confirm, toast, poll, stopPolling]);

  const attemptRef = useRef(null);
  attemptRef.current = attempt;
  const cancel = useCallback(async () => {
    const current = attemptRef.current;
    if (!current) return;
    const my = gen.current;
    try {
      const { attempt: a } = await api.post(`/api/telephony/attempts/${current.id}/cancel`);
      if (my !== gen.current || attemptRef.current?.id !== current.id) return; // reset or redialed meanwhile
      stopPolling();
      setAttempt(a);
    } catch (err) { errorToast(toast, err); }
  }, [toast, stopPolling]);

  const reset = useCallback(() => { stopPolling(); setAttempt(null); setMode(null); }, [stopPolling]);

  const isFinal = attempt ? FINAL.has(attempt.status) : false;
  // Stable object: callers can list `d` in effect dependencies without re-running them on every render.
  return useMemo(() => ({ dial, cancel, reset, attempt, mode, dialing, autoOpenLog, isFinal }), [dial, cancel, reset, attempt, mode, dialing, autoOpenLog, isFinal]);
}

export const ATTEMPT_LABEL = {
  dialed: 'Opened in your phone app', queued: 'Calling your phone…', ringing: 'Ringing your phone…', in_progress: 'Connected, dialing the carrier',
  completed: 'Call ended', no_answer: 'No answer', busy: 'Busy', failed: 'Call failed', canceled: 'Canceled',
};
