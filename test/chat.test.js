import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { DateTime } from 'luxon';
import { Store } from '../src/store.js';
import { AcademicService } from '../src/service.js';
import { ChatManager } from '../src/chat.js';
import { fakeChatFactory } from '../test-support/fake-chat.js';
import { consumeChatStream } from '../public/chat-stream.js';

function fixture(t, respond, options = {}) {
  const store = new Store(':memory:');
  const service = new AcademicService(store, { frenchStartDate: '2026-01-01', refreshMinutes: 15, calendarUrl: 'https://fixture.invalid/ics/private-fixture-token' }, () => { throw new Error('No network in this test.'); }, () => DateTime.fromISO('2026-11-19T10:00:00', { zone: 'Europe/Paris' }));
  const fake = fakeChatFactory(respond);
  const chat = new ChatManager(service, { ...fake, ...options });
  t.after(async () => { await chat.close(); store.close(); });
  return { chat, service, store, stats: fake.stats };
}
async function wait(condition) {
  for (let i = 0; i < 200; i++) { if (condition()) return; await sleep(5); }
  assert.fail('Timed out waiting for chat state');
}
const message = text => ({ text, requestId: crypto.randomUUID() });

test('chat is lazy, streams real tool-backed data, redacts feed secrets and reuses a bounded in-memory session', async t => {
  const { chat, service, stats } = fixture(t, async ({ text, call, answer }) => {
    const result = await call('list_assignments', {});
    answer(`Read ${result.structuredContent.total} assignments. ${text}`);
  });
  service.records.create('assignments', { title: 'Synthetic probability' });
  const { id } = chat.create();
  assert.equal(stats.created, 0);
  assert.equal(chat.snapshot(id).state, 'idle');
  const events = [];
  await chat.start(id, message('Read https://fixture.invalid/ics/private-fixture-token'), event => events.push(event)).done;
  assert.equal(stats.created, 1);
  assert.ok(events.some(e => e.type === 'tool' && e.name === 'list_assignments' && e.status === 'completed'));
  assert.ok(events.filter(e => e.type === 'assistant_text').length > 2);
  assert.ok(chat.snapshot(id).messages.at(-1).text.includes('Read 1 assignments'));
  assert.ok(!JSON.stringify(events).includes('private-fixture-token'));
  assert.ok(!stats.prompts.join('').includes('private-fixture-token'));
  await chat.start(id, message('Again'), () => {}).done;
  assert.equal(stats.created, 1);
  assert.equal(stats.prompts.length, 2);
  await chat.close(); await chat.close();
  assert.equal(stats.disposed, 1);
});

test('every academic mutation needs a fresh, one-time approval, including updates, completion and deletions', async t => {
  let operation, params;
  const { chat, service } = fixture(t, async ({ call, answer }) => {
    const result = await call(operation, params);
    answer(result.isError ? 'Change failed or was denied.' : 'Change completed.');
  });
  const { id } = chat.create();
  async function mutate(name, input, approved = true) {
    operation = name; params = input;
    const before = service.store?.db?.prepare('SELECT total_changes() AS n').get().n;
    const events = [];
    const run = chat.start(id, message(name), e => events.push(e));
    await wait(() => events.some(e => e.type === 'confirmation'));
    const confirmation = events.find(e => e.type === 'confirmation');
    assert.equal(chat.snapshot(id).confirmations.length, 1);
    assert.equal(service.store?.db?.prepare('SELECT total_changes() AS n').get().n, before);
    assert.throws(() => chat.approve(id, { confirmationId: confirmation.id, approved: 'true' }), /Invalid confirmation/);
    chat.approve(id, { confirmationId: confirmation.id, approved });
    assert.throws(() => chat.approve(id, { confirmationId: confirmation.id, approved: true }), /no longer active/);
    await run.done;
    assert.equal(events.filter(e => e.type === 'data_changed').length, approved ? 1 : 0);
    return confirmation;
  }
  await mutate('create_assignment', { title: 'Denied item' }, false);
  assert.equal(service.records.list('assignments').total, 0);
  await mutate('create_assignment', { title: 'Approved item' });
  let assignment = service.records.list('assignments').items[0];
  assert.equal(assignment.dueDate, null);
  const preview = await mutate('update_assignment', { id: assignment.id, version: assignment.version, changes: { title: 'Updated item' } });
  assert.ok(preview.message.includes('Approved item'));
  assignment = service.records.get('assignments', assignment.id);
  await mutate('complete_assignment', { id: assignment.id, version: assignment.version });
  assignment = service.records.get('assignments', assignment.id);
  assert.equal(assignment.status, 'completed');
  await mutate('create_exam', { subject: 'Fixture algebra' });
  let exam = service.records.list('exams').items[0];
  await mutate('update_exam', { id: exam.id, version: exam.version, changes: { topics: ['Matrices'] } });
  exam = service.records.get('exams', exam.id);
  await mutate('delete_exam', { id: exam.id, version: exam.version }, false);
  assert.equal(service.records.list('exams').total, 1);
  await mutate('delete_exam', { id: exam.id, version: exam.version });
  await mutate('delete_assignment', { id: assignment.id, version: assignment.version });
  assert.equal(service.records.list('assignments').total, 0);
  assert.equal(service.records.list('exams').total, 0);
});

