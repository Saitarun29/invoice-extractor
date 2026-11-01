import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/extract.js';
import status from '../api/status.js';
import { SAMPLES } from '../assets/samples.js';

delete process.env.GEMINI_API_KEY;
let ipn = 0;
function call(fn, { method = 'POST', body } = {}) {
  return new Promise((resolve) => {
    const res = {
      headers: {}, statusCode: 200,
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      status(c) { this.statusCode = c; return this; },
      json(o) { resolve({ status: this.statusCode, body: o, headers: this.headers }); return this; },
    };
    fn({ method, headers: { 'x-forwarded-for': `10.0.0.${++ipn}` }, body }, res);
  });
}

test('rejects non-POST with 405', async () => {
  const r = await call(handler, { method: 'GET' });
  assert.equal(r.status, 405);
  assert.equal(r.headers.allow, 'POST');
});

test('demo extraction returns the full contract', async () => {
  const r = await call(handler, { body: { text: SAMPLES[0].text, history: [] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.mode, 'demo');
  for (const k of ['invoice', 'confidence', 'checks', 'routing', 'flags', 'dup_key']) assert.ok(k in r.body, k);
  assert.equal(r.body.checks.length, 7);
});

test('input guards: oversize, too short, both inputs, bad mime', async () => {
  assert.equal((await call(handler, { body: { text: 'x'.repeat(20001) } })).status, 413);
  assert.equal((await call(handler, { body: { text: 'hi there' } })).status, 400);
  assert.equal((await call(handler, { body: { text: SAMPLES[0].text, file: { mime: 'application/pdf', data: 'AAAA' } } })).status, 400);
  assert.equal((await call(handler, { body: { file: { mime: 'text/html', data: 'AAAA' } } })).status, 415);
});

test('file upload in demo mode explains that live mode is needed', async () => {
  const r = await call(handler, { body: { file: { name: 'a.pdf', mime: 'application/pdf', data: 'JVBERi0xLjQK' } } });
  assert.equal(r.status, 422);
  assert.match(r.body.error, /live mode/);
});

test('status reports demo mode without exposing a key', async () => {
  const r = await call(status, { method: 'GET' });
  assert.equal(r.body.mode, 'demo');
  assert.ok(!JSON.stringify(r.body).includes('key'));
});
