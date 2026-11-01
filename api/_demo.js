// Demo mode extractor: a deterministic, rule-based parser for pasted invoice text.
// Returns the same contract as the live model ({ invoice, confidence, flags }),
// so validation, routing and the review queue behave identically without a key.
import { toNumber, toISODate, round2 } from '../assets/core.js';

const MONEY = String.raw`(?:₹|Rs\.?|INR|\$|USD|€|£)?\s*(-?[\d,]+\.\d{2})`;
const SKIP_ITEM = /\b(sub\s*-?total|total|tax|gst|cgst|sgst|igst|utgst|vat|taxable|round(?:ing)?\s*off|discount|balance|amount\s+due|amount\s+in\s+words|paid|bank|ifsc)\b/i;
const DATE_TOKEN = /(\d{4}-\d{1,2}-\d{1,2}|\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}|[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{2,4}|\d{1,2}(?:st|nd|rd|th)?[\s\-]+[A-Za-z]{3,9}\.?[\s\-,]+\d{2,4})/;
const TAX_ID = /\b(\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d])\b|\b(?:EIN|TIN|VAT(?:\s*(?:No|ID))?|ABN)\s*[:#]?\s*([A-Z]{0,2}[\d\- ]{6,14}\d)/i;

// OCR repair. Numeric tokens: O/o -> 0, I/l -> 1. Word tokens: a lone 0 among letters -> O.
export function repairLine(line) {
  let fixed = false;
  const out = line.replace(/\S+/g, (tok) => {
    if (/\d/.test(tok) && /^[\dOoIl.,/:\-]+$/.test(tok) && /[OoIl]/.test(tok) && /\d[\d.,/:\-]*[OoIl]|[OoIl][\d.,/:\-]*\d/.test(tok)) {
      fixed = true;
      return tok.replace(/[Oo]/g, '0').replace(/[Il]/g, '1');
    }
    if (/^[A-Za-z]*0[A-Za-z]*$/.test(tok) && (tok.match(/[A-Za-z]/g) || []).length >= 2 && !/[1-9]/.test(tok)) {
      fixed = true;
      return tok.replace(/0/g, 'O');
    }
    return tok;
  });
  return { text: out, fixed };
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s&(/-])([a-z])/g, (m, a, b) => a + b.toUpperCase())
  .replace(/\b(Pvt|Ltd|Llp|Llc|Inc)\b/g, (w) => ({ Pvt: 'Pvt', Ltd: 'Ltd', Llp: 'LLP', Llc: 'LLC', Inc: 'Inc' }[w]));
const lastMoney = (line) => {
  const all = [...line.matchAll(new RegExp(MONEY, 'g'))];
  return all.length ? toNumber(all[all.length - 1][1]) : null;
};

