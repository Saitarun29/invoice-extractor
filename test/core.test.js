import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toNumber, toISODate, toCurrency, normalizeInvoice, normalizeConfidence, validate, route, analyze, dupKey, toCSV, csvCell, CONF_FLOOR } from '../assets/core.js';

const base = () => normalizeInvoice({
  vendor: 'Sharma Office Supplies Pvt Ltd', invoice_number: 'SOS/2026-27/0418', issue_date: '2026-10-14', due_date: '2026-11-13',
  currency: 'INR', subtotal: 27500, total: 32450, payment_terms: 'Net 30',
  line_items: [
    { description: 'Paper', quantity: 20, unit_price: 285, amount: 5700 },
    { description: 'Ink', quantity: 6, unit_price: 1150, amount: 6900 },
    { description: 'Chair', quantity: 2, unit_price: 7450, amount: 14900 },
  ],
  tax_lines: [{ label: 'CGST', rate: 9, amount: 2475 }, { label: 'SGST', rate: 9, amount: 2475 }],
});
const status = (checks, id) => checks.find((c) => c.id === id).status;
const allHigh = { vendor: 0.95, invoice_number: 0.95, issue_date: 0.95, total: 0.95 };

test('toNumber strips separators and symbols', () => {
  assert.equal(toNumber('₹ 1,23,456.50'), 123456.5);
  assert.equal(toNumber('$1,356.08'), 1356.08);
  assert.equal(toNumber('(120.00)'), -120);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('n/a'), null);
});

test('toISODate handles day-first, month-first and month names', () => {
  assert.equal(toISODate('14/10/2026'), '2026-10-14');
  assert.equal(toISODate('10/31/2026'), '2026-10-31');
  assert.equal(toISODate('28/10/26'), '2026-10-28');
  assert.equal(toISODate('October 1, 2026'), '2026-10-01');
  assert.equal(toISODate('01-Oct-2026'), '2026-10-01');
  assert.equal(toISODate('2026-02-30'), null, 'impossible date rejected');
});

test('toCurrency maps symbols and codes', () => {
  assert.equal(toCurrency('₹'), 'INR');
  assert.equal(toCurrency('Rs.'), 'INR');
  assert.equal(toCurrency('usd'), 'USD');
});

test('normalizeInvoice derives tax_total and line amounts', () => {
  const inv = normalizeInvoice({ line_items: [{ description: 'x', quantity: '3', unit_price: '2.50' }], tax_lines: [{ label: 'VAT', amount: '1.50' }] });
  assert.equal(inv.line_items[0].amount, 7.5);
  assert.equal(inv.tax_total, 1.5);
});

test('clean GST invoice passes every check and auto-approves', () => {
  const inv = base();
  const { checks, routing } = analyze(inv, allHigh);
  assert.ok(checks.every((c) => c.status === 'pass'), JSON.stringify(checks));
  assert.equal(routing.decision, 'auto_approve');
});

test('line items not summing to subtotal fails items_sum', () => {
  const inv = { ...base(), subtotal: 28000, total: 32950 };
  const checks = validate(inv);
  assert.equal(status(checks, 'items_sum'), 'fail');
  assert.match(checks.find((c) => c.id === 'items_sum').detail, /off by 500\.00/);
});

test('subtotal + tax != total fails totals', () => {
  assert.equal(status(validate({ ...base(), total: 32000 }), 'totals'), 'fail');
});

test('line arithmetic catches a wrong extension', () => {
  const inv = base();
  inv.line_items[1].amount = 6000;
  assert.equal(status(validate(inv), 'line_math'), 'fail');
});

test('GST rules: CGST must equal SGST, IGST cannot mix', () => {
  const a = base(); a.tax_lines[1].amount = 2000; a.tax_total = 4475;
  assert.equal(status(validate(a), 'tax_breakdown'), 'fail');
  const b = base(); b.tax_lines.push({ label: 'IGST', rate: 18, amount: 4950 });
  assert.equal(status(validate(b), 'tax_breakdown'), 'fail');
});

test('due date before issue date fails, missing due date skips', () => {
  assert.equal(status(validate({ ...base(), due_date: '2026-10-01' }), 'dates'), 'fail');
  assert.equal(status(validate({ ...base(), due_date: null }), 'dates'), 'skip');
});

test('duplicate check uses vendor + invoice number from session history', () => {
  const inv = base();
  const key = dupKey(inv);
  assert.equal(key, 'sharmaofficesupplies|SOS2026270418');
  assert.equal(dupKey({ ...inv, vendor: 'SHARMA OFFICE SUPPLIES PRIVATE LIMITED' }), key, 'legal suffixes ignored');
  assert.equal(status(validate(inv, { history: [key] }), 'duplicate'), 'fail');
  assert.equal(analyze(inv, allHigh, { history: [key] }).routing.decision, 'review');
});

test('one low-confidence field sends a clean invoice to review', () => {
  const r = route(validate(base()), { ...allHigh, issue_date: 0.62 });
  assert.equal(r.decision, 'review');
  assert.deepEqual(r.low_confidence, ['issue_date']);
  assert.equal(r.min_confidence, 0.62);
  assert.equal(route(validate(base()), { ...allHigh, issue_date: CONF_FLOOR }).decision, 'auto_approve', 'floor is inclusive');
});

test('normalizeConfidence defaults missing scores to 0.5 and nulls absent fields', () => {
  const inv = base();
  const c = normalizeConfidence({ vendor: 2 }, inv);
  assert.equal(c.vendor, 1);
  assert.equal(c.total, 0.5);
  assert.equal(c.bill_to, null);
});

test('CSV export quotes text and neutralises formulas', () => {
  assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
  assert.equal(csvCell(-12.5), '-12.5');
  const csv = toCSV([{ approved_at: '2026-11-01T10:00:00Z', route: 'auto', invoice: base(), min_confidence: 0.9 }]);
  const [head, row] = csv.trim().split('\r\n');
  assert.match(head, /"Invoice number"/);
  assert.match(row, /"SOS\/2026-27\/0418"/);
  assert.match(row, /,2475,2475,,4950,32450,/);
});
