import { useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { driver } from 'driver.js';
import 'driver.js/dist/driver.css';
import './tour.css';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { TOURS, tourForPath } from './tours.js';

const LOCAL_KEY = 'dd.tours';
const readLocal = () => { try { return JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}'); } catch { return {}; } };
const writeLocal = (s) => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ } };

/** Tour state from the server, with a localStorage fallback when the request fails. */
export function useTourState() {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ['tours'],
    queryFn: async () => {
      try { return (await api.get('/api/tours')).state || {}; } catch { return readLocal(); }
    },
    staleTime: Infinity,
  });
  const record = useCallback(async (id, status) => {
    const next = { ...(qc.getQueryData(['tours']) || {}), [id]: { [status]: true, at: new Date().toISOString() } };
    qc.setQueryData(['tours'], next);
    writeLocal(next);
    try { await api.post(`/api/tours/${id}`, { status }); } catch { /* kept locally */ }
  }, [qc]);
  return { state: query.data, loaded: query.isSuccess, record };
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Build driver.js steps, dropping steps whose target is missing or hidden. */
function buildSteps(tour) {
  return tour.steps.map((s) => {
    const el = s.el ? s.el() : undefined;
    if (s.el && !el) return null;
    return {
      ...(el ? { element: el } : {}),
      popover: { title: s.title, description: s.body, side: s.side || 'bottom', align: 'start' },
    };
  }).filter(Boolean);
}

/** Runs the page's tour once on first visit (desktop), and on demand from the account menu. Never blocks the page. */
export default function TourHost() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const { state, loaded, record } = useTourState();
  const active = useRef(null);

  const start = useCallback((id, { auto = false } = {}) => {
    const tour = TOURS[id];
    if (!tour || active.current) return false;
    if (tour.admin && !user?.permissions?.includes('admin.settings')) return false;
    const steps = buildSteps(tour);
    // Auto-start only when the page's real targets are there; a tour of nothing but centered text is noise.
    if (!steps.length || (auto && !steps.some((s) => s.element))) return false;
    let finished = false;
    const d = driver({
      steps,
      showProgress: true,
      progressText: '{{current}} of {{total}}',
      nextBtnText: 'Next',
      prevBtnText: 'Back',
      doneBtnText: 'Done',
      allowClose: true,
      allowKeyboardControl: true,
      animate: !reducedMotion(),
      smoothScroll: !reducedMotion(),
      overlayOpacity: 0.55,
      stagePadding: 6,
      stageRadius: 10,
      popoverClass: 'dd-tour',
      onPopoverRender: (popover, { driver: drv }) => {
        // A plain "Skip tour" link next to Back/Next.
        if (drv.isLastStep()) return;
        const skip = document.createElement('button');
        skip.type = 'button';
        skip.className = 'dd-tour-skip';
        skip.textContent = 'Skip tour';
        skip.addEventListener('click', () => drv.destroy());
        popover.footerButtons.prepend(skip);
      },
      onNextClick: (el, step, { driver: drv }) => {
        if (drv.isLastStep()) finished = true;
        drv.moveNext();
      },
      onDestroyed: () => {
        active.current = null;
        record(id, finished ? 'done' : 'skipped');
      },
    });
    active.current = d;
    d.drive();
    return true;
  }, [record, user]);

  // Auto-start on first visit to a page with a tour, once targets have rendered.
  useEffect(() => {
    if (!loaded || !user) return undefined;
    const id = tourForPath(location.pathname, location.search, user);
    if (!id || state?.[id]) return undefined;
    if (window.innerWidth < 1024) return undefined; // the sidebar is hidden on small screens
    if (id !== 'welcome' && !state?.welcome) return undefined; // the welcome tour comes first
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      if (document.querySelector('[role="dialog"]')) return; // wait for open modals
      if (start(id, { auto: true }) || tries > 12) clearInterval(t);
    }, 600);
    return () => clearInterval(t);
  }, [loaded, user, location.pathname, location.search, state, start]);

  // Manual start: window.dispatchEvent(new CustomEvent('dd:tour', { detail: { id } })), id 'auto' = this page or welcome.
  useEffect(() => {
    const onTour = (e) => {
      const want = e.detail?.id;
      const id = want && want !== 'auto' ? want : tourForPath(location.pathname, location.search, user) || 'welcome';
      if (id === 'welcome' && location.pathname !== '/app') {
        navigate('/app');
        setTimeout(() => start('welcome'), 900);
        return;
      }
      start(id);
    };
    window.addEventListener('dd:tour', onTour);
    return () => window.removeEventListener('dd:tour', onTour);
  }, [location.pathname, location.search, user, start, navigate]);

  useEffect(() => () => active.current?.destroy(), []);
  return null;
}
