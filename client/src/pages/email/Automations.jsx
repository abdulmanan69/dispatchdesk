import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Trash2, Workflow, Pencil } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useApiMutation } from '../../lib/hooks.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Modal, useConfirm } from '../../components/Modal.jsx';
import { Badge, Button, Card, DataTable, EmptyState, Field, Input, PageHeader, QueryState, Select, Switch } from '../../components/ui.jsx';
import { CALL_OUTCOMES, label, relative } from '../../lib/format.js';

const STAGES = [
  ['lead', 'All Leads'], ['prospecting', 'Prospecting'], ['sequence', 'Sequence'], ['opportunity', 'Opportunities'],
  ['trial', 'Trials'], ['customer', 'Customers'], ['archived', 'Archived'],
];
const stageName = (k) => STAGES.find((s) => s[0] === k)?.[1] || k;
const TRIGGERS = { carrier_created: 'A carrier is added', stage_changed: 'A carrier moves to stage', call_outcome: 'A call is logged with outcome' };
const ACTIONS = { create_follow_up: 'Create a follow-up', enroll_sequence: 'Enroll in sequence', move_stage: 'Move to stage', add_tag: 'Add tag', notify: 'Notify me' };

function describe(a) {
  const when = a.trigger === 'carrier_created' ? 'When a carrier is added'
    : a.trigger === 'stage_changed' ? `When a carrier moves to ${a.triggerValue ? stageName(a.triggerValue) : 'any stage'}`
      : `When a call outcome is ${a.triggerValue ? label(a.triggerValue) : 'anything'}`;
  const delay = a.delayDays ? ` (due in ${a.delayDays} day${a.delayDays > 1 ? 's' : ''})` : '';
  const then = {
    create_follow_up: `create a follow-up${a.actionValue ? `: "${a.actionValue}"` : ''}${delay}`,
    enroll_sequence: `enroll in "${a.actionLabel}"`,
    move_stage: `move to ${stageName(a.actionValue)}`,
    add_tag: `tag "${a.actionValue}"`,
    notify: `notify me: "${a.actionValue}"`,
  }[a.action];
  return `${when}, ${then}.`;
}

const EMPTY = { name: '', trigger: 'stage_changed', triggerValue: 'opportunity', action: 'create_follow_up', actionValue: '', delayDays: 1, active: true };

