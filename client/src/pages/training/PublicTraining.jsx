import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, GraduationCap, PhoneCall, Users, MessageCircle } from 'lucide-react';
import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { Button, Field, Input, Textarea, QueryState, EmptyState } from '../../components/ui.jsx';
import { CourseCard } from '../../components/training/CourseCard.jsx';

const PHASES = [
  { icon: GraduationCap, title: 'Weeks 1–2 · Learn', body: 'Live virtual classes covering how freight moves, carrier authority, equipment, load boards and the structure of a sales call.' },
  { icon: PhoneCall, title: 'Weeks 3–4 · Dial', body: 'You call real carriers from your own pipeline while a trainer reviews your calls, notes and follow-ups with you.' },
  { icon: Users, title: 'After your first signed carrier', body: 'Keep learning with the community, the course library and trainer messaging while you grow your book of customers.' },
];

const STEPS = [
  'Learn the basics of freight, authority and equipment',
  'Find and sign your first carrier',
  'Only then subscribe to a load board',
  'Negotiate loads for your carrier',
  'Complete the carrier packet with the broker',
  'Review and sign the rate confirmation',
  'Track pickup and the bill of lading',
  'Track delivery and the proof of delivery',
  'Close the load and get paid',
];

function BookingForm() {
  const { user } = useAuth();
  const [form, setForm] = useState({ name: user?.name || '', email: user?.email || '', phone: user?.phone || '', message: '' });
  const [state, setState] = useState({ busy: false, done: null, error: null });
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e) => {
    e.preventDefault();
    setState({ busy: true, done: null, error: null });
    try {
      const res = await api.post('/api/training/requests', form);
      setState({ busy: false, done: res.message, error: null });
    } catch (err) {
      setState({ busy: false, done: null, error: err.message });
    }
  };

  if (state.done) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 p-5 text-sm text-green-900 dark:border-green-900 dark:bg-green-950/40 dark:text-green-200" role="status">
        <p className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-4" />Request received</p>
        <p className="mt-1">{state.done}</p>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-3">
      <Field label="Full name" required><Input value={form.name} onChange={set('name')} maxLength={120} required autoComplete="name" /></Field>
      <Field label="Email" required><Input type="email" value={form.email} onChange={set('email')} required autoComplete="email" /></Field>
      <Field label="Phone" hint="Include your country code."><Input type="tel" value={form.phone} onChange={set('phone')} maxLength={40} autoComplete="tel" /></Field>
      <Field label="Anything we should know?"><Textarea rows={3} value={form.message} onChange={set('message')} maxLength={2000} /></Field>
      {state.error && <p className="text-sm text-red-600" role="alert">{state.error}</p>}
      <Button type="submit" loading={state.busy} className="w-full">Request a seat</Button>
      <p className="text-xs text-muted">Submitting saves your interest only — it does not reserve a seat or take payment. A trainer will contact you about the next batch.</p>
    </form>
  );
}

export default function PublicTraining() {
  const { user } = useAuth();
  const courses = useQuery({ queryKey: ['training', 'courses', 'public', !!user], queryFn: () => api.get('/api/training/courses') });

  return (
    <div>
      <section className="border-b border-line bg-surface">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 md:grid-cols-[1.3fr_1fr] md:py-20">
          <div>
            <p className="text-sm font-medium text-brand-700 dark:text-brand-300">Dispatch training</p>
            <h1 className="mt-2 text-3xl font-medium tracking-[-0.01em] sm:text-4xl">Learn to dispatch, then learn to sell it</h1>
            <p className="mt-4 max-w-xl text-muted">A four-week program: two weeks of live instruction on how dispatching works, then two weeks on the phone with real carriers while a trainer coaches you. The full course library is included with your account.</p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Button href="#book" size="lg">Book your seat</Button>
              <Button to={user ? '/app/training' : '/register'} variant="secondary" size="lg">{user ? 'Open course library' : 'Create a free account'}</Button>
            </div>
          </div>
          <ol className="space-y-4">
            {PHASES.map((p) => (
              <li key={p.title} className="flex gap-3 rounded-lg border border-line bg-bg p-4">
                <p.icon className="mt-0.5 size-5 shrink-0 text-brand-600" aria-hidden />
                <div>
                  <h2 className="text-sm font-medium">{p.title}</h2>
                  <p className="mt-0.5 text-sm text-muted">{p.body}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-14">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-medium tracking-[-0.01em]">Course library</h2>
            <p className="mt-1 text-sm text-muted">Self-paced lessons you can start today with a free account.</p>
          </div>
        </div>
        <QueryState query={courses} isEmpty={(d) => !d.items.length} empty={<EmptyState icon={GraduationCap} title="No courses published yet" />}>
          {(d) => (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {d.items.map((c) => <CourseCard key={c.id} course={c} to={user ? `/app/training/${c.slug}` : `/register?next=${encodeURIComponent(`/app/training/${c.slug}`)}`} />)}
            </div>
          )}
        </QueryState>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 md:grid-cols-2">
          <div>
            <h2 className="text-xl font-medium tracking-[-0.01em]">Start here: from zero to your first paid load</h2>
            <ol className="mt-5 space-y-2.5">
              {STEPS.map((s, i) => (
                <li key={s} className="flex items-start gap-3 text-sm">
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-brand-600/10 text-xs font-medium tabular text-brand-700 dark:text-brand-300">{i + 1}</span>
                  <span className="pt-0.5">{s}</span>
                </li>
              ))}
            </ol>
            <div className="mt-6 flex items-start gap-3 rounded-lg border border-line bg-bg p-4 text-sm">
              <MessageCircle className="mt-0.5 size-4 shrink-0 text-brand-600" aria-hidden />
              <p className="text-muted">Signed-in members can message a trainer from the Training section of the app. Replies appear in your dashboard notifications.</p>
            </div>
          </div>
          <div id="book" className="scroll-mt-20 rounded-lg border border-line bg-bg p-5">
            <h2 className="text-lg font-medium">Book your seat in the next batch</h2>
            <p className="mb-4 mt-1 text-sm text-muted">Tell us how to reach you. Batch dates and pricing are confirmed by a trainer before you pay anything.</p>
            <BookingForm />
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-4 py-14 text-center">
        <h2 className="text-xl font-medium tracking-[-0.01em]">Already dispatching?</h2>
        <p className="mt-2 text-muted">Use the course library to train new team members and track their progress lesson by lesson.</p>
        <div className="mt-5"><Link to="/pricing" className="text-sm font-medium text-brand-700 hover:underline dark:text-brand-300">Compare plans</Link></div>
      </section>
    </div>
  );
}
