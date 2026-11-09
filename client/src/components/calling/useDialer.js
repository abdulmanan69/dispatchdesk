import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api.js';
import { useConfirm } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';

const FINAL = new Set(['completed', 'no_answer', 'busy', 'failed', 'canceled']);

/** Hand the provider link to the browser/OS. https links open a tab; app schemes (tel:, zoomphonecall:, sip:) go to the OS handler. */
export function openDialLink(url) {
  if (!url) return;
  if (/^https:\/\//i.test(url)) window.open(url, '_blank', 'noopener');
  else window.location.href = url;
}

/**
 * One place to start a call. Every call starts from an explicit click; nothing here dials on its own.
 *  - link providers: opens the provider link, returns the attempt
 *  - bridge (Twilio): server rings the user's phone; `attempt` is polled until it finishes
 * Handles do-not-call (blocked) and outside-calling-hours (explicit "Call anyway").
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

  const stopPolling = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  useEffect(() => stopPolling, []);

  const poll = useCallback((id) => {
    stopPolling();
    const tick = async () => {
      try {
        const { attempt: a } = await api.get(`/api/telephony/attempts/${id}`);
        setAttempt(a);
        if (FINAL.has(a.status)) {
          if (a.callId) { toast.info(`${a.carrier?.companyName || a.toPretty}: ${a.status === 'busy' ? 'busy' : 'no answer'} — logged automatically`); qc.invalidateQueries({ queryKey: ['carrier'] }); qc.invalidateQueries({ queryKey: ['queue'] }); }
          else if (a.status === 'failed' && a.error) toast.error(a.error);
          return;
        }
      } catch { /* keep polling */ }
      timer.current = setTimeout(tick, 2000);
    };
    timer.current = setTimeout(tick, 1500);
  }, [toast, qc]);

  const dial = useCallback(async ({ carrierId, phone }) => {
    if (dialing) return null;
    setDialing(true);
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
          toast.error(err);
          return null;
        }
      }
      setMode(res.mode);
      setAttempt(res.attempt);
      setAutoOpenLog(res.autoOpenLog !== false);
      if (res.mode === 'link') openDialLink(res.url);
      else { toast.info(res.message || 'Ringing your phone'); poll(res.attempt.id); }
      return res;
    } catch (err) {
      toast.error(err);
      return null;
    } finally {
      setDialing(false);
    }
  }, [dialing, confirm, toast, poll]);

  const cancel = useCallback(async () => {
    if (!attempt) return;
    try {
      const { attempt: a } = await api.post(`/api/telephony/attempts/${attempt.id}/cancel`);
      setAttempt(a);
      stopPolling();
    } catch (err) { toast.error(err); }
  }, [attempt, toast]);

  const reset = useCallback(() => { stopPolling(); setAttempt(null); setMode(null); }, []);

  return { dial, cancel, reset, attempt, mode, dialing, autoOpenLog, isFinal: attempt ? FINAL.has(attempt.status) : false };
}

export const ATTEMPT_LABEL = {
  dialed: 'Opened in your phone app', queued: 'Calling your phone…', ringing: 'Ringing your phone…', in_progress: 'Connected — dialing the carrier',
  completed: 'Call ended', no_answer: 'No answer', busy: 'Busy', failed: 'Call failed', canceled: 'Canceled',
};
