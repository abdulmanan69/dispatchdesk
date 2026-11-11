import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const post = vi.fn();
const dial = vi.fn();
const confirm = vi.fn();
const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
vi.mock('../../lib/api.js', () => ({ api: { post: (...a) => post(...a) } }));
vi.mock('../Modal.jsx', () => ({ useConfirm: () => confirm }));
vi.mock('../Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('../calling/useDialer.js', () => ({
  useDialer: () => ({ dial, reset: vi.fn(), attempt: null, mode: null, dialing: false, autoOpenLog: true, isFinal: false }),
}));
vi.mock('./LogCallModal.jsx', () => ({ default: () => null }));
vi.mock('../calling/CallButton.jsx', () => ({ default: ({ carrierId }) => <span>call {carrierId}</span> }));

const { default: SaveAndCall, claimText } = await import('./SaveAndCall.jsx');

const lead = { dotNumber: '8100003', phone: '6145550103', companyName: 'Fresh Authority LLC', existsInCrm: false, existingId: null, teamClaims: [] };
function renderIt(record) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}><SaveAndCall record={record} /></QueryClientProvider>);
}

beforeEach(() => { post.mockReset(); dial.mockReset(); confirm.mockReset(); Object.values(toast).forEach((f) => f.mockReset()); });

describe('SaveAndCall', () => {
  it('saves an unsaved lead first, then dials with the new carrier id', async () => {
    post.mockResolvedValue({ items: [{ dotNumber: '8100003', id: 'c-new', status: 'created' }] });
    dial.mockResolvedValue({ mode: 'link', attempt: { id: 'a1', carrier: null } });
    renderIt(lead);
    fireEvent.click(screen.getByText('(614) 555-0103'));
    await waitFor(() => expect(dial).toHaveBeenCalledWith({ carrierId: 'c-new', phone: '6145550103' }));
    expect(post).toHaveBeenCalledWith('/api/discovery/save', { dotNumbers: ['8100003'] });
    expect(toast.success).toHaveBeenCalledWith('Saved Fresh Authority LLC to your list');
  });

  it('does not dial when the plan limit stopped the save', async () => {
    post.mockResolvedValue({ items: [{ dotNumber: '8100003', id: null, status: 'limited' }] });
    renderIt(lead);
    fireEvent.click(screen.getByText('(614) 555-0103'));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(dial).not.toHaveBeenCalled();
  });

  it('asks before calling a carrier a teammate already has, and stops when declined', async () => {
    confirm.mockResolvedValue(false);
    renderIt({ ...lead, teamClaims: [{ ownerName: 'Tina', lastContactedAt: null, stage: { name: 'Prospecting' } }] });
    fireEvent.click(screen.getByText('(614) 555-0103'));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(confirm.mock.calls[0][0].message).toMatch(/Tina already has this carrier \(Prospecting, not contacted yet\)/);
    expect(post).not.toHaveBeenCalled();
  });

  it('uses the normal call button for carriers already in the CRM', () => {
    renderIt({ ...lead, existsInCrm: true, existingId: 'c-1' });
    expect(screen.getByText('call c-1')).toBeInTheDocument();
  });

  it('describes several claims', () => {
    expect(claimText([{ ownerName: 'Ana', assignedToName: 'Bo', stage: null, lastContactedAt: null }, { ownerName: 'Cy' }]))
      .toBe('Ana (assigned to Bo) and 1 more teammate already have this carrier (not contacted yet).');
  });
});
