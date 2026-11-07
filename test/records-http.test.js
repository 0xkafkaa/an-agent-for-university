import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Store } from '../src/store.js';
import { AcademicService } from '../src/service.js';
import { createApp } from '../src/server.js';

test('assignment/exam API, forms and assets work offline with validation and protected writes', async t => {
  const store = new Store(':memory:');
  const service = new AcademicService(store, { frenchStartDate: '2026-01-01', refreshMinutes: 15 }, async () => { throw new Error('offline'); });
  const server = createApp(service, 0);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close(); server.closeAllConnections(); await once(server, 'close');
    await service.stop(); store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await (await fetch(base)).text();
  assert.ok(page.includes('id="assignments-form"'));
  assert.ok(page.includes('id="exams-form"'));
  for (const asset of ['app.js', 'client.js', 'records.js']) {
    const result = await fetch(`${base}/${asset}`);
    assert.equal(result.status, 200);
    assert.ok(result.headers.get('content-type').includes('javascript'));
  }
  const token = page.match(/name="csrf-token" content="([^"]+)"/)[1];
  const headers = { Origin: base, 'X-CSRF-Token': token, 'Content-Type': 'application/json' };
  async function call(path, body, method = body === undefined ? 'GET' : 'POST', overrides = {}) {
    const response = await fetch(`${base}${path}`, { method, headers: { ...headers, ...overrides }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await call('/api/assignments')).data.total, 0);
  assert.equal((await call('/api/exams')).data.total, 0);
  assert.equal((await call('/api/assignments', { title: 'Blocked' }, 'POST', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call('/api/exams', { subject: 'Blocked' }, 'POST', { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await call('/api/assignments', { title: 'Bad', dueDate: 'next Friday' })).status, 400);
  const created = await call('/api/assignments', { title: '<script>untrusted</script>', course: 'Python' });
  assert.equal(created.status, 201);
  assert.equal(created.data.dueDate, null);
  const a = created.data;
  assert.equal((await call(`/api/assignments/${a.id}`)).data.title, '<script>untrusted</script>');
  const edited = await call(`/api/assignments/${a.id}`, { version: 1, changes: { description: 'Updated', dueDate: '2026-11-20' } }, 'PATCH');
  assert.equal(edited.status, 200);
  assert.equal(edited.data.dueTime, null);
  assert.equal((await call(`/api/assignments/${a.id}`, { version: 1, changes: { title: 'Stale' } }, 'PATCH')).status, 409);
  assert.equal((await call(`/api/assignments/${a.id}`, { id: a.id, version: 2, changes: { title: 'Forged path' } }, 'PATCH')).status, 400);
  const completed = await call(`/api/assignments/${a.id}/complete`, { version: 2 });
  assert.equal(completed.data.status, 'completed');
  assert.equal((await call('/api/assignments?status=completed&course=Python')).data.total, 1);
  for (const query of ['limit=no', 'limit=1&limit=2', 'undated=maybe', 'unexpected=true', 'from=2026-02-30', '__proto__=bad']) assert.equal((await call(`/api/assignments?${query}`)).status, 400);
  assert.equal((await call(`/api/assignments/${a.id}`, { version: 3 }, 'DELETE')).status, 403);
  assert.equal((await call(`/api/assignments/${a.id}`, { version: 2, confirmed: true }, 'DELETE')).status, 409);
  assert.equal((await call(`/api/assignments/${a.id}`, { version: 3, confirmed: true }, 'DELETE', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(`/api/assignments/${a.id}`, { version: 3, confirmed: true }, 'DELETE')).data.deleted, true);
  assert.equal((await call(`/api/assignments/${a.id}`)).status, 404);
  const exam = await call('/api/exams', { subject: 'Linear algebra', examDate: '2026-11-20', startTime: '09:00', topics: ['Matrices'] });
  assert.equal(exam.status, 201);
  assert.equal(exam.data.durationMinutes, null);
  assert.equal((await call('/api/exams?from=2026-11-01&to=2026-11-30')).data.total, 1);
  assert.equal((await call(`/api/exams/${exam.data.id}`, { version: 1, changes: { preparationStatus: 'ready' } }, 'PATCH')).data.preparationStatus, 'ready');
  assert.equal((await call(`/api/exams/${exam.data.id}`, { version: 2, confirmed: true }, 'DELETE')).status, 200);
  const malformed = await fetch(`${base}/api/assignments`, { method: 'POST', headers, body: '{not JSON' });
  assert.equal(malformed.status, 400);
  const tooLarge = await call('/api/exams', { subject: 'x'.repeat(70000) });
  assert.equal(tooLarge.status, 413);
  assert.equal((await call('/api/assignments', { title: 'Wrong media' }, 'POST', { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await call('/api/assignments', [{ title: 'Bulk' }])).status, 400);
  assert.equal((await call('/api/assignments')).data.total, 0);
  assert.equal(service.schedule('2026-10-20', 'day').events.length, 1);
});
