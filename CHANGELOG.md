# Changelog

## 0.1.0 · 2026-11-01

Initial release.

- Paste invoice text or upload a PDF or image (live mode sends files to Gemini 2.0 Flash as inline data).
- Clean JSON: vendor, tax ID, bill-to, invoice number, dates, currency, line items, subtotal, tax lines (CGST, SGST, IGST, VAT, sales tax), total, payment terms.
- Per-field confidence and seven validation checks: required fields, line arithmetic, line items sum, tax breakdown, totals, dates, duplicate invoice number in the session.
- Routing: auto-approve when every check passes and minimum confidence is at least 0.85, otherwise a review queue with editable fields and live re-validation.
- CSV export of approved rows.
- Demo mode with a rule-based parser and four sample documents, no keys required.
- n8n workflow: Gmail attachment trigger, Gemini extraction, Code-node validation, Google Sheets append or Slack review message.
