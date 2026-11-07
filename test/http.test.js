import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { Store } from '../src/store.js';
import { AcademicService } from '../src/service.js';
import { createApp } from '../src/server.js';

test('localhost UI and schedule work without a model; writes require origin and CSRF token', async t => {
  const store = new Store(':memory:');
  const service = new AcademicService(store, { frenchStartDate: '2026-01-01', refreshMinutes: 15 }, async () => { throw new Error('offline'); });
  const server = createApp(service, 0);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    server.closeAllConnections();
    await once(server, 'close');
    await service.stop();
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.ok(html.replace(/\s+/g, ' ').includes('Academic Manager'));
  assert.ok(!html.includes('__CSRF__'));
  assert.ok(!html.includes('calendarUrl'));
  assert.ok(page.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
  const result = await (await fetch(`${base}/api/schedule?date=2026-10-20&view=day`)).json();
  assert.equal(result.events.length, 1);
  assert.equal(result.sync.hasCache, false);
  assert.equal((await fetch(`${base}/api/schedule?date=invalid`)).status, 400);
  assert.equal((await fetch(`${base}/api/sync`, { method: 'POST' })).status, 403);
  const invalidHostStatus = await new Promise((resolve, reject) => {
    const req = request(base, { headers: { host: 'evil.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(invalidHostStatus, 403);
  const token = html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const localhostOrigin = `http://localhost:${server.address().port}`;
  async function localhostRequest(path, method = 'GET', origin = localhostOrigin) {
    return new Promise((resolve, reject) => {
      const req = request(`${base}${path}`, {
        method,
        headers: { Host: `localhost:${server.address().port}`, Origin: origin, 'X-CSRF-Token': token },
      }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }
  const localhostPage = await localhostRequest('/');
  assert.equal(localhostPage.status, 200);
  assert.ok(localhostPage.body.replace(/\s+/g, ' ').includes('Academic Manager'));
  assert.equal((await localhostRequest('/api/schedule?date=2026-10-20&view=day')).status, 200);
  assert.equal((await localhostRequest('/api/sync', 'POST')).status, 200);
  assert.equal((await localhostRequest('/api/sync', 'POST', base)).status, 403);
  const headers = { 'X-CSRF-Token': token, Origin: base, 'Content-Type': 'application/json' };
  const sync = await (await fetch(`${base}/api/sync`, { method: 'POST', headers })).json();
  assert.equal(sync.ok, false);
  const e = result.events[0];
  const override = await fetch(`${base}/api/occurrence`, { method: 'POST', headers, body: JSON.stringify({ uid: e.uid, recurrenceId: e.recurrenceId, cancelled: true, confirmed: true }) });
  assert.equal(override.status, 200);
  assert.equal(service.schedule('2026-10-20', 'day').events.length, 0);
  const crossOrigin = await fetch(`${base}/api/sync`, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' } });
  assert.equal(crossOrigin.status, 403);
});
