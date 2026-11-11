import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { fromCents, toCents } from './calc.js';
import { US_STATES, PRESETS } from '../../lib/format.js';
import { Button, ComboInput, Field, Input, Select, Textarea } from '../ui.jsx';
import { Modal } from '../Modal.jsx';
import { useToast } from '../Toast.jsx';

const EMPTY = { companyName: '', contactName: '', email: '', phone: '', address: '', city: '', state: '', zip: '', mcNumber: '', dotNumber: '', paymentTerms: '', daysToPay: '', creditRating: '', creditLimit: '', notes: '' };

export default function BrokerFormModal({ open, onClose, broker, onSaved }) {
  const editing = !!broker?.id;
  const [f, setF] = useState(EMPTY);
  useEffect(() => {
    if (!open) return;
    const b = broker || {};
    setF({ ...EMPTY, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => k in EMPTY && v != null).map(([k, v]) => [k, String(v)])), creditLimit: fromCents(b.creditLimitCents) });
  }, [open, broker]);
  const toast = useToast();
  const save = useApiMutation(
    (body) => (editing ? api.patch(`/api/brokers/${broker.id}`, body) : api.post('/api/brokers', body)),
    {
      success: editing ? 'Broker updated' : 'Broker added', invalidate: [['brokers'], ['broker']],
      onSuccess: (d) => {
        // Same MC or USDOT already saved in the workspace: point to it (saving is never blocked).
        const dup = (d.duplicates || []).find((x) => x.id !== d.broker.id);
        if (dup) toast.info(`${dup.companyName} already has this MC or USDOT number.`, { action: { label: 'Open it', href: `/app/brokers/${dup.id}` } });
        onSaved?.(d.broker);
        onClose();
      },
    },
  );
  const on = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const submit = (e) => {
    e.preventDefault();
    const { creditLimit, ...rest } = f;
    save.mutate({ ...rest, creditLimitCents: toCents(creditLimit) });
  };
  return (
    <Modal open={open} onClose={onClose} title={editing ? 'Edit broker' : 'Add broker'} size="lg"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button type="submit" form="broker-form" loading={save.isPending}>{editing ? 'Save changes' : 'Add broker'}</Button></>}>
      <form id="broker-form" onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <Field label="Company name" required className="sm:col-span-2"><Input value={f.companyName} onChange={on('companyName')} required maxLength={200} /></Field>
        <Field label="Contact person"><Input value={f.contactName} onChange={on('contactName')} maxLength={120} /></Field>
        <Field label="Email"><Input type="email" value={f.email} onChange={on('email')} maxLength={254} /></Field>
        <Field label="Phone"><Input type="tel" value={f.phone} onChange={on('phone')} maxLength={40} /></Field>
        <Field label="MC number"><Input value={f.mcNumber} onChange={on('mcNumber')} inputMode="numeric" maxLength={12} /></Field>
        <Field label="USDOT number"><Input value={f.dotNumber} onChange={on('dotNumber')} inputMode="numeric" maxLength={12} /></Field>
        <Field label="Address"><Input value={f.address} onChange={on('address')} maxLength={200} /></Field>
        <Field label="City"><Input value={f.city} onChange={on('city')} maxLength={100} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="State"><Select value={f.state} onChange={on('state')}><option value="">—</option>{US_STATES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
          <Field label="ZIP"><Input value={f.zip} onChange={on('zip')} maxLength={12} /></Field>
        </div>
        <Field label="Payment terms" hint="Pick a common term or type your own"><ComboInput options={PRESETS.paymentTerms} value={f.paymentTerms} onChange={on('paymentTerms')} maxLength={120} /></Field>
        <Field label="Days to pay"><Input type="number" min="0" max="365" value={f.daysToPay} onChange={on('daysToPay')} /></Field>
        <Field label="Credit rating" hint="From your factoring company or credit service"><ComboInput options={PRESETS.creditRating} value={f.creditRating} onChange={on('creditRating')} maxLength={40} /></Field>
        <Field label="Credit limit ($)"><Input type="number" min="0" step="1" value={f.creditLimit} onChange={on('creditLimit')} /></Field>
        <Field label="Notes" className="sm:col-span-2"><Textarea rows={3} value={f.notes} onChange={on('notes')} maxLength={5000} /></Field>
      </form>
    </Modal>
  );
}