export function demoExtract(text) {
  const raw = String(text || '').replace(/\r/g, '').split('\n');
  const lines = raw.map((l) => { const r = repairLine(l.trim()); return { t: r.text, fixed: r.fixed }; }).filter((l) => l.t);
  const whole = lines.map((l) => l.t).join('\n');
  const inv = { line_items: [], tax_lines: [] };
  const conf = {};
  const flags = [];
  const set = (k, v, c, fixed) => { if (v === null || v === undefined || v === '') return; inv[k] = v; conf[k] = round2(fixed ? Math.min(c, 0.7) - 0.05 : c); };

  // Vendor: first line that is not a document title.
  const vIdx = lines.findIndex((l) => !/^(tax\s+)?invoice$|^receipt$|^bill$|^-+$/i.test(l.t) && /[A-Za-z]{3}/.test(l.t));
  if (vIdx >= 0) {
    const v = lines[vIdx].t.replace(/\s{2,}/g, ' ').trim();
    const looksLegal = /\b(pvt|ltd|inc|llc|llp|corp|gmbh|services|supplies|limited)\b/i.test(v);
    set('vendor', v === v.toUpperCase() ? titleCase(v) : v, looksLegal ? 0.94 : 0.86, lines[vIdx].fixed);
  }

  // Vendor tax ID: first GSTIN / EIN / VAT before the "Bill to" block.
  const billIdx = lines.findIndex((l) => /\bbill(?:ed)?\s*to\b/i.test(l.t));
  for (const l of lines.slice(0, billIdx > 0 ? billIdx : lines.length)) {
    const m = l.t.match(TAX_ID);
    if (m) { set('vendor_tax_id', (m[1] || m[2]).trim(), m[1] ? 0.97 : 0.9, l.fixed); break; }
  }

  // Bill to: rest of the label line, or the next line.
  if (billIdx >= 0) {
    const rest = lines[billIdx].t.replace(/^.*?\bbill(?:ed)?\s*to\b\s*[:\-]?\s*/i, '').trim();
    const v = rest || lines[billIdx + 1]?.t || '';
    set('bill_to', v.replace(/,\s*\d.*$/, '').trim() || v, rest ? 0.92 : 0.88, false);
  }

  for (const l of lines) {
    const t = l.t;
    if (!inv.invoice_number) {
      const m = t.match(/\b(?:invoice|inv|bill|receipt)\s*(?:no\.?|number|num|#)\s*[:#.\-]?\s*([A-Z0-9][A-Z0-9/\-_.]*[A-Z0-9])/i);
      if (m) set('invoice_number', m[1], /invoice/i.test(t) ? 0.97 : 0.88, l.fixed);
    }
    if (/\bdue\b/i.test(t) && !/\btotal\s+due\b|\bamount\s+due\b/i.test(t) && !inv.due_date) {
      const d = t.match(DATE_TOKEN);
      if (d) {
        const dayFirst = !/^[A-Za-z]/.test(d[1]);
        set('due_date', toISODate(d[1], { dayFirst }), 0.95, l.fixed);
      }
    } else if (/\b(invoice\s+date|issue\s+date|date\s+of\s+issue|bill\s+date|dated|dt|date)\b/i.test(t) && !inv.issue_date) {
      const d = t.match(DATE_TOKEN);
      if (d) {
        const twoDigit = /^\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2}$/.test(d[1]);
        set('issue_date', toISODate(d[1]), twoDigit ? 0.8 : 0.95, l.fixed);
      }
    }
    if (!inv.payment_terms) {
      const m = t.match(/\b(?:payment\s+terms|terms)\s*[:\-]\s*(.+)$/i);
      if (m) set('payment_terms', m[1].trim(), 0.93, l.fixed);
      else if (/^paid\s*[-:–]?\s*(upi|cash|card|neft|imps)\b/i.test(t)) set('payment_terms', 'Paid (' + t.match(/upi|cash|card|neft|imps/i)[0].toUpperCase() + ')', 0.84, l.fixed);
    }

    // Totals and tax lines
    if (/\b(sub\s*-?total|taxable\s+(?:value|amount)|net\s+amount)\b/i.test(t)) {
      const n = lastMoney(t);
      if (n !== null && inv.subtotal === undefined) set('subtotal', n, 0.96, l.fixed);
      continue;
    }
    const tax = t.match(/^(CGST|SGST|UTGST|IGST|VAT|GST|Sales\s+tax|Tax)\b(.*?)(\d+(?:\.\d+)?)\s*%/i);
    if (tax) {
      const n = lastMoney(t.slice(tax[0].length));
      if (n !== null) {
        const kw = tax[1].toUpperCase().includes('GST') || tax[1].toUpperCase() === 'VAT' ? tax[1].toUpperCase() : tax[1].replace(/^\w/, (c) => c.toUpperCase());
        const region = tax[2].replace(/[@(:]/g, ' ').trim();
        inv.tax_lines.push({ label: region && !/^\W*$/.test(region) ? `${kw} (${region})` : kw, rate: Number(tax[3]), amount: n });
        conf.tax_lines = Math.min(conf.tax_lines ?? 0.95, l.fixed ? 0.7 : 0.95);
        continue;
      }
    }
    if (/\b(grand\s+total|total\s+due|total\s+amount|amount\s+due|total)\b/i.test(t) && !/\bsub/i.test(t)) {
      const n = lastMoney(t);
      if (n !== null) set('total', n, /grand|due|amount/i.test(t) ? 0.97 : 0.94, l.fixed);
      continue;
    }

    // Line items: [index] description [HSN] qty [x] unit_price amount
    if (SKIP_ITEM.test(t)) continue;
    const m = t.match(new RegExp(String.raw`^(?:\d{1,3}[.)]?\s+)?(.+?)\s+(?:(\d{4,8})\s+)?(\d+(?:\.\d+)?)\s*(?:x|×|@)?\s+` + MONEY + String.raw`\s+` + MONEY + '$'));
    if (m && /[A-Za-z]/.test(m[1])) {
      const quantity = Number(m[3]);
      const unit_price = toNumber(m[4]);
      const amount = toNumber(m[5]);
      inv.line_items.push({ description: m[1].replace(/\s{2,}/g, ' ').trim(), quantity, unit_price, amount });
      const consistent = Math.abs(Math.round(quantity * unit_price * 100) - Math.round(amount * 100)) <= 1;
      conf.line_items = Math.min(conf.line_items ?? 0.95, l.fixed ? 0.72 : consistent ? 0.95 : 0.8);
    }
  }

  if (inv.tax_lines.length) inv.tax_total = round2(inv.tax_lines.reduce((s, x) => s + x.amount, 0));
  if (inv.tax_lines.length) conf.tax_total = conf.tax_lines;

  // Currency: explicit code, then symbol, then Indian GSTIN as a hint.
  const code = whole.match(/\((INR|USD|EUR|GBP|AUD|SGD|AED|CAD)\)|\b(INR|USD|EUR|GBP|AUD|SGD|AED|CAD)\b/);
  if (code) set('currency', code[1] || code[2], 0.97, false);
  else if (/₹|\bRs\.?\s|\bRupees\b/i.test(whole)) set('currency', 'INR', 0.9, false);
  else if (/\$/.test(whole)) set('currency', 'USD', 0.86, false);
  else if (/€/.test(whole)) set('currency', 'EUR', 0.9, false);
  else if (/£/.test(whole)) set('currency', 'GBP', 0.9, false);
  else if (inv.vendor_tax_id && /^\d{2}[A-Z]{5}/.test(inv.vendor_tax_id)) set('currency', 'INR', 0.8, false);

  // Risk notes a reviewer should see. They do not change routing on their own.
  if (/bank\s+(details|account)\s+(have\s+|has\s+)?changed|new\s+bank\s+(details|account)/i.test(whole)) flags.push('Bank details changed on this invoice. Confirm with the vendor through a known channel before paying.');
  if (/\b(urgent|immediately|within\s+24\s+hours)\b/i.test(whole) && /\bpay/i.test(whole)) flags.push('Payment urgency language.');
  if (lines.some((l) => l.fixed)) flags.push('OCR corrections applied (letters read as digits or the reverse). Fields from those lines carry lower confidence.');

  return { invoice: inv, confidence: conf, flags };
}
