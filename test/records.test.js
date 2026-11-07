import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { Store } from '../src/store.js';
import { MIGRATIONS } from '../src/migrations.js';
import { RecordsService, recordSchemas, validate } from '../src/records.js';
import { registerRecordTools } from '../src/record-tools.js';

function setup(t, initial = '2026-10-25T12:00:00') {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let now = DateTime.fromISO(initial, { zone: 'Europe/Paris' });
  const records = new RecordsService(store, () => now);
  return { store, records, advance: () => { now = now.plus({ minutes: 1 }); } };
}
const fails = (fn, status = 400) => assert.throws(fn, error => error.status === status);

test('v1 migration preserves cached calendar and French overrides, and v2 reopens without resetting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'academic-migrate-'));
  const path = join(dir, 'data.sqlite');
  let store;
  try {
    const db = new DatabaseSync(path);
    db.exec(MIGRATIONS[0]);
    db.exec("UPDATE calendar_sources SET ics='cached ICS',last_synced_at='2026-10-25T10:00:00Z'; INSERT INTO local_events(uid,ics) VALUES ('french-2','local ICS'); INSERT INTO occurrence_overrides VALUES ('french-2','occurrence',1,NULL,'2026-10-25T10:00:00Z'); PRAGMA user_version=1;");
    db.close();
    store = new Store(path);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(store.source().ics, 'cached ICS');
    assert.equal(store.overrides().length, 1);
    const records = new RecordsService(store);
    const assignment = records.create('assignments', { title: 'Persistence' });
    const exam = records.create('exams', { subject: 'Algebra', topics: ['Eigenvectors'] });
    records.update('exams', { id: exam.id, version: exam.version, changes: { location: 'Room 1' } });
    store.close();
    store = new Store(path);
    const reopened = new RecordsService(store);
    assert.equal(reopened.get('assignments', assignment.id).title, 'Persistence');
    assert.equal(reopened.get('exams', exam.id).version, 2);
    assert.deepEqual(reopened.get('exams', exam.id).topics, ['Eigenvectors']);
    assert.equal(store.source().ics, 'cached ICS');
    assert.equal(store.overrides().length, 1);
    assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed migration rolls back new tables and schema version without losing v1 data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'academic-rollback-'));
  const path = join(dir, 'data.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec(MIGRATIONS[0]);
    db.exec("UPDATE calendar_sources SET ics='keep'; CREATE TABLE exams(existing TEXT); INSERT INTO exams VALUES ('keep'); PRAGMA user_version=1;");
    db.close();
    assert.throws(() => new Store(path), /already exists/);
    const reopened = new DatabaseSync(path);
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(reopened.prepare('SELECT ics FROM calendar_sources').get().ics, 'keep');
    assert.equal(reopened.prepare('SELECT existing FROM exams').get().existing, 'keep');
    assert.equal(reopened.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name='assignments'").get().count, 0);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('future database versions are refused without resetting data or schema version', () => {
  const dir = mkdtempSync(join(tmpdir(), 'academic-future-'));
  const path = join(dir, 'data.sqlite');
  try {
    const db = new DatabaseSync(path);
    db.exec('PRAGMA user_version=99; CREATE TABLE future_data(value TEXT); INSERT INTO future_data VALUES (\'keep\');');
    db.close();
    assert.throws(() => new Store(path), /newer/);
    const reopened = new DatabaseSync(path);
    assert.equal(reopened.prepare('PRAGMA user_version').get().user_version, 99);
    assert.equal(reopened.prepare('SELECT value FROM future_data').get().value, 'keep');
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('create preserves missing information, timestamps, defaults and date-only deadlines', t => {
  const { records } = setup(t);
  const unknown = records.create('assignments', { title: '  Probability exercises  ' });
  assert.equal(unknown.title, 'Probability exercises');
  assert.equal(unknown.dueDate, null);
  assert.equal(unknown.dueTime, null);
  assert.equal(unknown.estimatedMinutes, null);
  assert.equal(unknown.deadlineState, 'unknown');
  assert.equal(unknown.status, 'pending');
  assert.equal(unknown.priority, 'normal');
  assert.equal(unknown.createdAt, unknown.modifiedAt);
  const dateOnly = records.create('assignments', { title: 'Python', dueDate: '2026-10-25' });
  assert.equal(dateOnly.dueTime, null);
  assert.equal(dateOnly.deadlineState, 'due_today');
  const exam = records.create('exams', { subject: 'Algebra' });
  for (const key of ['examDate', 'startTime', 'durationMinutes', 'location']) assert.equal(exam[key], null);
  assert.deepEqual(exam.topics, []);
  validate(recordSchemas.assignments.output, unknown);
  validate(recordSchemas.exams.output, exam);
});

test('partial updates preserve omitted fields, allow explicit clearing, and completion is persistent', t => {
  const { records, advance } = setup(t);
  const a = records.create('assignments', { title: 'Database', course: 'SQL', dueDate: '2026-11-01', dueTime: '09:00', description: 'Project', estimatedMinutes: 120 });
  advance();
  const edited = records.update('assignments', { id: a.id, version: a.version, changes: { status: 'in_progress', priority: 'high' } });
  assert.equal(edited.course, 'SQL');
  assert.equal(edited.dueTime, '09:00');
  assert.equal(edited.createdAt, a.createdAt);
  assert.ok(edited.modifiedAt > a.modifiedAt);
  assert.equal(edited.version, 2);
  fails(() => records.update('assignments', { id: a.id, version: 2, changes: { dueDate: null } }));
  assert.equal(records.get('assignments', a.id).version, 2);
  const cleared = records.update('assignments', { id: a.id, version: 2, changes: { dueDate: null, dueTime: null, estimatedMinutes: null } });
  assert.equal(cleared.description, 'Project');
  assert.equal(cleared.dueDate, null);
  const completed = records.complete({ id: a.id, version: cleared.version });
  assert.equal(completed.status, 'completed');
  assert.equal(records.list('assignments', { status: 'completed' }).total, 1);
  assert.equal(records.get('assignments', a.id).deadlineState, 'completed');
});

test('exam updates store known details and topics without inventing missing time/duration', t => {
  const { records } = setup(t);
  const exam = records.create('exams', { subject: 'Algebra', examDate: '2026-11-20', topics: ['  Matrices  '] });
  const updated = records.update('exams', { id: exam.id, version: 1, changes: { preparationStatus: 'in_progress', location: 'Lab' } });
  assert.equal(updated.startTime, null);
  assert.equal(updated.durationMinutes, null);
  assert.deepEqual(updated.topics, ['Matrices']);
  assert.equal(updated.location, 'Lab');
  assert.equal(records.list('exams', { preparationStatus: 'in_progress', query: 'matrices', period: 'next_month' }).total, 1);
});

test('strict validation rejects invalid records and unknown or immutable fields', t => {
  const { records } = setup(t);
  for (const input of [null, [], {}, { title: '' }, { title: '  ' }, { title: 'x'.repeat(301) }, { title: 'A', dueDate: 'next Friday' }, { title: 'A', dueDate: '2026-02-30' }, { title: 'A', dueTime: '09:00' }, { title: 'A', dueDate: '2026-10-25', dueTime: '25:00' }, { title: 'A', priority: 'urgent' }, { title: 'A', status: 'done' }, { title: 'A', estimatedMinutes: 0 }, { title: 'A', estimatedMinutes: 2.5 }, { title: 'A', estimatedMinutes: NaN }, { title: 'A', timezone: 'UTC' }, { title: 'A', createdAt: 'fake' }, { title: 'A', confirmed: true }]) fails(() => records.create('assignments', input));
  for (const input of [{ subject: 'A', topics: 'Matrices' }, { subject: 'A', topics: [''] }, { subject: 'A', topics: Array(101).fill('Topic') }, { subject: 'A', durationMinutes: -5 }, { subject: 'A', startTime: '09:00' }, { subject: 'A', preparationStatus: 'done' }]) fails(() => records.create('exams', input));
  const a = records.create('assignments', { title: 'A' });
  for (const changes of [{}, { id: a.id }, { version: 999 }, { createdAt: 'fake' }, { title: null }]) fails(() => records.update('assignments', { id: a.id, version: 1, changes }));
  fails(() => records.get('assignments', "' OR 1=1--"));
  fails(() => records.create('constructor', { title: 'x' }));
  assert.equal(records.list('assignments').total, 1);
});

test('nonexistent and ambiguous Paris wall times are rejected without guessing', t => {
  const { records } = setup(t);
  for (const day of ['2026-03-29', '2026-10-25']) {
    fails(() => records.create('assignments', { title: 'DST', dueDate: day, dueTime: '02:30' }));
    fails(() => records.create('exams', { subject: 'DST', examDate: day, startTime: '02:30' }));
    assert.equal(records.create('exams', { subject: 'Valid', examDate: day, startTime: '09:00' }).startTime, '09:00');
  }
});

test('stale update, completion, deletion and missing records fail safely', t => {
  const { records } = setup(t);
  const a = records.create('assignments', { title: 'Current' });
  records.update('assignments', { id: a.id, version: 1, changes: { title: 'New' } });
  fails(() => records.update('assignments', { id: a.id, version: 1, changes: { title: 'Lost update' } }), 409);
  fails(() => records.complete({ id: a.id, version: 1 }), 409);
  fails(() => records.delete('assignments', { id: a.id, version: 1 }, true), 409);
  fails(() => records.delete('assignments', { id: a.id, version: 2 }), 403);
  assert.equal(records.get('assignments', a.id).title, 'New');
  records.delete('assignments', { id: a.id, version: 2 }, true);
  fails(() => records.get('assignments', a.id), 404);
});

test('filters include Paris week boundaries, exclude unknown dates, and paginate stably', t => {
  const { records } = setup(t);
  for (const [title, dueDate, status, priority] of [['Monday', '2026-10-19', 'pending', 'high'], ['Sunday', '2026-10-25', 'in_progress', 'normal'], ['Next week', '2026-10-26', 'pending', 'high'], ['Next month', '2026-11-20', 'pending', 'low'], ['Unknown', null, 'pending', 'normal']]) records.create('assignments', { title, dueDate, status, priority, course: 'Probability' });
  assert.equal(records.list('assignments', { period: 'this_week' }).total, 2);
  assert.equal(records.list('assignments', { period: 'next_week' }).total, 1);
  assert.equal(records.list('assignments', { period: 'next_month' }).total, 1);
  assert.equal(records.list('assignments', { undated: true }).total, 1);
  assert.equal(records.list('assignments', { course: 'probability', status: 'pending', priority: 'high' }).total, 2);
  assert.equal(records.list('assignments', { query: "' OR 1=1--" }).total, 0);
  const first = records.list('assignments', { limit: 2 });
  const second = records.list('assignments', { limit: 2, offset: 2 });
  assert.equal(first.total, 5);
  assert.equal(first.hasMore, true);
  assert.ok(!first.items.some(a => second.items.some(b => a.id === b.id)));
  assert.equal(records.list('assignments', { limit: 2, offset: 4 }).hasMore, false);
  for (const filters of [{ from: '2026-02-30' }, { from: '2026-11-01', to: '2026-10-01' }, { period: 'this_week', from: '2026-10-01' }, { period: 'yesterday' }, { undated: true, period: 'this_week' }, { limit: 201 }, { offset: -1 }, { overdue: 'true' }, { unknown: true }]) fails(() => records.list('assignments', filters));
});

test('overdue does not fabricate a time for date-only deadlines or include completed work', t => {
  const { records } = setup(t);
  for (const [title, dueDate, dueTime, status] of [['Yesterday', '2026-10-24', null, 'pending'], ['Today date-only', '2026-10-25', null, 'pending'], ['Morning', '2026-10-25', '09:00', 'in_progress'], ['Evening', '2026-10-25', '19:00', 'pending'], ['Done', '2026-10-24', null, 'completed'], ['Unknown', null, null, 'pending']]) records.create('assignments', { title, dueDate, dueTime, status });
  assert.deepEqual(records.list('assignments', { overdue: true }).items.map(a => a.title), ['Yesterday', 'Morning']);
  assert.equal(records.list('assignments', { period: 'today' }).total, 3);
});

test('known deadline precision is not rounded to the next minute', t => {
  const { records } = setup(t, '2026-10-25T12:00:30');
  const item = records.create('assignments', { title: 'Exact deadline', dueDate: '2026-10-25', dueTime: '12:00' });
  assert.equal(item.deadlineState, 'overdue');
  const exact = new RecordsService(records.store, () => DateTime.fromISO('2026-10-25T12:00:00', { zone: 'Europe/Paris' }));
  assert.equal(exact.get('assignments', item.id).deadlineState, 'due_today');
});

test('relative periods roll over years and leap months deterministically', t => {
  const { records } = setup(t, '2027-12-31T23:00:00');
  const item = records.create('exams', { subject: 'January', examDate: '2028-01-01' });
  const result = records.list('exams', { period: 'next_month' });
  assert.equal(result.from, '2028-01-01');
  assert.equal(result.to, '2028-01-31');
  assert.equal(result.items[0].id, item.id);
  const feb = new RecordsService(records.store, () => DateTime.fromISO('2028-01-31', { zone: 'Europe/Paris' })).list('exams', { period: 'next_month' });
  assert.equal(feb.to, '2028-02-29');
});

test('real tool handlers persist data, validate structured output, and confirm deletion in UI only', async t => {
  const { records } = setup(t);
  const tools = new Map();
  registerRecordTools({ registerTool: definition => tools.set(definition.name, definition) }, () => ({ records }), { Unsafe: schema => schema });
  assert.equal(tools.size, 9);
  async function call(name, params, ctx) {
    const tool = tools.get(name);
    const result = await tool.execute('test', params, undefined, undefined, ctx);
    validate(tool.outputSchema, result.structuredContent);
    assert.deepEqual(result.structuredContent, result.details);
    return result.structuredContent;
  }
  const assignment = await call('create_assignment', { title: 'From Pi' });
  assert.equal((await call('list_assignments', {})).items[0].id, assignment.id);
  const edited = await call('update_assignment', { id: assignment.id, version: 1, changes: { course: 'AI' } });
  const complete = await call('complete_assignment', { id: edited.id, version: edited.version });
  const identity = { id: complete.id, version: complete.version };
  await assert.rejects(call('delete_assignment', { ...identity, confirmed: true }), /unknown field/);
  await assert.rejects(call('delete_assignment', identity, { hasUI: false }), /not confirmed/);
  await assert.rejects(call('delete_assignment', identity, { hasUI: true, ui: { confirm: async () => false } }), /not confirmed/);
  assert.equal(records.get('assignments', assignment.id).status, 'completed');
  await call('delete_assignment', identity, { hasUI: true, ui: { confirm: async () => true } });
  const exam = await call('create_exam', { subject: 'From Pi' });
  const updatedExam = await call('update_exam', { id: exam.id, version: 1, changes: { topics: ['Topic'] } });
  assert.equal((await call('list_exams', {})).total, 1);
  await call('delete_exam', { id: exam.id, version: updatedExam.version }, { hasUI: true, ui: { confirm: async () => true } });
  await assert.rejects(call('create_assignment', { title: 'Bad', dueDate: 'Friday' }));
  await assert.rejects(call('update_assignment', { ids: [assignment.id], changes: { status: 'completed' } }));
});
