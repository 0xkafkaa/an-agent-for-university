import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { AcademicService } from '../src/service.js';
import { createApp } from '../src/server.js';
import { ChatManager } from '../src/chat.js';
import { fakeChatFactory } from '../test-support/fake-chat.js';
import { consumeChatStream } from '../public/chat-stream.js';

async function fixture(t) {
  const store = new Store(':memory:');
  const service = new AcademicService(store, { frenchStartDate: '2026-01-01', refreshMinutes: 15 });
  const fake = fakeChatFactory(async ({ call, answer }) => {
    const result = await call('create_assignment', { title: 'HTTP approved assignment' });
    answer(result.isError ? 'Not saved.' : 'Saved after approval.');
  });
  const chat = new ChatManager(service, fake);
  const server = createApp(service, 0, { chat });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { await chat.close(); server.close(); server.closeAllConnections(); await once(server, 'close'); store.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const html = await (await fetch(base)).text();
  const csrf = html.match(/name="csrf-token" content="([^"]+)"/)[1];
  const headers = { 'Content-Type': 'application/json', Origin: base, 'X-CSRF-Token': csrf };
  const post = (path, body = {}, extra = {}) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body), ...extra });
  return { service, chat, base, post, headers, stats: fake.stats };
}
async function wait(condition) { for (let i = 0; i < 200; i++) { if (await condition()) return; await sleep(5); } assert.fail('Chat HTTP wait timed out'); }

test('chat HTTP keeps host/origin/CSRF protections, lazily creates sessions, and serves local chat assets', async t => {
  const { base, post, stats } = await fixture(t);
  assert.equal((await post('/api/chat/sessions', {}, { headers: { 'Content-Type': 'application/json' } })).status, 403);
  assert.equal((await post('/api/chat/sessions', {}, { headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid', 'X-CSRF-Token': 'wrong' } })).status, 403);
  assert.equal((await post('/api/chat/sessions', {}, { headers: { Host: 'evil.invalid' } })).status, 403);
  assert.equal((await post('/api/chat/sessions', { apiKey: 'Never accepted' })).status, 400);
  const response = await post('/api/chat/sessions');
  assert.equal(response.status, 201);
  const snapshot = await response.json();
  assert.equal(snapshot.model, null);
  assert.deepEqual(snapshot.messages, []);
  assert.equal(stats.created, 0);
  assert.equal((await fetch(`${base}/api/chat/sessions/${snapshot.id}`)).status, 200);
  assert.equal((await fetch(`${base}/api/chat/sessions/${'a'.repeat(48)}`)).status, 404);
  for (const file of ['chat.js', 'chat-stream.js', 'chat.css']) {
    const asset = await fetch(`${base}/${file}`);
    assert.equal(asset.status, 200); assert.ok(asset.headers.get('content-security-policy').includes("default-src 'self'"));
  }
  assert.equal(stats.prompts.length, 0);
});

test('HTTP reply streaming waits for real approval, writes once, and rejects request/confirmation replay', async t => {
  const { service, chat, base, post } = await fixture(t);
  const { id } = await (await post('/api/chat/sessions')).json();
  const input = { text: 'Create an assignment', requestId: crypto.randomUUID() }, events = [];
  const response = await post(`/api/chat/sessions/${id}/messages`, input);
  assert.equal(response.status, 200);
  const consuming = consumeChatStream(response, event => events.push(event));
  await wait(() => events.some(e => e.type === 'confirmation'));
  assert.equal(service.records.list('assignments').total, 0);
  assert.equal((await post(`/api/chat/sessions/${id}/messages`, { text: 'Another', requestId: crypto.randomUUID() })).status, 409);
  const confirmation = events.find(e => e.type === 'confirmation');
  const approval = { confirmationId: confirmation.id, approved: true };
  assert.equal((await post(`/api/chat/sessions/${id}/confirm`, approval)).status, 200);
  await consuming;
  assert.equal(events.filter(e => e.type === 'done').length, 1);
  assert.equal(service.records.list('assignments').total, 1);
  assert.equal(service.records.list('assignments').items[0].dueDate, null);
  assert.equal((await post(`/api/chat/sessions/${id}/confirm`, approval)).status, 409);
  assert.equal((await post(`/api/chat/sessions/${id}/messages`, input)).status, 409);
  const snapshot = await (await fetch(`${base}/api/chat/sessions/${id}`)).json();
  assert.equal(snapshot.messages.at(-1).text, 'Saved after approval.');
  assert.equal(snapshot.state, 'idle');
  await chat.remove(id);
  assert.equal(service.records.list('assignments').total, 1, 'Clearing a chat never clears academic records');
});

test('disconnecting a POST stream cancels pending permission and never saves an unapproved change', async t => {
  const { service, chat, post } = await fixture(t);
  const { id } = await (await post('/api/chat/sessions')).json();
  const response = await post(`/api/chat/sessions/${id}/messages`, { text: 'Create', requestId: crypto.randomUUID() });
  await wait(() => chat.snapshot(id).confirmations.length === 1);
  await response.body.cancel();
  await wait(() => chat.snapshot(id).state === 'idle');
  assert.equal(chat.snapshot(id).confirmations.length, 0);
  assert.equal(service.records.list('assignments').total, 0);
});
