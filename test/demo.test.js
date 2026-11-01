import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAMPLES } from '../assets/samples.js';
import { demoExtract, repairLine } from '../api/_demo.js';
import { buildResult } from '../api/extract.js';

const run = (id, history = []) => {
  const d = demoExtract(SAMPLES.find((s) => s.id === id).text);
  return buildResult({ raw: d.invoice, confidence: d.confidence, flags: d.flags, history, mode: 'demo', ms: 0 });
};

test('OCR repair fixes digits and words', () => {
  assert.equal(repairLine('Sub Total 32O.00').text, 'Sub Total 320.00');
  assert.equal(repairLine('Dt: 28/1O/26').text, 'Dt: 28/10/26');
  assert.equal(repairLine('CHAI P0INT').text, 'CHAI POINT');
  assert.equal(repairLine('Osmania Bisc 200g').fixed, false);
});

test('Indian GST sample: fields, CGST/SGST, auto-approve', () => {
  const r = run('gst');
  assert.equal(r.invoice.vendor, 'Sharma Office Supplies Pvt Ltd');
  assert.equal(r.invoice.vendor_tax_id, '36AABCS4821K1Z3');
  assert.equal(r.invoice.invoice_number, 'SOS/2026-27/0418');
  assert.equal(r.invoice.issue_date, '2026-10-14');
  assert.equal(r.invoice.currency, 'INR');
  assert.equal(r.invoice.line_items.length, 3);
  assert.deepEqual(r.invoice.tax_lines.map((t) => t.label), ['CGST', 'SGST']);
  assert.equal(r.invoice.total, 32450);
  assert.equal(r.routing.decision, 'auto_approve');
});

test('GST sample run twice is caught as a duplicate', () => {
  const first = run('gst');
  const second = run('gst', [first.dup_key]);
  assert.equal(second.checks.find((c) => c.id === 'duplicate').status, 'fail');
  assert.equal(second.routing.decision, 'review');
});

test('US SaaS sample: month-name dates, USD sales tax, auto-approve', () => {
  const r = run('saas');
  assert.equal(r.invoice.issue_date, '2026-10-01');
  assert.equal(r.invoice.due_date, '2026-10-31');
  assert.equal(r.invoice.currency, 'USD');
  assert.equal(r.invoice.tax_total, 126.08);
  assert.equal(r.invoice.line_items[1].quantity, 1200);
  assert.equal(r.routing.decision, 'auto_approve');
});

test('scanned receipt: maths passes but low confidence routes to review', () => {
  const r = run('receipt');
  assert.equal(r.invoice.subtotal, 320);
  assert.equal(r.invoice.total, 336);
  assert.equal(r.invoice.issue_date, '2026-10-28');
  assert.ok(r.checks.every((c) => c.status !== 'fail'));
  assert.ok(r.routing.min_confidence < 0.85);
  assert.equal(r.routing.decision, 'review');
});

test('suspicious invoice: sum mismatch and date order fail, bank change flagged', () => {
  const r = run('suspicious');
  assert.deepEqual(r.routing.failed.sort(), ['dates', 'items_sum']);
  assert.equal(r.routing.decision, 'review');
  assert.ok(r.flags.some((f) => /bank details/i.test(f)));
});
