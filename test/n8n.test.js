import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(new URL('../n8n/invoice-extractor.n8n.json', import.meta.url), 'utf8'));
const node = (name) => wf.nodes.find((n) => n.name === name);

test('workflow wires Gmail -> extract -> validate -> IF -> Sheets | Slack', () => {
  assert.equal(node('Gmail Trigger').type, 'n8n-nodes-base.gmailTrigger');
  assert.equal(wf.connections['Gmail Trigger'].main[0][0].node, 'Prepare attachment');
  assert.equal(wf.connections['Prepare attachment'].main[0][0].node, 'Extract (Gemini)');
  assert.equal(wf.connections['Extract (Gemini)'].main[0][0].node, 'Validate');
  assert.equal(wf.connections['Validate'].main[0][0].node, 'Auto-approve?');
  assert.equal(wf.connections['Auto-approve?'].main[0][0].node, 'Append to Sheets');
  assert.equal(wf.connections['Auto-approve?'].main[1][0].node, 'Slack review');
  assert.ok(node('Sticky Note'));
});

test('no credentials or keys embedded', () => {
  const s = JSON.stringify(wf);
  assert.ok(!s.includes('"credentials"'));
  assert.ok(!/AIza[0-9A-Za-z_-]{20,}/.test(s));
  assert.match(s, /\$env\.GEMINI_API_KEY/);
});

// Execute the Validate node's code with n8n-style stubs.
async function runValidate(model, staticData = {}) {
  const code = node('Validate').parameters.jsCode;
  const fn = new Function('$input', '$env', '$getWorkflowStaticData', '$', code);
  const item = { json: { candidates: [{ content: { parts: [{ text: JSON.stringify(model) }] } }] } };
  return fn({ all: () => [item] }, {}, () => staticData, () => ({ all: () => [{ json: { from: 'ap@vendor.example', file_name: 'inv.pdf' } }] }));
}
const good = {
  vendor: 'Northwind Cloud, Inc.', invoice_number: 'INV-1', issue_date: '2026-10-01', due_date: '2026-10-31', currency: 'USD',
  line_items: [{ description: 'Seats', quantity: 25, unit_price: 24, amount: 600 }], subtotal: 600,
  tax_lines: [{ label: 'Sales tax', rate: 10, amount: 60 }], tax_total: 60, total: 660, payment_terms: 'Net 30',
  confidence: { vendor: 0.95, invoice_number: 0.95, issue_date: 0.95, due_date: 0.95, currency: 0.95, line_items: 0.95, subtotal: 0.95, tax_lines: 0.95, tax_total: 0.95, total: 0.95, payment_terms: 0.95 },
};

test('Validate node auto-approves a clean invoice, then flags its duplicate', async () => {
  const sd = {};
  const [first] = await runValidate(good, sd);
  assert.equal(first.json.auto_approve, true);
  assert.equal(first.json.row.total, 660);
  const [second] = await runValidate(good, sd);
  assert.equal(second.json.auto_approve, false);
  assert.deepEqual(second.json.failed_checks, ['duplicate']);
});

test('Validate node routes a total mismatch to review', async () => {
  const [r] = await runValidate({ ...good, invoice_number: 'INV-2', total: 700 });
  assert.equal(r.json.decision, 'review');
  assert.ok(r.json.failed_checks.includes('totals'));
});
