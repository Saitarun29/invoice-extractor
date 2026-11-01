// Invoice Extractor · core logic
// Pure functions shared by the browser (review queue re-validation, CSV export)
// and api/extract.js (server-side validation and routing). No DOM, no I/O.

export const CONF_FLOOR = 0.85;
export const TOL_CENTS = 1;
export const MAX_ITEMS = 100;
export const MAX_TAX_LINES = 10;

export const FIELDS = [
  { key: 'vendor', label: 'Vendor', type: 'text', required: true },
  { key: 'vendor_tax_id', label: 'Vendor tax ID', type: 'text' },
  { key: 'bill_to', label: 'Bill to', type: 'text' },
  { key: 'invoice_number', label: 'Invoice number', type: 'text', required: true },
  { key: 'issue_date', label: 'Issue date', type: 'date', required: true },
  { key: 'due_date', label: 'Due date', type: 'date' },
  { key: 'currency', label: 'Currency', type: 'text', required: true },
  { key: 'subtotal', label: 'Subtotal', type: 'money', required: true },
  { key: 'tax_total', label: 'Tax', type: 'money' },
  { key: 'total', label: 'Total', type: 'money', required: true },
  { key: 'payment_terms', label: 'Payment terms', type: 'text' },
];
export const CONF_KEYS = [...FIELDS.map((f) => f.key), 'line_items', 'tax_lines'];

export const CHECKS = [
  ['required', 'Required fields', 'Vendor, number, issue date, currency, subtotal, total'],
  ['line_math', 'Line arithmetic', 'Quantity × unit price = amount on every line'],
  ['items_sum', 'Line items sum', 'Sum of line amounts = subtotal'],
  ['tax_breakdown', 'Tax breakdown', 'Tax lines sum to tax; CGST = SGST; no IGST with CGST/SGST'],
  ['totals', 'Totals', 'Subtotal + tax = total'],
  ['dates', 'Dates', 'Due date on or after issue date'],
  ['duplicate', 'Duplicate check', 'Vendor + invoice number not seen this session'],
];

const SYMBOLS = { '₹': 'INR', 'RS': 'INR', 'RS.': 'INR', 'RUPEES': 'INR', '$': 'USD', 'US$': 'USD', '€': 'EUR', '£': 'GBP', 'A$': 'AUD', 'S$': 'SGD' };
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

// ---------- primitives ----------
export function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).trim();
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s.replace(/[^\d\-().]/g, ''));
  s = s.replace(/[^\d.]/g, '');
  if (!s || !/\d/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -n : n) : null;
}
export const cents = (n) => Math.round(Number(n) * 100);
export const round2 = (n) => (n === null || n === undefined ? null : Math.round(Number(n) * 100) / 100);
const near = (a, b, tol = TOL_CENTS) => Math.abs(cents(a) - cents(b)) <= tol;

export function toCurrency(v) {
  if (!v) return null;
  const s = String(v).trim().toUpperCase();
  if (SYMBOLS[s]) return SYMBOLS[s];
  const m = s.match(/\b([A-Z]{3})\b/);
  return m ? m[1] : null;
}

function validYMD(y, m, d) {
  if (!(y >= 1990 && y <= 2100 && m >= 1 && m <= 12 && d >= 1)) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
const fullYear = (y) => (y < 100 ? 2000 + y : y);
const monthOf = (w) => MONTHS[w.slice(0, 4).toLowerCase()] || MONTHS[w.slice(0, 3).toLowerCase()] || null;

// Accepts ISO, DD/MM/YYYY (day-first by default), MM/DD/YYYY when the day is
// unambiguous, and month names ("Oct 1, 2026", "1 October 2026", "01-Oct-26").
export function toISODate(v, { dayFirst = true } = {}) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return validYMD(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (m) {
    let a = +m[1], b = +m[2];
    const y = fullYear(+m[3]);
    if (a > 12) return validYMD(y, b, a);
    if (b > 12) return validYMD(y, a, b);
    return dayFirst ? validYMD(y, b, a) : validYMD(y, a, b);
  }
  m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{2,4})$/);
  if (m && monthOf(m[1])) return validYMD(fullYear(+m[3]), monthOf(m[1]), +m[2]);
  m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s\-]+([A-Za-z]{3,9})\.?[\s\-,]+(\d{2,4})$/);
  if (m && monthOf(m[2])) return validYMD(fullYear(+m[3]), monthOf(m[2]), +m[1]);
  return null;
}