export default function Automations() {
  const { can } = useAuth();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null);
  const q = useQuery({ queryKey: ['automations'], queryFn: () => api.get('/api/automations'), enabled: can('automation.use') });
  const seqs = useQuery({ queryKey: ['sequences', 'options'], queryFn: () => api.get('/api/sequences'), enabled: can('automation.use') });
  const sequences = seqs.data?.items || (Array.isArray(seqs.data) ? seqs.data : []);
  const save = useApiMutation((a) => (a.id ? api.patch(`/api/automations/${a.id}`, a) : api.post('/api/automations', a)), {
    invalidate: [['automations']], success: 'Automation saved', onSuccess: () => setEditing(null),
  });
  const toggle = useApiMutation(({ id, active }) => api.patch(`/api/automations/${id}`, { active }), { invalidate: [['automations']] });
  const remove = useApiMutation((id) => api.del(`/api/automations/${id}`), { invalidate: [['automations']], success: 'Automation deleted' });

  if (!can('automation.use')) {
    return (<><PageHeader title="Automations" /><Card><EmptyState icon={Workflow} title="Automations are not included in your role">Ask an admin to upgrade your role to Dispatcher.</EmptyState></Card></>);
  }

  const set = (k) => (e) => setEditing({ ...editing, [k]: e.target.value });
  const setTrigger = (trigger) => setEditing({ ...editing, trigger, triggerValue: trigger === 'stage_changed' ? 'opportunity' : trigger === 'call_outcome' ? 'interested' : '' });
  const setAction = (action) => setEditing({ ...editing, action, actionValue: action === 'move_stage' ? 'prospecting' : action === 'enroll_sequence' ? sequences[0]?.id || '' : '' });

  return (
    <div>
      <PageHeader title="Automations" subtitle="Rules that run when carriers are added, change stage, or a call is logged."
        actions={<Button icon={Plus} onClick={() => setEditing({ ...EMPTY })}>New automation</Button>} />
      <Card bodyClass="p-0">
        <QueryState query={q} isEmpty={(d) => !d.items.length}
          empty={<EmptyState icon={Workflow} title="No automations yet" action={<Button icon={Plus} onClick={() => setEditing({ ...EMPTY })}>Create one</Button>}>Example: when a carrier moves to Opportunities, create a follow-up in 1 day to send the agreement.</EmptyState>}>
          {(d) => (
            <DataTable rows={d.items} onRowClick={(a) => setEditing({ ...a, triggerValue: a.triggerValue || '', actionValue: a.actionValue || '' })} columns={[
              { key: 'active', header: 'On', render: (a) => <div onClick={(e) => e.stopPropagation()}><Switch checked={a.active} onChange={(v) => toggle.mutate({ id: a.id, active: v })} /></div> },
              { key: 'name', header: 'Name', render: (a) => <span className="font-medium">{a.name}</span> },
              { key: 'rule', header: 'Rule', render: (a) => <span className="text-muted">{describe(a)}</span> },
              { key: 'runs', header: 'Runs', render: (a) => <span className="tabular">{a.runCount}</span> },
              { key: 'last', header: 'Last run', render: (a) => <span className="whitespace-nowrap text-muted">{a.lastRunAt ? relative(a.lastRunAt) : 'Never'}</span> },
              { key: 'x', header: '', className: 'text-right', render: (a) => (
                <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                  <Button size="sm" variant="ghost" icon={Pencil} aria-label="Edit" onClick={() => setEditing({ ...a, triggerValue: a.triggerValue || '', actionValue: a.actionValue || '' })} />
                  <Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete" onClick={async () => { if (await confirm({ title: `Delete "${a.name}"?`, message: 'The rule stops running immediately.', danger: true })) remove.mutate(a.id); }} />
                </div>
              ) },
            ]} />
          )}
        </QueryState>
      </Card>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={editing?.id ? 'Edit automation' : 'New automation'}
        footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button loading={save.isPending} onClick={() => save.mutate({ ...editing, delayDays: Number(editing.delayDays) || 0, triggerValue: editing.triggerValue || null, actionValue: editing.actionValue || null })}>Save</Button></>}>
        {editing && (
          <div className="space-y-3">
            <Field label="Name" required><Input value={editing.name} onChange={set('name')} placeholder="e.g. Opportunity follow-up" /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="When">
                <Select value={editing.trigger} onChange={(e) => setTrigger(e.target.value)}>
                  {Object.entries(TRIGGERS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              {editing.trigger === 'stage_changed' && (
                <Field label="Stage">
                  <Select value={editing.triggerValue} onChange={set('triggerValue')}>
                    <option value="">Any stage</option>
                    {STAGES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </Field>
              )}
              {editing.trigger === 'call_outcome' && (
                <Field label="Outcome">
                  <Select value={editing.triggerValue} onChange={set('triggerValue')}>
                    <option value="">Any outcome</option>
                    {CALL_OUTCOMES.map((o) => <option key={o} value={o}>{label(o)}</option>)}
                  </Select>
                </Field>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Then">
                <Select value={editing.action} onChange={(e) => setAction(e.target.value)}>
                  {Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </Select>
              </Field>
              {editing.action === 'move_stage' && (
                <Field label="Target stage">
                  <Select value={editing.actionValue} onChange={set('actionValue')}>
                    {STAGES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </Select>
                </Field>
              )}
              {editing.action === 'enroll_sequence' && (
                <Field label="Sequence" hint={!sequences.length ? 'Create a sequence first under Sequences.' : undefined}>
                  <Select value={editing.actionValue} onChange={set('actionValue')}>
                    <option value="">Choose…</option>
                    {sequences.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </Field>
              )}
              {editing.action === 'add_tag' && <Field label="Tag"><Input value={editing.actionValue} onChange={set('actionValue')} maxLength={40} /></Field>}
              {editing.action === 'notify' && <Field label="Notification text"><Input value={editing.actionValue} onChange={set('actionValue')} /></Field>}
              {editing.action === 'create_follow_up' && <Field label="Follow-up note"><Input value={editing.actionValue} onChange={set('actionValue')} placeholder="Optional" /></Field>}
            </div>
            {editing.action === 'create_follow_up' && (
              <Field label="Due after (days)"><Input type="number" min={0} max={365} value={editing.delayDays} onChange={set('delayDays')} className="w-32" /></Field>
            )}
            <Switch checked={editing.active} onChange={(v) => setEditing({ ...editing, active: v })} label="Active" />
            <p className="rounded-md bg-surface-2 px-3 py-2 text-sm text-muted">{describe({ ...editing, actionLabel: sequences.find((s) => s.id === editing.actionValue)?.name || 'sequence' })}</p>
            <Badge color="gray">Rules run for carriers in your own pipeline only.</Badge>
          </div>
        )}
      </Modal>
    </div>
  );
}
