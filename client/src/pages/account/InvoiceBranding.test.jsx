import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ get: vi.fn(), upload: vi.fn(), del: vi.fn(), patch: vi.fn(), post: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
const confirm = vi.hoisted(() => vi.fn());
vi.mock('../../lib/api.js', () => ({ api }));
vi.mock('../../components/Toast.jsx', () => ({ useToast: () => toast }));
vi.mock('../../components/Modal.jsx', () => ({ Modal: () => null, useConfirm: () => confirm }));
vi.mock('../../context/AuthContext.jsx', () => ({
  useAuth: () => ({ user: { id: 'u1', name: 'Dana Ruiz', email: 'dana@example.test', timezone: 'America/Chicago', companyName: 'Acme Dispatch', team: null, roleName: 'Dispatcher' }, setUser: vi.fn() }),
}));
vi.mock('../../context/push.js', () => ({ pushSupport: () => ({}), enablePush: vi.fn(), disablePush: vi.fn(), currentSubscription: vi.fn(async () => null), thisDeviceId: () => null, deviceLabel: () => '' }));
vi.mock('../../components/settings/SecurityPanel.jsx', () => ({ default: () => null }));
vi.mock('../../components/calling/CallingSettings.jsx', () => ({ default: () => null }));

const { default: Settings } = await import('./Settings.jsx');

function renderIt() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter initialEntries={['/app/settings?tab=profile']}><Settings /></MemoryRouter></QueryClientProvider>);
}
const notFound = () => Object.assign(new Error('No invoice logo'), { status: 404 });
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const chooseFile = (file) => fireEvent.change(screen.getByLabelText('Choose a logo file'), { target: { files: [file] } });

beforeEach(() => {
  for (const fn of [...Object.values(api), ...Object.values(toast), confirm]) fn.mockReset();
});

describe('Invoice branding card', () => {
  it('offers an upload when there is no logo and shows the company name', async () => {
    api.get.mockRejectedValue(notFound());
    renderIt();
    expect(await screen.findByText('Drop your logo here or choose a file')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload logo' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
    expect(screen.getByText('Acme Dispatch')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/api/settings/invoice-logo', undefined, expect.objectContaining({ raw: true }));
  });

  it('previews the current logo and removes it after confirmation', async () => {
    api.get.mockResolvedValue({ blob: async () => new Blob([PNG], { type: 'image/png' }) });
    api.del.mockResolvedValue({ ok: true });
    confirm.mockResolvedValue(true);
    renderIt();
    const img = await screen.findByAltText('Acme Dispatch logo');
    expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    expect(screen.getByRole('button', { name: 'Replace logo' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith('/api/settings/invoice-logo'));
    expect(await screen.findByText('Drop your logo here or choose a file')).toBeInTheDocument();
  });

  it('refuses SVG and large files before uploading, and uploads a PNG', async () => {
    api.get.mockRejectedValue(notFound());
    api.upload.mockResolvedValue({ invoiceLogo: { type: 'image/png', width: 1, height: 1, sizeBytes: 8 } });
    renderIt();
    await screen.findByText('Drop your logo here or choose a file');
    chooseFile(new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }));
    expect(toast.error).toHaveBeenLastCalledWith(expect.stringMatching(/SVG logos are not supported/));
    chooseFile(new File([new Uint8Array(500 * 1024 + 1)], 'big.png', { type: 'image/png' }));
    expect(toast.error).toHaveBeenLastCalledWith('Choose an image under 500 KB');
    chooseFile(new File(['GIF89a'], 'logo.gif', { type: 'image/gif' }));
    expect(toast.error).toHaveBeenLastCalledWith('Choose a PNG or JPEG image');
    expect(api.upload).not.toHaveBeenCalled();

    chooseFile(new File([PNG], 'logo.png', { type: 'image/png' }));
    await waitFor(() => expect(api.upload).toHaveBeenCalledTimes(1));
    const [url, body] = api.upload.mock.calls[0];
    expect(url).toBe('/api/settings/invoice-logo');
    expect(body.get('file').name).toBe('logo.png');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Logo saved'));
  });
});
