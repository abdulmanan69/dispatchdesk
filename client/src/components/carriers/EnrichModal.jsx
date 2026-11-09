import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { date, label } from '../../lib/format.js';
import { Modal } from '../Modal.jsx';
import { Button, Checkbox, ErrorState, Loading } from '../ui.jsx';

const show = (v) => {
  if (v == null || v === '') return <span className="text-muted">empty</span>;
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return date(v);
  return String(v);
};

/** Look the carrier up in FMCSA, show what would change, and apply only the fields the user picks. */
export default function EnrichModal({ carrier, onClose }) {
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const load = () => {
    setError(null); setPreview(null);
    api.post(`/api/carriers/${carrier.id}/enrich`, { dryRun: true })
      .then((d) => { setPreview(d); setPicked(new Set(Object.keys(d.changes))); })
      .catch(setError);
  };
  useEffect(load, [carrier.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const apply = useApiMutation((fields) => api.post(`/api/carriers/${carrier.id}/enrich`, { fields }), {
    success: (d) => { const n = Object.keys(d.changes).length; return n ? `Updated ${n} field${n === 1 ? '' : 's'} from FMCSA` : 'Marked as checked against FMCSA'; },
    invalidate: [['carrier', carrier.id], ['carriers'], ['pipeline']],
    onSuccess: onClose,
  });
  const keys = preview ? Object.keys(preview.changes) : [];
  const toggle = (k) => setPicked((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });

  return (
    <Modal open onClose={onClose} size="lg" title="Enrich from FMCSA"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button disabled={!preview} loading={apply.isPending} onClick={() => apply.mutate([...picked])}>
          {keys.length ? `Apply ${picked.size} change${picked.size === 1 ? '' : 's'}` : 'Mark as checked'}
        </Button>
      </>}>
      {error ? <ErrorState error={error} onRetry={load} title="FMCSA lookup failed" />
        : !preview ? <Loading label="Looking up FMCSA…" />
          : (
            <div className="space-y-4">
              <p className="text-sm text-fg-2">Source: {preview.sources.filter((s) => !s.includes(':error')).join(' + ')} · retrieved {new Date(preview.retrievedAt).toLocaleTimeString()}</p>
              {!keys.length ? <p className="text-sm">The FMCSA record matches this carrier. Nothing to change.</p> : (
                <div className="overflow-hidden rounded-lg border border-line">
                  <table className="w-full text-sm">
                    <thead className="bg-surface-2 text-left text-xs text-muted">
                      <tr><th className="w-10 px-3 py-2" /><th className="px-3 py-2 font-medium">Field</th><th className="px-3 py-2 font-medium">Now</th><th className="px-3 py-2 font-medium">FMCSA</th></tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {keys.map((k) => (
                        <tr key={k} className="cursor-pointer hover:bg-surface-2/60" onClick={() => toggle(k)}>
                          <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}><Checkbox aria-label={`Apply ${label(k)}`} checked={picked.has(k)} onChange={() => toggle(k)} /></td>
                          <td className="px-3 py-2 font-medium">{label(k)}</td>
                          <td className="px-3 py-2 text-muted">{show(preview.changes[k].from)}</td>
                          <td className="px-3 py-2">{show(preview.changes[k].to)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {preview.extra?.cargo?.length > 0 && <p className="text-xs text-muted">Cargo classes on file: {preview.extra.cargo.join(', ')}</p>}
            </div>
          )}
    </Modal>
  );
}
