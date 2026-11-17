import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, PartyPopper } from 'lucide-react';
import { Modal } from '../Modal.jsx';
import { Button } from '../ui.jsx';

const COLORS = ['#14b8a6', '#0f766e', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7'];
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** A short burst of confetti over the page (about two seconds). Skipped when the viewer prefers reduced motion. */
function Confetti() {
  const ref = useRef(null);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext?.('2d');
    if (!ctx || reducedMotion()) return undefined;
    const w = (canvas.width = window.innerWidth);
    const h = (canvas.height = window.innerHeight);
    const bits = Array.from({ length: 140 }, (_, i) => ({
      x: w / 2 + (Math.random() - 0.5) * w * 0.3, y: h * 0.35,
      vx: (Math.random() - 0.5) * 14, vy: -Math.random() * 13 - 4,
      size: 5 + Math.random() * 6, rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.3, color: COLORS[i % COLORS.length],
    }));
    const start = performance.now();
    let raf;
    const frame = (now) => {
      const t = now - start;
      ctx.clearRect(0, 0, w, h);
      ctx.globalAlpha = Math.max(0, 1 - Math.max(0, t - 1500) / 700);
      for (const b of bits) {
        b.vy += 0.35; b.vx *= 0.99; b.x += b.vx; b.y += b.vy; b.rot += b.vr;
        ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot); ctx.fillStyle = b.color;
        ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size / 2); ctx.restore();
      }
      if (t < 2200) raf = requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, w, h);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);
  return createPortal(<canvas ref={ref} aria-hidden className="pointer-events-none fixed inset-0 z-[80]" />, document.body);
}

/**
 * "Welcome to Pro": shown after a checkout is confirmed, a plan code is redeemed or an admin gift arrives.
 * `plan` = { name, features[] }; `headline` overrides the title; `note` is a line under it (for example "for 3 months,
 * a gift from DispatchDesk"); `message` is the admin's own words.
 */
export default function PlanCelebration({ plan, headline, note, message, onClose }) {
  if (!plan) return null;
  const features = (plan.features || []).slice(0, 6);
  return (
    <>
      <Confetti />
      <Modal open onClose={onClose} title={headline || `Welcome to ${plan.name}`} size="sm" footer={<Button className="w-full" onClick={onClose}>Start using {plan.name}</Button>}>
        <div className="space-y-4 text-center">
          <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-brand-600/10 text-brand-700 dark:text-brand-300"><PartyPopper className="size-6" aria-hidden /></span>
          {note && <p className="text-base text-fg">{note}</p>}
          {message && <p className="rounded-lg bg-surface-2 px-3 py-2 text-left text-sm text-fg-2">{message}</p>}
          {features.length > 0 && (
            <div className="text-left">
              <p className="mb-2 text-xs font-medium text-muted">Now unlocked</p>
              <ul className="space-y-1.5 text-sm">
                {features.map((f) => <li key={f} className="flex gap-2"><Check className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />{f}</li>)}
              </ul>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