const str = (v, max = 200) => {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, ' ').trim().slice(0, max);
  return s || null;
};
const clamp01 = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d;
};

// ---------- normalize ----------
// Coerces any model or parser output into the public JSON contract.
export function normalizeInvoice(o) {
  o = o && typeof o === 'object' ? o : {};
  const items = (Array.isArray(o.line_items) ? o.line_items : []).slice(0, MAX_ITEMS).map((li) => {
    li = li && typeof li === 'object' ? li : {};
    const quantity = toNumber(li.quantity);
    const unit_price = round2(toNumber(li.unit_price));
    let amount = round2(toNumber(li.amount));
    if (amount === null && quantity !== null && unit_price !== null) amount = round2(quantity * unit_price);
    return { description: str(li.description, 160) || 'Item', quantity, unit_price, amount };
  }).filter((li) => li.amount !== null || li.unit_price !== null);
  const tax_lines = (Array.isArray(o.tax_lines) ? o.tax_lines : []).slice(0, MAX_TAX_LINES).map((t) => {
    t = t && typeof t === 'object' ? t : {};
    return { label: str(t.label, 40) || 'Tax', rate: toNumber(t.rate), amount: round2(toNumber(t.amount)) };
  }).filter((t) => t.amount !== null);
  let tax_total = round2(toNumber(o.tax_total));
  if (tax_total === null && tax_lines.length) tax_total = round2(tax_lines.reduce((s, t) => s + t.amount, 0));
  return {
    vendor: str(o.vendor),
    vendor_tax_id: str(o.vendor_tax_id, 40),
    bill_to: str(o.bill_to),
    invoice_number: str(o.invoice_number, 60),
    issue_date: toISODate(o.issue_date),
    due_date: toISODate(o.due_date),
    currency: toCurrency(o.currency),
    line_items: items,
    subtotal: round2(toNumber(o.subtotal)),
    tax_lines,
    tax_total,
    total: round2(toNumber(o.total)),
    payment_terms: str(o.payment_terms, 80),
  };
}

// Missing confidence is treated as 0.5 so an incomplete model answer goes to review.
export function normalizeConfidence(c, invoice) {
  c = c && typeof c === 'object' ? c : {};
  const out = {};
  for (const k of CONF_KEYS) out[k] = round2(clamp01(c[k], 0.5));
  if (c.tax !== undefined && c.tax_total === undefined) out.tax_total = round2(clamp01(c.tax, 0.5));
  if (invoice) for (const k of CONF_KEYS) {
    const v = invoice[k];
    if (v === null || (Array.isArray(v) && !v.length)) out[k] = null;
  }
  return out;
}

