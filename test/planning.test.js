import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { Store } from '../src/store.js';
import { AcademicService } from '../src/service.js';
import { validate } from '../src/records.js';
import { planningOutput } from '../src/planning-schema.js';
import { normalizePlanningPreferences } from '../src/planning-policy.js';
import { mergeIntervals, subtractIntervals } from '../src/intervals.js';
import { registerPlanningTool } from '../src/planning-tool.js';

const calendar = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.map((event, i) => `BEGIN:VEVENT\r\nUID:class-${i}\r\n${event}\r\nEND:VEVENT`).join('\r\n')}\r\nEND:VCALENDAR`;
const event = (day, start, end) => `DTSTART;TZID=Europe/Paris:${day}T${start}00\r\nDTEND;TZID=Europe/Paris:${day}T${end}00\r\nSUMMARY:Synthetic class`;
function setup(t, { now = '2026-10-21T08:00:00', cached = true, planning = {} } = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  let time = DateTime.fromISO(now, { zone: 'Europe/Paris' }), fetches = 0;
  const service = new AcademicService(store, { calendarUrl: 'https://example.invalid/SECRET', frenchStartDate: '2026-01-01', refreshMinutes: 15,
    planning: { windows: [{ start: '09:00', end: '18:00' }], ...planning } }, async () => { fetches++; throw new Error('offline'); }, () => time);
  if (cached) store.saveSync(calendar(), time.toUTC().toISO());
  return { store, service, records: service.records, fetches: () => fetches, setNow: value => { time = DateTime.fromISO(value, { zone: 'Europe/Paris' }); } };
}
function check(plan) {
  validate(planningOutput, plan);
  assert.equal(plan.summary.plannedMinutes, plan.sessions.reduce((sum, s) => sum + s.minutes, 0));
  assert.equal(plan.summary.targetMinutes, plan.summary.plannedMinutes + plan.summary.unallocatedMinutes);
  for (const session of plan.sessions) {
    const start = Date.parse(session.start), end = Date.parse(session.end);
    assert.ok(end > start);
    assert.equal((end - start) / 60000, session.minutes);
    assert.ok(session.minutes >= plan.policy.minSessionMinutes && session.minutes <= plan.policy.maxSessionMinutes);
    assert.ok(plan.freePeriods.some(p => Date.parse(p.start) <= start && Date.parse(p.end) >= end));
    assert.ok(plan.blockedPeriods.every(p => end <= Date.parse(p.start) || start >= Date.parse(p.end)));
    const task = plan.workload.find(t => t.id === session.taskId);
    if (task.planningCutoff) assert.ok(end <= Date.parse(task.planningCutoff));
  }
  for (let i = 1; i < plan.sessions.length; i++) assert.ok(Date.parse(plan.sessions[i].start) - Date.parse(plan.sessions[i - 1].end) >= plan.policy.breakMinutes * 60000);
  for (const day of plan.days) assert.ok(day.plannedMinutes <= plan.policy.dailyLimitMinutes);
}

test('interval arithmetic merges nested/touching busy periods and subtracts without duplication', () => {
  const busy = [{ start: 2, end: 5 }, { start: 3, end: 4 }, { start: 5, end: 7 }, { start: -2, end: 0 }, { start: 9, end: 9 }];
  assert.deepEqual(mergeIntervals(busy), [{ start: -2, end: 0 }, { start: 2, end: 7 }]);
  assert.deepEqual(subtractIntervals([{ start: 0, end: 10, date: 'day' }], busy), [{ start: 0, end: 2, date: 'day' }, { start: 7, end: 10, date: 'day' }]);
  assert.deepEqual(subtractIntervals([{ start: 0, end: 10 }], [{ start: -1, end: 11 }]), []);
  assert.deepEqual(busy[0], { start: 2, end: 5 }, 'Inputs remain unchanged');
});

test('study preferences validate windows, weekdays and cross-field limits without mutating defaults', () => {
  for (const bad of [null, [], { unknown: true }, { windows: [] }, { weekdays: [] }, { weekdays: [1, 1] }, { weekdays: [8] },
    { windows: [{ start: '20:00', end: '08:00' }] }, { windows: [{ start: '09:00', end: '12:00' }, { start: '11:00', end: '14:00' }] },
    { windows: [{ start: '25:00', end: '26:00' }] }, { minSessionMinutes: 90 }, { breakMinutes: -1 }, { dailyLimitMinutes: 10 }]) assert.throws(() => normalizePlanningPreferences(bad));
  const policy = normalizePlanningPreferences({ windows: [{ start: '13:00', end: '18:00' }, { start: '08:00', end: '12:00' }], weekdays: [5, 1] });
  assert.deepEqual(policy.weekdays, [1, 5]);
  assert.equal(policy.windows[0].start, '08:00');
  policy.windows[0].start = '10:00';
  assert.equal(normalizePlanningPreferences().windows[0].start, '08:00');
  assert.equal(normalizePlanningPreferences({ dailyLimitMinutes: 0 }).dailyLimitMinutes, 0);
});

test('explicit topic recommendations use actual free periods and never create academic records', t => {
  const { service, store, records, fetches } = setup(t);
  const before = store.db.prepare('SELECT total_changes() AS n').get().n;
  const empty = service.suggestStudyPlan({ days: 1 });
  assert.deepEqual(empty.workload, []);
  assert.deepEqual(empty.sessions, []);
  assert.ok(empty.summary.freeMinutes > 0);
  const plan = service.suggestStudyPlan({ days: 1, subject: 'Linear algebra', minutes: 120 });
  check(plan);
  assert.equal(plan.availability, 'calendar_based');
  assert.equal(plan.freePeriods.length, 1);
  assert.equal(plan.summary.freeMinutes, 540);
  assert.equal(plan.summary.plannedMinutes, 120);
  assert.equal(plan.sessions.length, 2);
  assert.equal(plan.workload[0].kind, 'requested');
  assert.equal(plan.workload[0].estimatedMinutes, null);
  assert.equal(plan.workload[0].budgetBasis, 'user_request');
  assert.equal(records.list('assignments').total, 0);
  assert.equal(records.list('exams').total, 0);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before);
  assert.equal(fetches(), 0);
  assert.deepEqual(service.suggestStudyPlan({ days: 1, subject: 'Linear algebra', minutes: 120 }), plan);
});

test('overlapping classes, buffers and preparation-ready exams all block recommendations', t => {
  const { service, store, records } = setup(t);
  store.saveSync(calendar(event('20261021', '0900', '1000'), event('20261021', '0930', '1030'), event('20261021', '1100', '1200')), '2026-10-21T06:00:00Z');
  records.create('exams', { subject: 'Busy exam', examDate: '2026-10-21', startTime: '13:00', durationMinutes: 60, preparationStatus: 'ready' });
  const plan = service.suggestStudyPlan({ days: 1, subject: 'Unrelated study', minutes: 120 });
  check(plan);
  assert.deepEqual(plan.freePeriods.map(p => [p.start.slice(11, 16), p.end.slice(11, 16)]), [['12:15', '12:45'], ['14:15', '18:00']]);
  assert.equal(plan.summary.plannedMinutes, 120);
  assert.equal(plan.workload.length, 1);
});

test('breaks are respected across separate study windows, including short gaps', t => {
  const { service } = setup(t, { planning: { windows: [{ start: '09:00', end: '10:00' }, { start: '10:05', end: '11:05' }] } });
  const plan = service.suggestStudyPlan({ days: 1, subject: 'Test', minutes: 120 });
  check(plan);
  assert.equal(plan.sessions[1].start.slice(11, 16), '10:10');
  assert.equal(plan.summary.plannedMinutes, 115);
  assert.equal(plan.summary.requestedShortfallMinutes, 5);
});

test('allocation splits an effort tail only when both normal blocks actually fit', t => {
  const { service, records } = setup(t);
  records.create('assignments', { title: '61 minute estimate', estimatedMinutes: 61 });
  const plan = service.suggestStudyPlan({ days: 1 });
  check(plan);
  assert.deepEqual(plan.sessions.map(s => s.minutes), [36, 25]);
  assert.equal(plan.summary.unallocatedMinutes, 0);
});

test('workload prioritizes overdue, earliest dated work, priority/progress, then undated work', t => {
  const { service, records } = setup(t);
  for (const input of [
    { title: 'Undated high', priority: 'high' }, { title: 'Later high', dueDate: '2026-10-23', priority: 'high' },
    { title: 'Early low', dueDate: '2026-10-22', priority: 'low' }, { title: 'Same date high', dueDate: '2026-10-22', priority: 'high' },
    { title: 'Overdue', dueDate: '2026-10-20' }, { title: 'Done', status: 'completed' },
  ]) records.create('assignments', { estimatedMinutes: 30, ...input });
  records.create('exams', { subject: 'Ready', examDate: '2026-10-23', startTime: '09:00', durationMinutes: 60, preparationStatus: 'ready' });
  records.create('exams', { subject: 'Past', examDate: '2026-10-19', startTime: '09:00', durationMinutes: 60 });
  const plan = service.suggestStudyPlan({ days: 1 });
  check(plan);
  assert.deepEqual(plan.workload.map(t => t.title), ['Overdue', 'Same date high', 'Early low', 'Later high', 'Undated high']);
  assert.equal(plan.workload[0].cutoffReason, 'overdue_recovery');
  assert.equal(plan.workload[0].planningCutoff, null);
  assert.equal(plan.workload[0].dueDate, '2026-10-20');
});

test('unknown effort and exam revision topics stay factual, with labeled starter budgets', t => {
  const { service, records } = setup(t);
  const assignment = records.create('assignments', { title: 'Unknown effort', course: 'Probability' });
  records.create('exams', { subject: 'Algebra', examDate: '2026-10-23', startTime: '09:00', durationMinutes: 60, topics: ['Matrices'] });
  const plan = service.suggestStudyPlan({ days: 1 });
  check(plan);
  const exam = plan.workload.find(t => t.kind === 'exam');
  assert.deepEqual(exam.topics, ['Matrices']);
  assert.equal(exam.estimatedMinutes, null);
  assert.equal(exam.budgetBasis, 'starter_suggestion');
  assert.equal(records.get('assignments', assignment.id).estimatedMinutes, null);
  const focused = service.suggestStudyPlan({ days: 1, subject: 'Probability', minutes: 100 });
  assert.equal(focused.summary.plannedMinutes, 100);
  assert.equal(focused.workload[0].budgetBasis, 'user_request');
  assert.equal(focused.workload[0].estimatedMinutes, null);
});

test('date-only deadlines have conservative planning cutoffs, not fabricated actual times', t => {
  const { service, records } = setup(t);
  records.create('assignments', { title: 'Today unknown time', dueDate: '2026-10-21', estimatedMinutes: 60 });
  records.create('assignments', { title: 'Tomorrow unknown time', dueDate: '2026-10-22', estimatedMinutes: 60 });
  records.create('assignments', { title: 'Exact cutoff', dueDate: '2026-10-21', dueTime: '09:30', estimatedMinutes: 60 });
  const plan = service.suggestStudyPlan({ days: 2 });
  check(plan);
  const today = plan.workload.find(t => t.title === 'Today unknown time');
  assert.equal(today.dueTime, null);
  assert.equal(today.deadlineAt, null);
  assert.equal(today.allocatedMinutes, 0);
  assert.equal(today.unallocatedReason, 'deadline_time_unknown');
  const tomorrow = plan.workload.find(t => t.title === 'Tomorrow unknown time');
  assert.ok(plan.sessions.filter(s => s.taskId === tomorrow.id).every(s => s.end.slice(0, 10) === '2026-10-21'));
  const exact = plan.workload.find(t => t.title === 'Exact cutoff');
  assert.equal(exact.allocatedMinutes, 30);
  assert.ok(plan.sessions.filter(s => s.taskId === exact.id).every(s => Date.parse(s.end) <= Date.parse(exact.deadlineAt)));
});

test('missing/unreadable caches withhold availability while preserving workload and privacy', t => {
  const { service, store, records, fetches } = setup(t, { cached: false });
  records.create('assignments', { title: 'Still available', estimatedMinutes: 120 });
  for (const malformed of [false, true]) {
    if (malformed) store.saveSync('SECRET https://example.invalid/not-ics', '2026-10-21T06:00:00Z');
    const plan = service.suggestStudyPlan({ days: 1 });
    check(plan);
    assert.equal(plan.availability, 'unavailable');
    assert.deepEqual(plan.freePeriods, []);
    assert.deepEqual(plan.sessions, []);
    assert.equal(plan.workload[0].title, 'Still available');
    assert.equal(plan.workload[0].unallocatedReason, 'calendar_unavailable');
    assert.ok(!JSON.stringify(plan).includes('SECRET'));
  }
  assert.equal(fetches(), 0);
});

test('stale and failed-refresh offline caches yield explicit provisional recommendations', t => {
  const { service, store } = setup(t);
  store.saveSync(calendar(), '2026-10-18T06:00:00Z');
  store.failSync('2026-10-21T06:00:00Z', 'Calendar refresh failed. Last successful cache retained.');
  const plan = service.suggestStudyPlan({ days: 1, subject: 'Study' });
  check(plan);
  assert.equal(plan.availability, 'provisional');
  assert.ok(plan.warnings.some(w => w.code === 'calendar_stale'));
  assert.ok(plan.warnings.some(w => w.code === 'calendar_refresh_failed'));
  assert.ok(plan.sessions.every(s => s.tentative));
});

test('incomplete exams exclude possible intervals without fabricating times or durations', t => {
  const { service, records } = setup(t);
  records.create('exams', { subject: 'No finish', examDate: '2026-10-21', startTime: '14:00' });
  records.create('exams', { subject: 'Undated' });
  const plan = service.suggestStudyPlan({ days: 3, subject: 'Other' });
  check(plan);
  assert.equal(plan.availability, 'provisional');
  assert.ok(plan.freePeriods.every(p => p.date === '2026-10-21' && p.end.slice(11, 16) === '13:45'));
  assert.ok(plan.warnings.some(w => w.code === 'exam_date_unknown'));
  const stored = records.list('exams', { query: 'No finish' }).items[0];
  assert.equal(stored.durationMinutes, null);
  assert.ok(plan.excludedDates.length);
});

test('unknown exam starts use known duration bounds including midnight spillover and buffers', t => {
  const { service, records } = setup(t, { planning: { windows: [{ start: '00:00', end: '04:00' }] } });
  records.create('exams', { subject: 'No start', examDate: '2026-10-21', durationMinutes: 60 });
  const plan = service.suggestStudyPlan({ date: '2026-10-22', days: 1, subject: 'Study' });
  check(plan);
  assert.equal(plan.freePeriods[0].start.slice(11, 16), '01:15');
  assert.equal(records.list('exams').items[0].startTime, null);
});

test('past unknown finishes are warnings, not invented ongoing exam intervals', t => {
  const { service, records } = setup(t);
  records.create('exams', { subject: 'Past date; finish not recorded', examDate: '2026-10-19', startTime: '09:00' });
  const plan = service.suggestStudyPlan({ days: 1, subject: 'Study' });
  check(plan);
  assert.equal(plan.availability, 'provisional');
  assert.ok(plan.warnings.some(w => w.code === 'past_exam_finish_unknown'));
  assert.ok(plan.freePeriods.length);
});

test('no free time, zero daily budget, small blocks and unknown subjects are reported honestly', t => {
  const { service, store, records } = setup(t);
  records.create('assignments', { title: 'Tiny task', estimatedMinutes: 10 });
  let plan = service.suggestStudyPlan({ days: 1 });
  assert.equal(plan.workload[0].unallocatedReason, 'below_minimum_block');
  plan = service.suggestStudyPlan({ days: 1, subject: 'Other', preferences: { dailyLimitMinutes: 0 } });
  assert.equal(plan.summary.plannedMinutes, 0);
  assert.ok(plan.summary.freeMinutes > 0);
  store.saveSync(calendar('DTSTART;VALUE=DATE:20261021\r\nDTEND;VALUE=DATE:20261022\r\nSUMMARY:All day'), '2026-10-21T06:00:00Z');
  plan = service.suggestStudyPlan({ days: 1 });
  check(plan);
  assert.equal(plan.summary.freeMinutes, 0);
  assert.equal(plan.summary.plannedMinutes, 0);
  const noWork = service.suggestStudyPlan({ days: 1, subject: 'Explicit topic' });
  assert.equal(noWork.workload[0].kind, 'requested');
});

test('point events conservatively exclude their day; recurrence cancellations and French overrides are honored', t => {
  const { service, store, setNow } = setup(t);
  store.saveSync(calendar('DTSTART;TZID=Europe/Paris:20261021T120000\r\nSUMMARY:No known duration'), '2026-10-21T06:00:00Z');
  assert.equal(service.suggestStudyPlan({ days: 1 }).summary.freeMinutes, 0);
  store.saveSync(calendar('DTSTART;TZID=Europe/Paris:20261020T090000\r\nDTEND;TZID=Europe/Paris:20261020T110000\r\nRRULE:FREQ=DAILY;COUNT=2\r\nEXDATE;TZID=Europe/Paris:20261021T090000'), '2026-10-21T06:00:00Z');
  assert.equal(service.suggestStudyPlan({ days: 1 }).summary.freeMinutes, 540);
  setNow('2026-10-20T08:00:00');
  store.saveSync(calendar(), '2026-10-20T06:00:00Z');
  const request = { days: 1, preferences: { windows: [{ start: '14:00', end: '17:00' }] } };
  assert.equal(service.suggestStudyPlan(request).summary.freeMinutes, 0);
  const lesson = service.schedule('2026-10-20', 'day').events[0];
  service.overrideOccurrence({ uid: lesson.uid, recurrenceId: lesson.recurrenceId, cancelled: true, confirmed: true });
  assert.equal(service.suggestStudyPlan(request).summary.freeMinutes, 180);
});

test('overnight events, previous-day buffers and exact end boundaries are respected', t => {
  const { service, store } = setup(t, { now: '2026-10-21T00:00:00', planning: { windows: [{ start: '00:00', end: '04:00' }] } });
  store.saveSync(calendar('DTSTART;TZID=Europe/Paris:20261020T230000\r\nDTEND;TZID=Europe/Paris:20261021T010000', 'DTSTART;TZID=Europe/Paris:20261020T233000\r\nDTEND;TZID=Europe/Paris:20261020T235500'), '2026-10-20T22:00:00Z');
  const plan = service.suggestStudyPlan({ days: 1, subject: 'Study' });
  check(plan);
  assert.equal(plan.freePeriods[0].start.slice(11, 16), '01:15');
});

test('Paris DST days have real 23/25-hour free periods and ambiguous windows are skipped', t => {
  const { service, setNow, store } = setup(t, { planning: { windows: [{ start: '00:00', end: '24:00' }], eventBufferMinutes: 0 } });
  for (const [date, expected] of [['2026-03-29', 1380], ['2026-10-25', 1500]]) {
    setNow(`${date}T00:00:00`);
    store.saveSync(calendar(), service.now().toUTC().toISO());
    const plan = service.suggestStudyPlan({ days: 1, subject: 'Study' });
    check(plan);
    assert.equal(plan.summary.freeMinutes, expected);
    const skipped = service.suggestStudyPlan({ days: 1, preferences: { windows: [{ start: '02:30', end: '04:00' }] } });
    assert.equal(skipped.summary.freeMinutes, 0);
    assert.ok(skipped.warnings.some(w => w.code === 'study_window_dst'));
  }
});

test('current time is rounded forward, relative dates use Paris, and study weekdays stay local', t => {
  const { service, store } = setup(t, { now: '2026-10-20T22:30:30Z', planning: { windows: [{ start: '00:00', end: '04:00' }], weekdays: [3] } });
  store.saveSync(calendar(), '2026-10-20T22:00:00Z');
  const plan = service.suggestStudyPlan({ days: 2, subject: 'Study' });
  check(plan);
  assert.equal(plan.range.from.slice(0, 10), '2026-10-21');
  assert.equal(plan.sessions[0].start.slice(11, 16), '00:31');
  assert.ok(plan.freePeriods.every(p => p.date === '2026-10-21'));
});

test('planner validates request bounds, preserves stored settings, and captures one clock/snapshot', t => {
  const { service, store } = setup(t);
  for (const input of [null, [], { date: 'tomorrow' }, { date: '2026-02-30' }, { date: '2026-10-20' }, { date: '2027-10-22' }, { days: 15 }, { days: 0 }, { minutes: 3 }, { subject: ' ' }, { confirmed: true }, { preferences: { cloud: true } }]) assert.throws(() => service.suggestStudyPlan(input));
  const before = structuredClone(service.planningPolicy);
  service.suggestStudyPlan({ preferences: { dailyLimitMinutes: 60 } });
  assert.deepEqual(service.planningPolicy, before);
  let calls = 0;
  service.now = () => { calls++; return DateTime.fromISO('2026-10-21T08:00:00', { zone: 'Europe/Paris' }); };
  const changes = store.db.prepare('SELECT total_changes() AS n').get().n;
  service.suggestStudyPlan({ days: 1 });
  assert.equal(calls, 1);
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2);
});

test('buffers include next-day commitments just outside the requested range', t => {
  const { service, store, records } = setup(t, { planning: { windows: [{ start: '23:00', end: '24:00' }] } });
  store.saveSync(calendar(event('20261022', '0010', '0100')), '2026-10-21T06:00:00Z');
  let plan = service.suggestStudyPlan({ days: 1, subject: 'Study' });
  check(plan);
  assert.equal(plan.freePeriods[0].end.slice(11, 16), '23:55');
  records.create('exams', { subject: 'Next-day time unknown', examDate: '2026-10-22' });
  plan = service.suggestStudyPlan({ days: 1, subject: 'Study' });
  check(plan);
  assert.equal(plan.freePeriods[0].end.slice(11, 16), '23:45');
});

test('seeded mixed workloads preserve all allocation invariants over several days', t => {
  const { service, store, records } = setup(t, { planning: { windows: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }], dailyLimitMinutes: 120 } });
  let seed = 17;
  const random = n => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
  const hhmm = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}${String(minutes % 60).padStart(2, '0')}`;
  const events = [];
  for (let i = 0; i < 12; i++) {
    const start = 9 * 60 + random(420);
    events.push(event(`202610${21 + i % 3}`, hhmm(start), hhmm(start + 30 + random(61))));
  }
  store.saveSync(calendar(...events), '2026-10-21T06:00:00Z');
  for (let i = 0; i < 40; i++) records.create('assignments', { title: `Task ${i}`, dueDate: i % 4 ? `2026-10-${22 + i % 3}` : null, estimatedMinutes: 10 + random(171), priority: ['low', 'normal', 'high'][i % 3] });
  const before = store.db.prepare('SELECT total_changes() AS n').get().n;
  const plan = service.suggestStudyPlan({ days: 3 });
  check(plan);
  assert.equal(plan.workload.length, 40);
  assert.ok(plan.sessions.length > 0);
  const commitments = service.scheduleBetween(DateTime.fromISO(plan.range.from), DateTime.fromISO(plan.range.to)).events;
  for (const session of plan.sessions) for (const commitment of commitments) {
    assert.ok(Date.parse(session.end) <= Date.parse(commitment.start) - 15 * 60000 || Date.parse(session.start) >= Date.parse(commitment.end) + 15 * 60000);
  }
  assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, before);
});

test('planner tool returns real structured output and does not accept write/confirmation flags', async t => {
  const { service, records } = setup(t);
  let tool;
  registerPlanningTool({ registerTool: value => { tool = value; } }, () => service, { Unsafe: schema => schema });
  assert.equal(tool.name, 'suggest_study_plan');
  assert.equal(tool.annotations.readOnlyHint, true);
  const result = await tool.execute('test', { days: 1, subject: 'Study', minutes: 120 });
  check(result.structuredContent);
  assert.deepEqual(result.structuredContent, result.details);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  await assert.rejects(tool.execute('test', { overwrite: true }));
  for (let i = 0; i < 205; i++) records.create('assignments', { title: `Stored ${i}` });
  const large = await tool.execute('large', { days: 1 });
  assert.equal(large.structuredContent.workload.length, 205, 'Planner never silently applies the CRUD list limit');
  assert.ok(JSON.parse(large.content[0].text).note.includes('shortened'));
  check(large.structuredContent);
});
