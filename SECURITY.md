# Security

- The Gemini key is read on the server from `GEMINI_API_KEY` and is never sent to the browser. `/api/status` reports only whether live mode is on.
- `/api/extract` accepts POST only, caps text at 20,000 characters and uploads at 3 MB (PDF, PNG, JPEG, WebP), rate limits each IP (20 requests a minute per instance), and times out model calls after 25 seconds.
- Documents are sent to the model for extraction and are not stored server-side. The review queue, approved rows and duplicate history live in the visitor's browser (localStorage).
- CSV export prefixes cells that start with `=`, `+`, `-` or `@` so spreadsheet apps do not run them as formulas.
- The n8n workflow embeds no credentials. It reads `GEMINI_API_KEY`, `INVOICE_SHEET_ID` and `SLACK_REVIEW_CHANNEL` from `$env`, and you attach Gmail, Google Sheets and Slack credentials after import.

Report a vulnerability privately through a GitHub security advisory on this repository rather than a public issue.