// ---------- validation ----------
export function dupKey(inv) {
  const vendor = String(inv?.vendor || '').toLowerCase()
    .replace(/\b(private|pvt|limited|ltd|inc|llc|llp|corp|co|company)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
  const num = String(inv?.invoice_number || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return vendor && num ? `${vendor}|${num}` : null;
}

const fmt = (n) => (n === null || n === undefined ? 'missing' : Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const check = (id, status, detail) => {
  const c = CHECKS.find((x) => x[0] === id);
  return { id, label: c[1], rule: c[2], status, detail };
};

export function validate(inv, { history = [] } = {}) {
  const out = [];

  const missing = FIELDS.filter((f) => f.required && (inv[f.key] === null || inv[f.key] === undefined || inv[f.key] === '')).map((f) => f.label);
  out.push(missing.length ? check('required', 'fail', `Missing: ${missing.join(', ')}.`) : check('required', 'pass', 'All required fields present.'));

  const items = inv.line_items || [];
  const priced = items.filter((li) => li.quantity !== null && li.unit_price !== null && li.amount !== null);
  if (!priced.length) out.push(check('line_math', 'skip', 'No lines with quantity and unit price.'));
  else {
    const bad = priced.filter((li) => !near(li.quantity * li.unit_price, li.amount));
    out.push(bad.length
      ? check('line_math', 'fail', bad.slice(0, 3).map((li) => `"${li.description}": ${li.quantity} × ${fmt(li.unit_price)} = ${fmt(li.quantity * li.unit_price)}, invoice says ${fmt(li.amount)}`).join('; ') + '.')
      : check('line_math', 'pass', `${priced.length} of ${items.length} lines verified.`));
  }

  const amounts = items.filter((li) => li.amount !== null);
  if (!amounts.length || inv.subtotal === null) out.push(check('items_sum', 'skip', !amounts.length ? 'No line items extracted.' : 'No subtotal to compare.'));
  else {
    const sum = amounts.reduce((s, li) => s + cents(li.amount), 0) / 100;
    const diff = round2(inv.subtotal - sum);
    out.push(near(sum, inv.subtotal)
      ? check('items_sum', 'pass', `Lines sum to ${fmt(sum)}, matches subtotal.`)
      : check('items_sum', 'fail', `Lines sum to ${fmt(sum)}, subtotal says ${fmt(inv.subtotal)} (off by ${fmt(diff)}).`));
  }

  const tl = inv.tax_lines || [];
  if (!tl.length) out.push(check('tax_breakdown', 'skip', 'No itemised tax lines.'));
  else {
    const problems = [];
    const sum = tl.reduce((s, t) => s + cents(t.amount), 0) / 100;
    if (inv.tax_total !== null && !near(sum, inv.tax_total)) problems.push(`tax lines sum to ${fmt(sum)}, tax total says ${fmt(inv.tax_total)}`);
    const find = (k) => tl.find((t) => new RegExp(`^${k}\\b`, 'i').test(t.label));
    const cg = find('CGST'), sg = find('SGST') || find('UTGST'), ig = find('IGST');
    if (cg && sg && !near(cg.amount, sg.amount)) problems.push(`CGST ${fmt(cg.amount)} and SGST ${fmt(sg.amount)} should be equal`);
    if ((cg || sg) && !(cg && sg)) problems.push('CGST and SGST must appear together');
    if (ig && (cg || sg)) problems.push('IGST cannot be charged with CGST/SGST');
    if (inv.subtotal) for (const t of tl) {
      if (t.rate !== null && t.rate > 0 && !near(inv.subtotal * t.rate / 100, t.amount, Math.max(TOL_CENTS, items.length))) {
        problems.push(`${t.label} at ${t.rate}% of ${fmt(inv.subtotal)} is ${fmt(inv.subtotal * t.rate / 100)}, invoice says ${fmt(t.amount)}`);
      }
    }
    const gst = cg && sg ? ` CGST = SGST = ${fmt(cg.amount)}.` : ig ? ' Inter-state IGST only.' : '';
    out.push(problems.length ? check('tax_breakdown', 'fail', cap(problems.join('; ')) + '.') : check('tax_breakdown', 'pass', `${tl.length} tax line${tl.length > 1 ? 's' : ''} ${tl.length > 1 ? 'reconcile' : 'reconciles'}.${gst}`));
  }

  if (inv.subtotal === null || inv.total === null) out.push(check('totals', 'skip', 'Subtotal or total missing.'));
  else {
    const expect = round2(inv.subtotal + (inv.tax_total || 0));
    out.push(near(expect, inv.total)
      ? check('totals', 'pass', `${fmt(inv.subtotal)} + ${fmt(inv.tax_total || 0)} = ${fmt(inv.total)}.`)
      : check('totals', 'fail', `${fmt(inv.subtotal)} + ${fmt(inv.tax_total || 0)} = ${fmt(expect)}, total says ${fmt(inv.total)}.`));
  }

  if (!inv.issue_date) out.push(check('dates', 'fail', 'Issue date missing or unreadable.'));
  else if (!inv.due_date) out.push(check('dates', 'skip', 'No due date on the document.'));
  else if (inv.due_date < inv.issue_date) out.push(check('dates', 'fail', `Due ${inv.due_date} is before issue ${inv.issue_date}.`));
  else {
    const days = Math.round((Date.parse(inv.due_date) - Date.parse(inv.issue_date)) / 864e5);
    out.push(check('dates', 'pass', `Due ${days} day${days === 1 ? '' : 's'} after issue.`));
  }

  const key = dupKey(inv);
  if (!key) out.push(check('duplicate', 'skip', 'Needs vendor and invoice number.'));
  else out.push(history.includes(key)
    ? check('duplicate', 'fail', `${inv.invoice_number} from ${inv.vendor} was already processed this session.`)
    : check('duplicate', 'pass', 'Not seen this session.'));
  return out;
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export function minConfidence(conf) {
  const entries = Object.entries(conf || {}).filter(([, v]) => typeof v === 'number');
  if (!entries.length) return { value: 0, field: null };
  const [field, value] = entries.reduce((a, b) => (b[1] < a[1] ? b : a));
  return { value, field };
}

export function route(checks, conf, floor = CONF_FLOOR) {
  const failed = checks.filter((c) => c.status === 'fail');
  const min = minConfidence(conf);
  const low = Object.entries(conf || {}).filter(([, v]) => typeof v === 'number' && v < floor).map(([k]) => k);
  const reasons = [
    ...failed.map((c) => `${c.label}: ${c.detail}`),
    ...(low.length ? [`Low confidence (< ${floor.toFixed(2)}): ${low.map(labelOf).join(', ')}`] : []),
  ];
  return {
    decision: !failed.length && min.value >= floor ? 'auto_approve' : 'review',
    min_confidence: min.value,
    min_field: min.field,
    floor,
    failed: failed.map((c) => c.id),
    low_confidence: low,
    reasons,
  };
}
export const labelOf = (k) => (FIELDS.find((f) => f.key === k)?.label) || (k === 'line_items' ? 'Line items' : k === 'tax_lines' ? 'Tax lines' : k);

export function analyze(invoice, confidence, { history = [], floor = CONF_FLOOR } = {}) {
  const checks = validate(invoice, { history });
  return { checks, routing: route(checks, confidence, floor), dup_key: dupKey(invoice) };
}

// ---------- CSV ----------
export const CSV_COLUMNS = [
  ['approved_at', 'Approved at'], ['route', 'Route'], ['vendor', 'Vendor'], ['vendor_tax_id', 'Vendor tax ID'],
  ['invoice_number', 'Invoice number'], ['issue_date', 'Issue date'], ['due_date', 'Due date'], ['currency', 'Currency'],
  ['subtotal', 'Subtotal'], ['cgst', 'CGST'], ['sgst', 'SGST'], ['igst', 'IGST'], ['tax_total', 'Tax total'],
  ['total', 'Total'], ['payment_terms', 'Payment terms'], ['line_count', 'Lines'], ['min_confidence', 'Min confidence'],
];

export function csvRow(entry) {
  const inv = entry.invoice || {};
  const tax = (k) => {
    const t = (inv.tax_lines || []).find((x) => new RegExp(`^${k}\\b`, 'i').test(x.label));
    return t ? t.amount : null;
  };
  return {
    approved_at: entry.approved_at || '', route: entry.route || '', vendor: inv.vendor, vendor_tax_id: inv.vendor_tax_id,
    invoice_number: inv.invoice_number, issue_date: inv.issue_date, due_date: inv.due_date, currency: inv.currency,
    subtotal: inv.subtotal, cgst: tax('CGST'), sgst: tax('SGST'), igst: tax('IGST'), tax_total: inv.tax_total,
    total: inv.total, payment_terms: inv.payment_terms, line_count: (inv.line_items || []).length,
    min_confidence: entry.min_confidence ?? '',
  };
}

// Quotes every text cell and neutralises spreadsheet formulas (=, +, -, @ at the start of text).
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export function toCSV(entries, columns = CSV_COLUMNS) {
  const head = columns.map(([, label]) => csvCell(label)).join(',');
  const rows = entries.map((e) => { const r = csvRow(e); return columns.map(([k]) => csvCell(r[k])).join(','); });
  return [head, ...rows].join('\r\n') + '\r\n';
}