test('approval is bound to its chat and exact current version; stale edits never overwrite browser changes', async t => {
  let target;
  const { chat, service } = fixture(t, async ({ call }) => { await call('update_assignment', { id: target.id, version: target.version, changes: { title: 'AI change' } }); });
  target = service.records.create('assignments', { title: 'Original' });
  const { id } = chat.create(), other = chat.create().id;
  const events = [];
  const run = chat.start(id, message('Update'), e => events.push(e));
  await wait(() => events.some(e => e.type === 'confirmation'));
  const approval = events.find(e => e.type === 'confirmation');
  assert.throws(() => chat.approve(other, { confirmationId: approval.id, approved: true }), /no longer active/);
  service.records.update('assignments', { id: target.id, version: target.version, changes: { title: 'Browser change' } });
  chat.approve(id, { confirmationId: approval.id, approved: true });
  await run.done;
  assert.equal(service.records.get('assignments', target.id).title, 'Browser change');
  assert.ok(events.some(e => e.type === 'tool' && e.status === 'failed'));
  assert.ok(!events.some(e => e.type === 'data_changed'));
});

test('busy/duplicate requests are rejected; cancellation and expired approvals fail closed', async t => {
  const { chat, service } = fixture(t, async ({ call }) => { await call('create_assignment', { title: 'Must not be saved' }); }, { approvalTimeoutMs: 30 });
  const { id } = chat.create();
  const input = message('Create');
  const events = [];
  const run = chat.start(id, input, e => events.push(e));
  assert.throws(() => chat.start(id, message('Second'), () => {}), /current reply/);
  await wait(() => events.some(e => e.type === 'confirmation'));
  chat.cancel(id);
  await run.done;
  assert.equal(service.records.list('assignments').total, 0);
  assert.equal(chat.snapshot(id).confirmations.length, 0);
  assert.throws(() => chat.start(id, input, () => {}), /already submitted/);
  const expired = [];
  const second = chat.start(id, message('Create again'), e => expired.push(e));
  await sleep(60); await second.done;
  assert.ok(expired.some(e => e.type === 'confirmation_resolved' && e.reason === 'expired' && !e.approved));
  assert.equal(service.records.list('assignments').total, 0);
});

test('bulk writes cannot be emulated by repeated tool calls in one message', async t => {
  const { chat, service } = fixture(t, async ({ call }) => {
    await call('create_assignment', { title: 'First' });
    await call('create_assignment', { title: 'Second' });
  });
  const { id } = chat.create(), events = [];
  const run = chat.start(id, message('Bulk attempt'), e => events.push(e));
  await wait(() => events.some(e => e.type === 'confirmation'));
  chat.approve(id, { confirmationId: events.find(e => e.type === 'confirmation').id, approved: true });
  await run.done;
  assert.equal(events.filter(e => e.type === 'confirmation').length, 1);
  assert.equal(service.records.list('assignments').total, 1);
  assert.ok(events.some(e => e.type === 'tool' && e.status === 'failed'));
});

