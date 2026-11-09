import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { ClipboardPaste, Save, RotateCcw, Info } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { dollars, label } from '../../lib/format.js';
import { Badge, Button, Card, PageHeader, Textarea } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';
import LoadFormModal, { CalcSummary, LoadFields, formCalc, loadToForm } from '../../components/dispatch/LoadForm.jsx';

const START = loadToForm({ status: 'planned' });

export default function RateCalculator() {
  const [form, setForm] = useState(START);
  const [text, setText] = useState('');
  const [parsed, setParsed] = useState(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const toast = useToast();
  const navigate = useNavigate();
  const calc = useMemo(() => formCalc(form), [form]);

  const parse = useApiMutation((t) => api.post('/api/loads/parse', { text: t }), {
    onSuccess: (res) => {
      setParsed(res);
      const next = loadToForm({ ...res.fields });
      // Keep the user's own cost assumptions (fuel, MPG, fee) when applying parsed freight details.
      setForm((f) => ({ ...f, ...Object.fromEntries(Object.entries(next).filter(([k, v]) => v !== '' && v != null && k !== 'status')) }));
      if (res.found.length) toast.success(`Filled ${res.found.length} field${res.found.length === 1 ? '' : 's'} from pasted text`);
      else toast.info('No load details recognised — fill the form manually.');
    },
  });

  const draft = useMemo(() => ({
    ...form,
    rateCents: form.rate ? Math.round(Number(form.rate) * 100) : null,
    detentionRateCents: form.detentionRate ? Math.round(Number(form.detentionRate) * 100) : null,
    otherCostsCents: form.otherCosts ? Math.round(Number(form.otherCosts) * 100) : null,
  }), [form]);

  const rpmTone = calc.ratePerMile == null ? 'gray' : calc.ratePerMile >= 2.5 ? 'green' : calc.ratePerMile >= 2 ? 'amber' : 'red';

  return (
    <div>
      <PageHeader title="Rate calculator" subtitle="Rate per mile = total load rate ÷ loaded miles. Add deadhead, fuel and detention to see the real margin."
        actions={<>
          <Button variant="secondary" icon={RotateCcw} onClick={() => { setForm(START); setParsed(null); setText(''); }}>Reset</Button>
          <Button icon={Save} onClick={() => setSaveOpen(true)} disabled={!form.loadedMiles || !form.rate}>Save as load</Button>
        </>} />

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Card title="Paste load details" actions={<Button size="sm" variant="secondary" icon={ClipboardPaste} loading={parse.isPending} disabled={text.trim().length < 5} onClick={() => parse.mutate(text)}>Parse</Button>}>
            <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} aria-label="Pasted load details"
              placeholder={'e.g.\nDallas, TX → Atlanta, GA  11/12  Van  42,000 lbs  781 mi  $2,350  DH-O 35\nBroker: Summit Logistics MC# 123456'} />
            <p className="mt-2 flex items-start gap-1.5 text-xs text-muted">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Paste text you can already see in your own DAT, Truckstop or broker email. Nothing is fetched from load boards — parsing happens on our server with fixed rules.
            </p>
            {parsed && (
              <div className="mt-3 space-y-1.5 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted">Recognised:</span>
                  {parsed.found.length ? parsed.found.map((k) => <Badge key={k} color="green">{label(k.replace(/Cents$/, ''))}</Badge>) : <span>nothing</span>}
                  {parsed.missing.map((k) => <Badge key={k} color="gray">{label(k.replace(/Cents$/, ''))} missing</Badge>)}
                </div>
                {(parsed.fields.brokerName || parsed.fields.brokerMc || parsed.fields.referenceNumber) && (
                  <p className="text-xs text-muted">
                    {[parsed.fields.brokerName && `Broker: ${parsed.fields.brokerName}`, parsed.fields.brokerMc && `MC ${parsed.fields.brokerMc}`, parsed.fields.brokerPhone, parsed.fields.brokerEmail, parsed.fields.referenceNumber && `Ref ${parsed.fields.referenceNumber}`].filter(Boolean).join(' · ')}
                  </p>
                )}
                {parsed.fields.postedRatePerMile != null && <p className="text-xs text-muted">Posted rate: {dollars(parsed.fields.postedRatePerMile)}/mi</p>}
                {parsed.notes.map((n) => <p key={n} className="text-xs text-amber-700 dark:text-amber-300">{n}</p>)}
              </div>
            )}
          </Card>
          <Card title="Load details">
            <LoadFields form={form} set={setForm} />
          </Card>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-4 lg:h-fit">
          <div className="rounded-xl border border-line bg-surface p-4">
            <p className="text-[13px] text-muted">Rate per mile</p>
            <p className="mt-1 text-4xl font-medium tabular tracking-tight">{calc.ratePerMile != null ? dollars(calc.ratePerMile) : '—'}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge color={rpmTone}>{calc.ratePerMile == null ? 'Enter rate and miles' : `${dollars(form.rate ? Number(form.rate) : 0, 0)} ÷ ${form.loadedMiles || 0} mi`}</Badge>
              {calc.allInRatePerMile != null && calc.allInRatePerMile !== calc.ratePerMile && <Badge color="gray">All-in {dollars(calc.allInRatePerMile)}/mi</Badge>}
            </div>
          </div>
          <Card title="Breakdown">
            <CalcSummary calc={calc} />
          </Card>
          <p className="text-xs text-muted">Results use only the numbers you enter. No market or spot rates are estimated here.</p>
        </aside>
      </div>

      <LoadFormModal open={saveOpen} onClose={() => setSaveOpen(false)} initial={draft} onSaved={() => navigate('/app/loads')} />
    </div>
  );
}
