// Worker thread: extract text from one PDF so pdf-parse never blocks the process's event loop.
// Input (workerData): { file, maxChars }. Output message: { text } or { error }.
import fs from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import pdfParse from 'pdf-parse/lib/pdf-parse.js';

try {
  const buf = fs.readFileSync(workerData.file);
  const out = await pdfParse(buf);
  parentPort.postMessage({ text: String(out.text || '').slice(0, workerData.maxChars) });
} catch (err) {
  parentPort.postMessage({ error: String(err?.message || err) });
}
