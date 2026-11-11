import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

const api = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../lib/api.js', () => ({ api }));
const pdf = vi.hoisted(() => ({ MAX_TEXT: 20000, pdfToText: vi.fn(), pdfPageImages: vi.fn() }));
vi.mock('./pdfText.js', () => pdf);

// tesseract.js, mocked: each recognize() waits for the test to release it, and reports progress like the real worker.
const tess = vi.hoisted(() => ({ createWorker: null, workers: [], pending: [], logger: null }));
vi.mock('tesseract.js', () => ({ createWorker: (...args) => tess.createWorker(...args) }));
const { default: RateConImport } = await import('./RateConImport.jsx');

const PARSED = { found: ['rate', 'origin', 'destination'], fields: {} };
const TEXT_LAYER = 'RATE CONFIRMATION\nLoad # 48213\nShipper: Big Box DC, Dallas, TX\nConsignee: Corner Market, Atlanta, GA\nRate: $2,350.00';
const pdfFile = (name = 'rc.pdf') => new File(['%PDF-1.7'], name, { type: 'application/pdf' });
const photo = () => new File(['jpeg'], 'IMG_2041.jpg', { type: 'image/jpeg' });

function release(text) {
  const next = tess.pending.shift();
  next.resolve({ data: { text } });
}

beforeEach(() => {
  vi.clearAllMocks();
  api.post.mockResolvedValue(PARSED);
  tess.workers = [];
  tess.pending = [];
  tess.createWorker = vi.fn(async (lang, oem, options) => {
    tess.logger = options.logger;
    options.logger({ status: 'loading tesseract core', progress: 1 });
    const worker = {
      terminate: vi.fn(async () => {}),
      setParameters: vi.fn(async (p) => p),
      recognize: vi.fn(() => new Promise((resolve, reject) => {
        options.logger({ status: 'recognizing text', progress: 0.5 });
        tess.pending.push({ resolve, reject });
      })),
    };
    tess.workers.push(worker);
    return worker;
  });
  pdf.pdfPageImages.mockResolvedValue({
    total: 2, count: 2, close: vi.fn(),
    render: async () => ({ toBlob: (cb) => cb(new Blob(['png'], { type: 'image/png' })) }),
  });
});

const choose = (file) => fireEvent.change(screen.getByLabelText('Choose a rate con PDF or photo'), { target: { files: [file] } });

