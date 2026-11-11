import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { strokesToPath, hasInk, MAX_PATH_CHARS } from './signaturePad.js';
import CarrierOnboarding from './CarrierOnboarding.jsx';

// The server accepts only absolute M/L/Q/C/Z commands with numbers inside 600 x 200.
const VALID = /^(?:[MLQCZ]|-?\d+(?:\.\d+)?|[\s,])+$/;

describe('signature pad export', () => {
  it('scales normalized strokes into the 600 x 200 box as compact M/L path data', () => {
    const d = strokesToPath([[{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }], [{ x: 0.25, y: 0.75 }]]);
    expect(d).toBe('M0 0L300 100L600 200M150 150L150 150');
    expect(d).toMatch(VALID);
    expect(strokesToPath([])).toBe('');
    expect(strokesToPath([[]])).toBe('');
  });

  it('clamps points outside the pad and stays under the size limit', () => {
    expect(strokesToPath([[{ x: -1, y: 2 }, { x: 0.1234, y: 0.5 }]])).toBe('M0 200L74 100');
    const long = Array.from({ length: 30 }, (_, s) => Array.from({ length: 800 }, (_, i) => ({ x: (i % 400) / 400 + Math.random() * 0.001, y: (s / 30) + Math.random() * 0.01 })));
    const d = strokesToPath(long);
    expect(d.length).toBeGreaterThan(0);
    expect(d.length).toBeLessThanOrEqual(MAX_PATH_CHARS);
    expect(d).toMatch(VALID);
  });

  it('needs some ink to count as a signature', () => {
    expect(hasInk([[{ x: 0.1, y: 0.1 }]])).toBe(false);
    expect(hasInk([[{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.1 }]])).toBe(true);
  });
});

const PAGE = {
  state: 'pending',
  carrier: { companyName: 'Cedar Creek Carriers' },
  dispatcher: { name: 'Lena Park', company: 'Park Dispatch LLC' },
  agreement: { title: 'Dispatch service agreement', body: 'This dispatch service agreement is made between the parties.', hash: 'a'.repeat(64) },
  feePercent: '7',
  requestedDocs: [{ kind: 'w9', label: 'W-9', uploaded: 0 }],
  uploads: { open: true, closesAt: new Date(Date.now() + 86400000 * 7).toISOString(), maxFiles: 12, used: 0, maxMb: 15, types: ['pdf', 'jpg', 'png'] },
  consentAt: null,
  signedAt: null,
  signerName: null,
  expiresAt: new Date(Date.now() + 86400000 * 14).toISOString(),
};

const json = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/onboard/tok_abcdefghijklmnopqrstuvwxyz']}>
      <Routes><Route path="/onboard/:token" element={<CarrierOnboarding />} /></Routes>
    </MemoryRouter>,
  );
}

describe('CarrierOnboarding page', () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    window.scrollTo = vi.fn();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows a friendly message for a turned-off link', async () => {
    fetchMock.mockReturnValueOnce(json(410, { error: 'This onboarding link was turned off by your dispatcher.', code: 'REVOKED' }));
    renderPage();
    expect(await screen.findByText('This link was turned off')).toBeInTheDocument();
    expect(screen.getByText(/turned off by your dispatcher/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /sign agreement/i })).toBeNull();
  });

  it('records consent, signs with the typed name and the agreement hash, then asks for documents', async () => {
    fetchMock.mockImplementation((url, opts = {}) => {
      if (url.endsWith('/consent')) return json(200, { consentAt: new Date().toISOString() });
      if (url.endsWith('/sign')) return json(200, { ...PAGE, state: 'signed', signedAt: new Date().toISOString(), signerName: 'Maria Lopez', consentAt: new Date().toISOString() });
      if (url.endsWith('/documents')) return json(201, { document: { id: 'd1', kind: 'w9' }, ...PAGE, state: 'signed', signedAt: new Date().toISOString(), signerName: 'Maria Lopez', requestedDocs: [{ kind: 'w9', label: 'W-9', uploaded: 1 }], uploads: { ...PAGE.uploads, used: 1 } });
      if (!opts.method || opts.method === 'GET') return json(200, PAGE);
      return json(500, {});
    });
    renderPage();
    expect(await screen.findByText(/made between the parties/)).toBeInTheDocument();
    expect(screen.getByText('For Cedar Creek Carriers')).toBeInTheDocument();
    const signBtn = screen.getByRole('button', { name: /sign agreement/i });
    expect(signBtn).toBeDisabled();

    fireEvent.click(screen.getByLabelText(/electronic records and signatures/i));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/public/onboarding/tok_abcdefghijklmnopqrstuvwxyz/consent', expect.objectContaining({ method: 'POST', credentials: 'omit' })));

    fireEvent.change(screen.getByLabelText(/full name/i), { target: { value: 'Maria Lopez' } });
    fireEvent.change(screen.getByLabelText(/^title/i), { target: { value: 'Owner' } });
    fireEvent.change(screen.getByLabelText(/^email/i), { target: { value: 'maria@cedar.test' } });
    expect(screen.getByLabelText(/type your name to sign/i)).toHaveValue('Maria Lopez');
    expect(signBtn).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/I have read the agreement/i));
    await waitFor(() => expect(signBtn).toBeEnabled());
    fireEvent.click(signBtn);

    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u.endsWith('/sign'))).toBe(true));
    const [, opts] = fetchMock.mock.calls.find(([u]) => u.endsWith('/sign'));
    expect(JSON.parse(opts.body)).toEqual({
      signerName: 'Maria Lopez', signerTitle: 'Owner', signerEmail: 'maria@cedar.test', signatureType: 'typed', signatureData: 'Maria Lopez', agreementHash: 'a'.repeat(64), agree: true,
    });
    expect(await screen.findByText('Upload your documents')).toBeInTheDocument();

    const file = new File(['%PDF-1.4'], 'w9.pdf', { type: 'application/pdf' });
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u.endsWith('/documents'))).toBe(true));
    const [, up] = fetchMock.mock.calls.find(([u]) => u.endsWith('/documents'));
    expect(up.body.get('type')).toBe('w9');
    expect(up.body.get('file').name).toBe('w9.pdf');
    expect(await screen.findByText('Uploaded')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Finish' }));
    expect(await screen.findByText('Agreement signed')).toBeInTheDocument();
  });

  it('refuses files over 15 MB before sending them', async () => {
    fetchMock.mockReturnValue(json(200, { ...PAGE, state: 'signed', signedAt: new Date().toISOString(), signerName: 'Maria Lopez' }));
    renderPage();
    expect(await screen.findByText('Upload your documents')).toBeInTheDocument();
    const big = new File(['x'], 'w9.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: 16 * 1024 * 1024 });
    fireEvent.change(document.querySelector('input[type="file"]'), { target: { files: [big] } });
    expect(await screen.findByText(/larger than 15 MB/)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
