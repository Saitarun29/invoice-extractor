// POST /api/extract · extract one invoice, validate it, and route it.
// Body: { text } or { file: { name, mime, data /* base64 */ } }, plus { history: [dup keys] }.
import { normalizeInvoice, normalizeConfidence, analyze, CONF_FLOOR } from '../assets/core.js';
import { demoExtract } from './_demo.js';

export const MODEL = 'gemini-2.0-flash';
export const MAX_TEXT = 20000;
export const MIN_TEXT = 20;
export const MAX_FILE_BYTES = 3 * 1024 * 1024;
export const MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const MAX_BODY = 4.5 * 1024 * 1024;
const MAX_HISTORY = 200;
export const RATE = { windowMs: 60000, max: Number(process.env.RATE_LIMIT_PER_MIN) || 20 };
const hits = new Map();

export function limited(ip, now = Date.now()) {
  const arr = (hits.get(ip) || []).filter((x) => now - x < RATE.windowMs);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > RATE.max;
}

async function readBody(req) {
  if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body;
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > MAX_BODY) { const e = new Error('too large'); e.code = 413; throw e; }
  }
  return JSON.parse(data || '{}');
}

export const PROMPT = `You extract structured data from one invoice, bill or receipt.
Return only JSON with exactly these keys:
{
  "vendor": string|null, "vendor_tax_id": string|null (GSTIN, VAT, EIN or similar of the seller),
  "bill_to": string|null (buyer name only), "invoice_number": string|null,
  "issue_date": "YYYY-MM-DD"|null, "due_date": "YYYY-MM-DD"|null,
  "currency": ISO 4217 code|null,
  "line_items": [{ "description": string, "quantity": number|null, "unit_price": number|null, "amount": number|null }],
  "subtotal": number|null (pre-tax; "taxable value" on Indian invoices),
  "tax_lines": [{ "label": "CGST"|"SGST"|"UTGST"|"IGST"|"VAT"|"Sales tax"|string, "rate": number|null (percent), "amount": number }],
  "tax_total": number|null, "total": number|null, "payment_terms": string|null,
  "confidence": { "vendor","vendor_tax_id","bill_to","invoice_number","issue_date","due_date","currency","line_items","subtotal","tax_lines","tax_total","total","payment_terms": number 0..1 },
  "flags": [string] (risks a reviewer should see, e.g. changed bank details, urgency, altered figures; empty if none)
}
Rules: copy numbers exactly as printed, never recompute or "fix" them, so validation can catch mismatches.
Numbers are plain decimals without separators or symbols. Use null for anything not on the document.
Indian dates are day-first. Confidence reflects legibility and how certain the reading is, not whether the maths adds up.`;

async function callGemini(parts) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.MODEL_TIMEOUT_MS) || 25000);
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 4096 },
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    const text = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const out = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    return out && typeof out === 'object' && !Array.isArray(out) ? out : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function buildResult({ raw, confidence, flags, history, mode, ms, source, note }) {
  const invoice = normalizeInvoice(raw);
  const conf = normalizeConfidence(confidence, invoice);
  const { checks, routing, dup_key } = analyze(invoice, conf, { history });
  return {
    mode, model: mode === 'live' ? MODEL : 'rule-based parser (demo)', ms, source,
    invoice, confidence: conf,
    flags: (Array.isArray(flags) ? flags : []).map((f) => String(f).slice(0, 240)).slice(0, 6),
    checks, routing, dup_key, ...(note ? { note } : {}),
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'POST only' });
  }
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'local').split(',')[0].trim();
  if (limited(ip)) {
    res.setHeader('Retry-After', String(Math.ceil(RATE.windowMs / 1000)));
    return res.status(429).json({ error: 'Too many extractions. Try again in a minute.' });
  }

  let input;
  try { input = await readBody(req); } catch (e) {
    return e.code === 413 ? res.status(413).json({ error: 'Request too large.' }) : res.status(400).json({ error: 'Request must be JSON.' });
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return res.status(400).json({ error: 'Request body must be a JSON object.' });
  const history = (Array.isArray(input.history) ? input.history : []).filter((h) => typeof h === 'string').map((h) => h.slice(0, 120)).slice(-MAX_HISTORY);
  const hasText = typeof input.text === 'string' && input.text.trim().length > 0;
  const hasFile = input.file && typeof input.file === 'object';
  if (hasText === Boolean(hasFile)) return res.status(400).json({ error: 'Send either `text` or `file`, not both.' });

  const t0 = Date.now();
  const live = Boolean(process.env.GEMINI_API_KEY);

  if (hasFile) {
    const { name = 'upload', mime, data } = input.file;
    if (!MIME.includes(mime)) return res.status(415).json({ error: 'Upload a PDF, PNG, JPEG or WebP file.' });
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(data.slice(0, 200000).replace(/\s/g, '') || '!')) return res.status(400).json({ error: '`file.data` must be base64.' });
    const bytes = Math.floor((data.length * 3) / 4);
    if (bytes > MAX_FILE_BYTES) return res.status(413).json({ error: `File over ${MAX_FILE_BYTES / 1024 / 1024} MB.` });
    if (!live) return res.status(422).json({ error: 'Files are read by Gemini in live mode. This deployment runs in demo mode: paste the invoice text or pick a sample.', mode: 'demo' });
    const out = await callGemini([{ text: PROMPT }, { inline_data: { mime_type: mime, data } }]);
    if (!out) return res.status(502).json({ error: 'The model did not return a readable result. Try again, or paste the text instead.', mode: 'live' });
    return res.status(200).json(buildResult({ raw: out, confidence: out.confidence, flags: out.flags, history, mode: 'live', ms: Date.now() - t0, source: { kind: 'file', name: String(name).slice(0, 120), mime, bytes } }));
  }

  const text = input.text.trim();
  if (text.length > MAX_TEXT) return res.status(413).json({ error: `Text over ${MAX_TEXT.toLocaleString('en-US')} characters.` });
  if (text.length < MIN_TEXT) return res.status(400).json({ error: 'That is too short to be an invoice.' });
  const source = { kind: 'text', chars: text.length };

  if (live) {
    const out = await callGemini([{ text: PROMPT }, { text: `Document:\n"""\n${text}\n"""` }]);
    if (out) return res.status(200).json(buildResult({ raw: out, confidence: out.confidence, flags: out.flags, history, mode: 'live', ms: Date.now() - t0, source }));
  }
  const d = demoExtract(text);
  return res.status(200).json(buildResult({
    raw: d.invoice, confidence: d.confidence, flags: d.flags, history, mode: 'demo', ms: Date.now() - t0, source,
    note: live ? 'Live model unavailable, fell back to the rule-based parser.' : undefined,
  }));
}

export { CONF_FLOOR };