describe('RateConImport', () => {
  it('accepts PDFs, photos and text, and says the file is read on this device', () => {
    render(<RateConImport />);
    const input = screen.getByLabelText('Choose a rate con PDF or photo');
    expect(input.accept).toContain('application/pdf');
    expect(input.accept).toContain('image/jpeg');
    expect(input.accept).toContain('image/png');
    expect(input.accept).toContain('image/webp');
    expect(screen.getByText(/Drop a PDF or a photo here/)).toHaveTextContent('read on this device');
  });

  it('parses a PDF with a text layer without starting OCR', async () => {
    pdf.pdfToText.mockResolvedValue({ text: TEXT_LAYER, pages: 1, truncated: false });
    const onParsed = vi.fn();
    render(<RateConImport onParsed={onParsed} />);
    choose(pdfFile());
    await waitFor(() => expect(onParsed).toHaveBeenCalled());
    expect(api.post).toHaveBeenCalledWith('/api/loads/parse', { text: TEXT_LAYER });
    expect(tess.createWorker).not.toHaveBeenCalled();
    expect(pdf.pdfPageImages).not.toHaveBeenCalled();
  });

  it('reads a scanned PDF with OCR, shows page progress, and sends the recognized text to the parser', async () => {
    pdf.pdfToText.mockResolvedValue({ text: '', pages: 2, truncated: false });
    const onParsed = vi.fn();
    const file = pdfFile('scan.pdf');
    render(<RateConImport onParsed={onParsed} />);
    choose(file);

    expect(await screen.findByText('Reading page 1 of 2…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Text recognition progress' })).toHaveAttribute('aria-valuenow', '25');
    expect(screen.getByRole('button', { name: /Reading scan/ })).toBeDisabled();
    expect(tess.createWorker.mock.calls[0][2]).toMatchObject({ workerPath: '/ocr/worker.min.js', langPath: '/ocr', workerBlobURL: false });
    act(() => release('RATE CONFIRMATION\nLoad # 48213'));

    expect(await screen.findByText('Reading page 2 of 2…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Text recognition progress' })).toHaveAttribute('aria-valuenow', '75');
    act(() => release('Total carrier pay $2,350.00'));

    await waitFor(() => expect(onParsed).toHaveBeenCalled());
    const text = 'RATE CONFIRMATION\nLoad # 48213\n\nTotal carrier pay $2,350.00';
    expect(api.post).toHaveBeenCalledWith('/api/loads/parse', { text });
    expect(onParsed).toHaveBeenCalledWith({ parsed: PARSED, file, text });
    expect(tess.workers[0].terminate).toHaveBeenCalled();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByText(/scan.pdf: read with text recognition, filled 3 of 7 key fields/)).toBeInTheDocument();
  });

  it('reads a photo with OCR without opening it as a PDF', async () => {
    const onParsed = vi.fn();
    const file = photo();
    render(<RateConImport onParsed={onParsed} />);
    fireEvent.drop(screen.getByText('Import a rate con').closest('.border-dashed'), { dataTransfer: { files: [file] } });

    expect(await screen.findByText('Reading the photo…')).toBeInTheDocument();
    expect(screen.getByText(/The photo is read on this device and is not uploaded/)).toBeInTheDocument();
    expect(tess.workers[0].recognize).toHaveBeenCalledWith(file); // jsdom cannot decode images, so the file goes as is
    act(() => release('RATE CONFIRMATION  Rate $1,900.00'));
    await waitFor(() => expect(onParsed).toHaveBeenCalledWith(expect.objectContaining({ file, text: 'RATE CONFIRMATION Rate $1,900.00' })));
    expect(pdf.pdfToText).not.toHaveBeenCalled();
  });

  it('cancels OCR: terminates the worker, sends nothing and offers to paste the text', async () => {
    pdf.pdfToText.mockResolvedValue({ text: '', pages: 2, truncated: false });
    const onParsed = vi.fn();
    render(<RateConImport onParsed={onParsed} />);
    choose(pdfFile('scan.pdf'));
    await screen.findByText('Reading page 1 of 2…');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText(/Stopped reading the scan/)).toBeInTheDocument();
    expect(tess.workers[0].terminate).toHaveBeenCalled();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose file' })).toBeEnabled();
    act(() => release('late text'));
    await Promise.resolve();
    expect(api.post).not.toHaveBeenCalled();
    expect(onParsed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Paste text instead' }));
    expect(screen.getByLabelText('Rate con or load text')).toBeInTheDocument();
  });

  it('terminates the worker when the form closes mid-scan', async () => {
    const { unmount } = render(<RateConImport />);
    choose(photo());
    await screen.findByText('Reading the photo…');
    unmount();
    expect(tess.workers[0].terminate).toHaveBeenCalled();
  });

  it('explains a failed scan and still offers Paste text', async () => {
    tess.createWorker = vi.fn(async () => { throw 'Network error while fetching /ocr/eng.traineddata.gz'; }); // eslint-disable-line no-throw-literal
    render(<RateConImport />);
    choose(photo());
    expect(await screen.findByRole('alert')).toHaveTextContent('The text in this file could not be read. Paste the text or type the details.');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Paste text instead' }));
    expect(screen.getByLabelText('Rate con or load text')).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
  });

  it('says so when OCR finds no text, and refuses unsupported files', async () => {
    render(<RateConImport />);
    choose(photo());
    await screen.findByText('Reading the photo…');
    act(() => release('  \n '));
    expect(await screen.findByRole('alert')).toHaveTextContent('No text could be read from this file.');
    expect(api.post).not.toHaveBeenCalled();

    choose(new File(['x'], 'IMG_1.HEIC', { type: 'image/heic' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a PDF, a photo (JPG, PNG or WebP) or a text file.');
  });
});
