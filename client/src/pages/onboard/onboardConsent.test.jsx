import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import CarrierOnboarding from './CarrierOnboarding.jsx';

const BEFORE = 'I agree that Park Dispatch LLC may call and text me at ';
const AFTER = ', including calls and texts sent with automated technology, about available loads. My consent is not a condition of buying or using their services. I can opt out at any time by replying STOP to a text.';
const PAGE = {
  state: 'pending',
  carrier: { companyName: 'Cedar Creek Carriers' },
  dispatcher: { name: 'Lena Park', company: 'Park Dispatch LLC' },
  agreement: { title: 'Dispatch service agreement', body: 'This dispatch service agreement is made between the parties.', hash: 'a'.repeat(64) },
  feePercent: '7',
  requestedDocs: [],
  uploads: { open: true, closesAt: new Date(Date.now() + 86400000 * 7).toISOString(), maxFiles: 12, used: 0, maxMb: 15, types: ['pdf', 'jpg', 'png'] },
  consentAt: new Date().toISOString(),
  signedAt: null,
  signerName: null,
  expiresAt: new Date(Date.now() + 86400000 * 14).toISOString(),
  contactConsent: { asked: true, phone: '2145550188', before: BEFORE, after: AFTER },
};
const SIGNED = { ...PAGE, state: 'signed', signedAt: new Date().toISOString(), signerName: 'Maria Lopez', contactConsent: { asked: true, given: null } };

const json = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/onboard/tok_abcdefghijklmnopqrstuvwxyz']}>
      <Routes><Route path="/onboard/:token" element={<CarrierOnboarding />} /></Routes>
    </MemoryRouter>,
  );
}

async function fillAndAgree() {
  expect(await screen.findByText(/made between the parties/)).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Maria Lopez' } });
  fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: 'Owner' } });
  fireEvent.change(screen.getByLabelText(/^email/i), { target: { value: 'maria@cedar.test' } });
  fireEvent.click(screen.getByLabelText(/I have read the agreement/i));
}
const signCall = (fetchMock) => fetchMock.mock.calls.find(([u]) => u.endsWith('/sign'));

describe('CarrierOnboarding calls and texts consent', () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn((url, opts = {}) => {
      if (url.endsWith('/sign')) return json(200, SIGNED);
      if (!opts.method || opts.method === 'GET') return json(200, PAGE);
      return json(500, {});
    });
    vi.stubGlobal('fetch', fetchMock);
    window.scrollTo = vi.fn();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('is optional: signing works with the box unticked and sends no consent', async () => {
    renderPage();
    await fillAndAgree();
    expect(screen.getByText('Optional')).toBeInTheDocument();
    expect(screen.getByLabelText(/phone number for calls and texts/i)).toHaveValue('(214) 555-0188');
    const box = screen.getByLabelText(/may call and text me at \(214\) 555-0188/);
    expect(box).not.toBeChecked();
    const signBtn = screen.getByRole('button', { name: /sign agreement/i });
    await waitFor(() => expect(signBtn).toBeEnabled());
    fireEvent.click(signBtn);
    await waitFor(() => expect(signCall(fetchMock)).toBeTruthy());
    expect(JSON.parse(signCall(fetchMock)[1].body)).not.toHaveProperty('contactConsent');
    expect(await screen.findByText('Agreement signed')).toBeInTheDocument();
  });

  it('sends the exact text shown for the number typed, and blocks an invalid number while ticked', async () => {
    renderPage();
    await fillAndAgree();
    const phone = screen.getByLabelText(/phone number for calls and texts/i);
    fireEvent.change(phone, { target: { value: '555-01' } });
    fireEvent.click(screen.getByLabelText(/may call and text me at/));
    expect(await screen.findByText(/Enter a 10-digit US phone number, or untick the box/)).toBeInTheDocument();
    const signBtn = screen.getByRole('button', { name: /sign agreement/i });
    expect(signBtn).toBeDisabled();
    fireEvent.change(phone, { target: { value: '+1 972 555 0123' } });
    await waitFor(() => expect(signBtn).toBeEnabled());
    expect(screen.getByLabelText(/may call and text me at \(972\) 555-0123/)).toBeChecked();
    fireEvent.click(signBtn);
    await waitFor(() => expect(signCall(fetchMock)).toBeTruthy());
    expect(JSON.parse(signCall(fetchMock)[1].body).contactConsent).toEqual({ agree: true, phone: '9725550123', text: `${BEFORE}(972) 555-0123${AFTER}` });
  });

  it('pages without the option show no consent box', async () => {
    fetchMock.mockImplementation(() => json(200, { ...PAGE, contactConsent: undefined }));
    renderPage();
    expect(await screen.findByText(/made between the parties/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/phone number for calls and texts/i)).toBeNull();
    expect(screen.queryByText('Optional')).toBeNull();
  });

  it('the done page repeats what was agreed and how to opt out', async () => {
    fetchMock.mockImplementation(() => json(200, { ...SIGNED, contactConsent: { asked: true, given: { phone: '(214) 555-0188', at: new Date().toISOString(), revoked: false } } }));
    renderPage();
    expect(await screen.findByText(/You agreed that Park Dispatch LLC may call and text you at \(214\) 555-0188/)).toBeInTheDocument();
    expect(screen.getByText(/reply STOP to a text/)).toBeInTheDocument();
  });
});