test('provider failures never disclose errors/credentials, and academic features remain usable', async t => {
  const { chat, service } = fixture(t, async () => { throw new Error('Provider failure Authorization: SECRET https://fixture.invalid/ics/private-fixture-token'); });
  const { id } = chat.create(), events = [];
  await chat.start(id, message('Hello'), e => events.push(e)).done;
  assert.ok(events.some(e => e.type === 'error' && e.code === 'assistant_unavailable'));
  assert.ok(!JSON.stringify(events).includes('SECRET'));
  assert.ok(!JSON.stringify(chat.snapshot(id)).includes('SECRET'));
  assert.equal(chat.snapshot(id).state, 'idle');
  assert.equal(service.records.create('assignments', { title: 'Still works offline' }).title, 'Still works offline');
  assert.equal(service.overview().timezone, 'Europe/Paris');
});

test('chat input, bounded thread storage, idle expiry and turn timeouts are enforced', async t => {
  const { chat } = fixture(t, ({ signal }) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })), { maxThreads: 1, idleTimeoutMs: 30, turnTimeoutMs: 20 });
  const { id } = chat.create();
  assert.throws(() => chat.create(), /Too many/);
  for (const value of [{}, message(' '), message('x'.repeat(8001)), { ...message('Hello'), confirmed: true }]) assert.throws(() => chat.start(id, value, () => {}), /Provide a message/);
  const events = [];
  const run = chat.start(id, message('Wait'), e => events.push(e));
  await sleep(40); await run.done;
  assert.ok(events.some(e => e.type === 'error' && e.code === 'turn_timeout'));
  await sleep(40);
  assert.throws(() => chat.snapshot(id), /expired/);
  assert.notEqual(chat.create().id, id);
});

test('an approved write remains visible when the provider fails afterward; recovery never claims rollback', async t => {
  const { chat, service } = fixture(t, async ({ call }) => {
    await call('create_assignment', { title: 'Committed before provider failure' });
    throw new Error('Private provider diagnostic');
  });
  const { id } = chat.create(), events = [];
  const run = chat.start(id, message('Create'), e => events.push(e));
  await wait(() => events.some(e => e.type === 'confirmation'));
  chat.approve(id, { confirmationId: events.find(e => e.type === 'confirmation').id, approved: true });
  await run.done;
  assert.equal(service.records.list('assignments').total, 1);
  assert.ok(events.some(e => e.type === 'data_changed'));
  assert.equal(chat.snapshot(id).lastOutcome, 'failed');
  assert.ok(chat.snapshot(id).lastError.message.includes('already approved changes are not undone'));
  assert.ok(!chat.snapshot(id).lastError.message.includes('unaffected'));
});

test('tool-call limits interrupt runaway provider loops without changing academic data', async t => {
  const { chat, service } = fixture(t, async ({ call }) => {
    for (let i = 0; i < 26; i++) await call('list_assignments', {});
  });
  const { id } = chat.create(), events = [];
  await chat.start(id, message('Read'), e => events.push(e)).done;
  assert.equal(chat.snapshot(id).lastError.code, 'tool_limit');
  assert.equal(events.filter(e => e.type === 'tool' && e.status === 'completed').length, 24);
  assert.equal(service.records.list('assignments').total, 0);
});

test('NDJSON parser handles arbitrary UTF-8 boundaries, malformed streams and HTTP failures', async () => {
  const data = new TextEncoder().encode('{"type":"assistant_text","text":"été 🇫🇷"}\n{"type":"done"}\n');
  const response = new Response(new ReadableStream({ start(stream) { for (const byte of data) stream.enqueue(Uint8Array.of(byte)); stream.close(); } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  const events = [];
  await consumeChatStream(response, e => events.push(e));
  assert.equal(events[0].text, 'été 🇫🇷');
  assert.equal(events[1].type, 'done');
  await assert.rejects(consumeChatStream(new Response('{"error":"Busy"}', { status: 409 }), () => {}), /Busy/);
  await assert.rejects(consumeChatStream(new Response('bad\n', { headers: { 'Content-Type': 'application/x-ndjson' } }), () => {}));
});
