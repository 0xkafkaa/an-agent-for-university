import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { AcademicService } from '../src/service.js';
import { overviewOutput } from '../src/overview.js';
import { registerOverviewTool } from '../src/overview-tool.js';
import { RecordsService, validate } from '../src/records.js';

function setup(t, initial = '2026-10-20T10:00:00') {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let now = DateTime.fromISO(initial, { zone: 'Europe/Paris' });
  let fetches = 0;
  const service = new AcademicService(store, { frenchStartDate: '2026-01-01', refreshMinutes: 15, calendarUrl: 'https://example.invalid/SECRET' }, async () => { fetches++; throw new Error('offline'); }, () => now);
  return { store, service, records: service.records, setNow: value => { now = DateTime.fromISO(value, { zone: 'Europe/Paris' }); }, fetches: () => fetches };
}
const calendar = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.map((event, i) => `BEGIN:VEVENT\r\nUID:class-${i}\r\n${event}\r\nEND:VEVENT`).join('\r\n')}\r\nEND:VCALENDAR`;
const event = (day, start, end, title = 'Probability') => `DTSTART;TZID=Europe/Paris:${day}T${start}00\r\nDTEND;TZID=Europe/Paris:${day}T${end}00\r\nSUMMARY:${title}\r\nLOCATION:Lab`;
const titles = rows => rows.map(row => row.title ?? row.subject);

test('empty academic data produces a useful local dashboard without fetching or fabricated records', t => {
  const { service, fetches } = setup(t, '2026-10-21T10:00:00');
  const result = service.overview();
  validate(overviewOutput, result);
  assert.equal(result.today.date, '2026-10-21');
  assert.equal(result.week.events.length, 2, 'Only the explicitly configured French lessons are present');
  assert.deepEqual(result.today.events, []);
  assert.deepEqual(result.today.assignments, []);
  assert.deepEqual(result.upcoming.exams, []);
  assert.equal(result.calendar.hasCache, false);
  assert.equal(result.calendar.queryError, null);
  assert.equal(fetches(), 0);
  for (const values of Object.values(result.needsAttention)) assert.deepEqual(values, []);
  for (const args of [null, [], { date: '2026-10-21' }, { confirmed: true }]) assert.throws(() => service.overview(args));
});

test('attention windows are inclusive of today and exclusive of the final Paris day boundary', t => {
  const { service, records } = setup(t, '2026-10-25T12:00:00');
  for (const [title, dueDate, dueTime, status] of [
    ['Earlier', '2026-10-19', null, 'pending'], ['Morning', '2026-10-25', '09:00', 'in_progress'],
    ['Date only', '2026-10-25', null, 'pending'], ['Last included', '2026-10-31', '23:59', 'pending'],
    ['Beyond deadline window', '2026-11-01', null, 'pending'], ['Completed', '2026-10-25', null, 'completed'], ['Undated', null, null, 'pending'],
  ]) records.create('assignments', { title, dueDate, dueTime, status });
  for (const [subject, examDate, preparationStatus] of [
    ['Prep needed', '2026-11-07', 'in_progress'], ['Beyond prep window', '2026-11-08', 'not_started'],
    ['Ready', '2026-10-26', 'ready'], ['Last upcoming', '2026-11-23', 'ready'], ['Beyond exam window', '2026-11-24', 'not_started'], ['Undated exam', null, 'not_started'],
  ]) records.create('exams', { subject, examDate, preparationStatus });
  const result = service.overview();
  validate(overviewOutput, result);
  assert.deepEqual(titles(result.needsAttention.overdueAssignments), ['Earlier', 'Morning']);
  assert.deepEqual(titles(result.needsAttention.approachingAssignments), ['Date only', 'Last included']);
  assert.deepEqual(titles(result.needsAttention.examsNeedingPreparation), ['Prep needed']);
  assert.deepEqual(titles(result.needsAttention.undatedAssignments), ['Undated']);
  assert.deepEqual(titles(result.needsAttention.undatedExams), ['Undated exam']);
  assert.ok(titles(result.upcoming.exams).includes('Last upcoming'));
  assert.ok(!titles(result.upcoming.exams).includes('Beyond exam window'));
  assert.equal(result.week.from.slice(0, 10), '2026-10-19');
  assert.equal(result.week.to.slice(0, 10), '2026-10-26');
  assert.equal(result.week.assignments.length, 4, 'Completed work remains visible in the weekly timetable');
  assert.equal(result.week.pendingAssignments.length, 3);
});

test('Paris date boundaries are independent of the machine/UTC date', t => {
  const { service, records } = setup(t, '2026-10-24T22:30:00Z');
  records.create('assignments', { title: 'Yesterday in Paris', dueDate: '2026-10-24' });
  records.create('exams', { subject: 'Today in Paris', examDate: '2026-10-25' });
  const result = service.overview();
  assert.equal(result.today.date, '2026-10-25');
  assert.equal(result.today.exams[0].daysUntil, 0);
  assert.deepEqual(titles(result.needsAttention.overdueAssignments), ['Yesterday in Paris']);
});

test('exam countdowns use calendar days through both DST transitions and year rollover', t => {
  const { service, records, setNow } = setup(t);
  for (const [now, examDate] of [['2026-03-28T23:30:00', '2026-03-29'], ['2026-10-24T23:30:00', '2026-10-25'], ['2026-12-31T23:30:00', '2027-01-01']]) {
    setNow(now);
    const row = records.create('exams', { subject: examDate, examDate, startTime: '09:00' });
    const exam = service.overview().upcoming.exams.find(e => e.id === row.id);
    assert.equal(exam.daysUntil, 1);
    assert.equal(exam.endsAt, null);
  }
});

test('exam timing distinguishes unknown, ongoing, finished and passed dates without inventing ends', t => {
  const { service, records } = setup(t, '2026-03-29T04:00:00');
  for (const input of [
    { subject: 'Ongoing across DST', examDate: '2026-03-29', startTime: '01:30', durationMinutes: 120 },
    { subject: 'Finished', examDate: '2026-03-29', startTime: '00:00', durationMinutes: 30 },
    { subject: 'No duration', examDate: '2026-03-29', startTime: '01:00' },
    { subject: 'No start', examDate: '2026-03-29', durationMinutes: 90 },
    { subject: 'Yesterday', examDate: '2026-03-28' }, { subject: 'Undated' },
  ]) records.create('exams', input);
  const result = service.overview();
  const today = Object.fromEntries(result.today.exams.map(e => [e.subject, e]));
  assert.equal(today['Ongoing across DST'].timingStatus, 'in_progress');
  assert.equal(today['Ongoing across DST'].endsAt, '2026-03-29T04:30:00.000+02:00');
  assert.equal(today.Finished.timingStatus, 'finished');
  assert.equal(today['No duration'].timingStatus, 'started_end_unknown');
  assert.equal(today['No duration'].endsAt, null);
  assert.equal(today['No start'].startsAt, null);
  assert.equal(today['No start'].endsAt, null);
  assert.equal(today['No start'].timingStatus, 'time_unknown_today');
  assert.ok(!titles(result.upcoming.exams).includes('Finished'));
  assert.deepEqual(titles(result.needsAttention.examsNeedingPreparation), ['No start']);
  assert.equal(result.needsAttention.examsWithIncompleteTiming.length, 2);
  const yesterday = result.week.exams.find(e => e.subject === 'Yesterday');
  assert.equal(yesterday.timingStatus, 'date_passed');
  assert.equal(yesterday.startsAt, null);
  assert.equal(result.needsAttention.undatedExams[0].daysUntil, null);
  validate(overviewOutput, result);
});

test('conflicts combine university, French and known exam intervals, including the next week', t => {
  const { service, store, records, setNow } = setup(t);
  store.saveSync(calendar(event('20261020', '1500', '1700'), event('20261026', '0900', '1100', 'Next Monday class')), '2026-10-20T08:00:00Z');
  records.create('exams', { subject: 'Known exam', examDate: '2026-10-20', startTime: '15:30', durationMinutes: 60, preparationStatus: 'ready' });
  records.create('exams', { subject: 'Unknown duration', examDate: '2026-10-20', startTime: '16:00' });
  records.create('exams', { subject: 'Unknown time', examDate: '2026-10-20', durationMinutes: 60 });
  records.create('exams', { subject: 'Next Monday exam', examDate: '2026-10-26', startTime: '10:00', durationMinutes: 60 });
  const result = service.overview();
  assert.equal(result.today.events.length, 2);
  assert.equal(result.today.conflicts.length, 3);
  assert.equal(result.week.conflicts.length, 3);
  assert.equal(result.needsAttention.conflicts.length, 4, 'Rolling attention window crosses the Monday week boundary');
  assert.ok(result.needsAttention.conflicts.some(c => c.events.some(e => e.title === 'Next Monday exam')));
  assert.ok(result.today.conflicts.every(c => c.events.every(e => !e.title.startsWith('Unknown'))));
  assert.equal(result.needsAttention.examsWithIncompleteTiming.length, 2);
  setNow('2026-10-20T16:40:00');
  const later = service.overview();
  assert.equal(later.today.conflicts.length, 3, 'Today still shows historical conflicts');
  assert.equal(later.needsAttention.conflicts.length, 1, 'Ended overlaps are not actionable just because one event continues');
  validate(overviewOutput, later);
});

test('touching exam/class boundaries are not conflicts and undated exams do not block intervals', t => {
  const { service, store, records } = setup(t);
  store.saveSync(calendar(event('20261020', '1200', '1400')), '2026-10-20T08:00:00Z');
  records.create('exams', { subject: 'Touching', examDate: '2026-10-20', startTime: '11:00', durationMinutes: 60 });
  records.create('exams', { subject: 'Unknown' });
  assert.deepEqual(service.overview().today.conflicts, []);
});

test('overnight classes and exams remain visible across midnight and Monday boundaries', t => {
  const { service, store, records } = setup(t, '2026-10-26T00:30:00');
  store.saveSync(calendar('DTSTART;TZID=Europe/Paris:20261025T230000\r\nDTEND;TZID=Europe/Paris:20261026T010000\r\nSUMMARY:Overnight class'), '2026-10-25T20:00:00Z');
  records.create('exams', { subject: 'Overnight exam', examDate: '2026-10-25', startTime: '23:30', durationMinutes: 120 });
  const result = service.overview();
  assert.equal(result.today.events.length, 1);
  assert.equal(result.today.exams.length, 1);
  assert.equal(result.week.exams.length, 1);
  assert.equal(result.upcoming.exams[0].timingStatus, 'in_progress');
  assert.equal(result.upcoming.exams[0].daysUntil, -1);
  assert.equal(result.needsAttention.conflicts.length, 1);
});

test('all-day exclusive ends and zero-duration points use the existing calendar semantics', t => {
  const { service, store } = setup(t, '2026-10-21T10:00:00');
  store.saveSync(calendar('DTSTART;VALUE=DATE:20261020\r\nDTEND;VALUE=DATE:20261021\r\nSUMMARY:Yesterday all-day', 'DTSTART;TZID=Europe/Paris:20261021T100000\r\nSUMMARY:Point event'), '2026-10-20T08:00:00Z');
  const result = service.overview();
  assert.deepEqual(titles(result.today.events), ['Point event']);
  assert.deepEqual(result.today.conflicts, []);
});

test('calendar cache errors never hide assignments/exams or leak raw URLs', t => {
  const { service, store, records, fetches } = setup(t);
  records.create('assignments', { title: 'Keep available', dueDate: '2026-10-20' });
  records.create('exams', { subject: 'Keep exam available', examDate: '2026-10-20' });
  store.saveSync('https://example.invalid/SECRET is not ICS', '2026-10-19T10:00:00Z');
  store.failSync('2026-10-20T09:00:00Z', 'Calendar refresh failed. Last successful cache retained.');
  const result = service.overview();
  assert.equal(result.today.assignments.length, 1);
  assert.equal(result.today.exams.length, 1);
  assert.ok(result.calendar.queryError);
  assert.equal(result.calendar.hasCache, true);
  assert.equal(result.calendar.lastSyncedAt, '2026-10-19T10:00:00Z');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(fetches(), 0);
});

test('overview is read-only, freezes the clock and does not drop records at list pagination limits', t => {
  const { service, store, records } = setup(t);
  for (let i = 0; i < 205; i++) records.create('assignments', { title: `Undated ${i}` });
  const changes = () => store.db.prepare('SELECT total_changes() AS count').get().count;
  const before = changes();
  const result = service.overview();
  assert.equal(result.needsAttention.undatedAssignments.length, 205);
  assert.equal(changes(), before);
  assert.deepEqual(service.overview(), result);
  let clockCalls = 0;
  service.now = () => { clockCalls++; return DateTime.fromISO('2026-10-20T23:59:59', { zone: 'Europe/Paris' }); };
  service.overview();
  assert.equal(clockCalls, 1);
  assert.equal(changes(), before);
});

test('SQLite snapshot stays consistent while another UI/Pi connection writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'academic-snapshot-'));
  let reader, writer;
  try {
    const path = join(dir, 'data.sqlite');
    reader = new Store(path);
    writer = new Store(path);
    reader.saveSync('old snapshot', '2026-10-20T08:00:00Z');
    reader.readSnapshot(() => {
      assert.equal(reader.source().ics, 'old snapshot');
      new RecordsService(writer).create('assignments', { title: 'Concurrent update' });
      writer.saveSync('new snapshot', '2026-10-20T09:00:00Z');
      assert.equal(reader.source().ics, 'old snapshot');
      assert.equal(reader.listRecords('assignments').length, 0);
    });
    assert.equal(reader.source().ics, 'new snapshot');
    assert.equal(reader.listRecords('assignments').length, 1);
  } finally { reader?.close(); writer?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('snapshot transactions close on unexpected errors', t => {
  const { service, store } = setup(t);
  const original = store.listRecords;
  store.listRecords = () => { throw new Error('Synthetic DB read failure'); };
  assert.throws(() => service.overview(), /Synthetic/);
  store.listRecords = original;
  assert.doesNotThrow(() => service.overview());
});

test('overview tool returns validated structured results and rejects invented arguments', async t => {
  const { service, records } = setup(t);
  const tools = new Map();
  registerOverviewTool({ registerTool: tool => tools.set(tool.name, tool) }, () => service, { Unsafe: schema => schema });
  const tool = tools.get('get_academic_overview');
  assert.equal(tool.annotations.readOnlyHint, true);
  const result = await tool.execute('test', {});
  validate(tool.outputSchema, result.structuredContent);
  assert.deepEqual(result.structuredContent, result.details);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  await assert.rejects(tool.execute('test', { date: 'tomorrow' }));
  for (let i = 0; i < 205; i++) records.create('assignments', { title: `${String(i).padStart(3, '0')} ${'x'.repeat(290)}` });
  const large = await tool.execute('large', {});
  const modelText = JSON.parse(large.content[0].text);
  assert.equal(large.structuredContent.needsAttention.undatedAssignments.length, 205);
  assert.equal(modelText.counts.undatedAssignments, 205);
  assert.ok(modelText.note.includes('too large'));
  validate(tool.outputSchema, large.structuredContent);
});
