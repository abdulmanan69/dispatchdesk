import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
vi.mock('../Toast.jsx', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));

const { default: ManualPayModal, walletAddress } = await import('./ManualPayModal.jsx');

const TRON = 'TSC2NNs2e7aGYNy6FYfp61jgFVZBz3eYYp';
const claim = { id: 'c1', reference: 'DD-ABC234', status: 'awaiting', planName: 'Pro', seats: 1, months: 1, amountCents: 999, currency: 'usd' };
const methods = [
  { key: 'bank', label: 'Bank wire (SWIFT)', details: 'IBAN: PK00TEST0000000000000000' },
  { key: 'usdt', label: 'USDT (crypto)', details: `Network: TRON (TRC20) only\nAddress: ${TRON}` },
];
const wrap = (ui) => render(<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>);

describe('ManualPayModal', () => {
  it('finds TRON and EVM wallet addresses in the payment details', () => {
    expect(walletAddress(`Address: ${TRON}\nSend TRC20 only`)).toBe(TRON);
    expect(walletAddress('ERC20: 0x52908400098527886E0F7030069857D2E4169EE7')).toBe('0x52908400098527886E0F7030069857D2E4169EE7');
    expect(walletAddress('IBAN: PK31MSHQ0000089200105897\nSWIFT: MSHQPKKK')).toBeNull();
  });

  it('shows a QR code of the wallet address for USDT and none for the bank wire', async () => {
    wrap(<ManualPayModal claim={claim} methods={methods} onClose={() => {}} />);
    expect(screen.queryByAltText(/QR code/)).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'USDT (crypto)' }));
    const img = await screen.findByAltText(`QR code of wallet address ${TRON}`);
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByRole('button', { name: 'Copy address' })).toBeInTheDocument();
  });

  it('asks for the exact USDT amount that confirms the payment by itself', () => {
    wrap(<ManualPayModal claim={{ ...claim, cryptoAmount: '9.990317' }} methods={methods} onClose={() => {}} />);
    expect(screen.queryByText(/Send exactly/)).toBeNull(); // bank wire selected
    fireEvent.click(screen.getByRole('tab', { name: 'USDT (crypto)' }));
    expect(screen.getByText('Send exactly')).toBeInTheDocument();
    expect(screen.getByText(/9\.990317 USDT/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy USDT amount' })).toBeInTheDocument();
  });
});
