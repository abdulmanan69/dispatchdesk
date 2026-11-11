import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Save, RotateCcw } from 'lucide-react';
import { dollars, label } from '../../lib/format.js';
import { Badge, Button, Card, Field, PageHeader } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';
import LoadFormModal, { CalcSummary, LoadFields, formCalc, formToFitLoad, loadToForm, parsedToForm, rateConNote } from '../../components/dispatch/LoadForm.jsx';
import RateConImport from '../../components/dispatch/RateConImport.jsx';
import FitCard from '../../components/dispatch/FitCard.jsx';
import { RateConVetting } from '../../components/dispatch/BrokerVetting.jsx';
import { CarrierPicker } from '../../components/dispatch/Pickers.jsx';

const START = loadToForm({ status: 'planned' });

export default function RateCalculator() {
  const [form, setForm] = useState(START);
  const [parsed, setParsed] = useState(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const toast = useToast();
  const navigate = useNavigate();
  const calc = useMemo(() => formCalc(form), [form]);
  const fitLoad = useMemo(() => formToFitLoad(form), [form]);

  const onParsed = ({ parsed: res }) => {
    setParsed(res);
    // Keep the user's own cost assumptions (fuel, MPG, fee) when applying parsed freight details.
    setForm((f) => ({ ...f, ...parsedToForm(res.fields), brokerId: f.brokerId || res.broker?.match?.id || null, notes: rateConNote(res.fields) || f.notes }));
    if (res.found.length) toast.success(`Filled ${res.found.length} field${res.found.length === 1 ? '' : 's'}. Check them before saving.`);
    else toast.info('No load details recognized. Fill the form by hand.');
  };

  const draft = useMemo(() => ({
    ...form,
    rateCents: form.rate ? Math.round(Number(form.rate) * 100) : null,
    detentionRateCents: form.detentionRate ? Math.round(Number(form.detentionRate) * 100) : null,
    otherCostsCents: form.otherCosts ? Math.round(Number(form.otherCosts) * 100) : null,
  }), [form]);

  const rpmTone = calc.ratePerMile == null ? 'gray' : calc.ratePerMile >= 2.5 ? 'green' : calc.ratePerMile >= 2 ? 'amber' : 'red';
  const f = parsed?.fields || {};

  return (
    <div>
      <PageHeader title="Rate calculator" subtitle="Rate per mile = total load rate ÷ loaded miles. Add deadhead, fuel and detention to see the real margin."
        actions={<>
          <Button variant="secondary" icon={RotateCcw} onClick={() => { setForm(START); setParsed(null); setResetKey((k) => k + 1); }}>Reset</Button>
          <Button icon={Save} onClick={() => setSaveOpen(true)} disabled={!form.loadedMiles || !form.rate}>Save as load</Button>
        </>} />

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-4">
          <Card title="Rate con or load details">
            <RateConImport key={resetKey} onParsed={onParsed} defaultPaste />
            {parsed && (
              <div className="mt-3 space-y-2 text-sm">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted">Recognized:</span>
                  {parsed.found.length ? parsed.found.map((k) => <Badge key={k} color="green">{label(k.replace(/Cents$/, ''))}</Badge>) : <span>nothing</span>}
                  {parsed.missing.map((k) => <Badge key={k} color="gray">{label(k.replace(/Cents$/, ''))} missing</Badge>)}
                </div>
                {(f.brokerName || f.brokerMc || f.referenceNumber) && (
                  <p className="text-xs text-muted">
                    {[f.brokerName && `Broker: ${f.brokerName}`, f.brokerMc && `MC ${f.brokerMc}`, f.brokerPhone, f.brokerEmail, f.referenceNumber && `Ref ${f.referenceNumber}`].filter(Boolean).join(' · ')}
                  </p>
                )}
                {f.postedRatePerMile != null && <p className="text-xs text-muted">Posted rate: {dollars(f.postedRatePerMile)}/mi</p>}
                {parsed.notes.map((n) => <p key={n} className="text-xs text-c-amber">{n}</p>)}
                {f.brokerMc && <RateConVetting mc={f.brokerMc} phone={f.brokerPhone} email={f.brokerEmail} brokerId={parsed.broker?.match?.id} initial={parsed.vetting} />}
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
          <Card title="Check against a carrier">
            <div className="space-y-3">
              <Field label="Carrier" hint="Pick a customer to see its rules and walk-away rate.">
                <CarrierPicker value={form.carrierId} onChange={(v) => setForm((x) => ({ ...x, carrierId: v }))} />
              </Field>
              <FitCard load={fitLoad} carrierId={form.carrierId} />
            </div>
          </Card>
          <Card title="Breakdown">
            <CalcSummary calc={calc} />
          </Card>
          <p className="text-xs text-muted">Results use only the numbers you enter and your own load history. No market or spot rates are estimated here.</p>
        </aside>
      </div>

      <LoadFormModal open={saveOpen} onClose={() => setSaveOpen(false)} initial={draft} onSaved={(l) => navigate(l?.id ? `/app/loads?load=${l.id}` : '/app/loads')} />
    </div>
  );
}
