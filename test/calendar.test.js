import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DateTime } from 'luxon';
import { expandCalendar, dateRange, frenchCalendars, findConflicts, ZONE } from '../src/calendar.js';
import { Store } from '../src/store.js';
import { AcademicService } from '../src/service.js';

const calendar = (...events) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${events.map(e => `BEGIN:VEVENT\r\n${e}\r\nEND:VEVENT`).join('\r\n')}\r\nEND:VCALENDAR\r\n`;
const event = (extra = '') => `UID:course-1\r\nDTSTART;TZID=Europe/Paris:20261020T150000\r\nDTEND;TZID=Europe/Paris:20261020T170000\r\nSUMMARY:Probability\r\nLOCATION:Room 1\r\n${extra}`;
function expand(ics, date = '2026-10-20', view = 'week') {
  const { from, to } = dateRange(date, view);
  return expandCalendar(ics, 'university', from, to);
}
const config = { calendarUrl: 'https://example.invalid/SECRET', refreshMinutes: 15, frenchStartDate: '2026-10-19' };
const now = () => DateTime.fromISO('2026-10-20T10:00:00', { zone: ZONE });
function setup(t, fetcher = async () => new Response(calendar(event()))) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  return { store, service: new AcademicService(store, config, fetcher, now) };
}

test('fields, unfolded text, UTC and Paris times', () => {
  const [e] = expand(calendar(event('DESCRIPTION:First line\r\n second line')));
  assert.equal(e.title, 'Probability');
  assert.equal(e.location, 'Room 1');
  assert.equal(e.description, 'First linesecond line');
  assert.equal(e.start, '2026-10-20T15:00:00.000+02:00');
  const utc = expand(calendar('UID:utc\r\nDTSTART:20261020T070000Z\r\nDTEND:20261020T080000Z'));
  assert.equal(utc[0].start, '2026-10-20T09:00:00.000+02:00');
});

test('French recurrences retain wall time across both DST transitions', () => {
  const [{ ics }] = frenchCalendars('2026-01-01');
  for (const [day, offset] of [['2026-03-24', '+01:00'], ['2026-03-31', '+02:00'], ['2026-10-20', '+02:00'], ['2026-10-27', '+01:00']]) {
    const [e] = expand(ics, day, 'day');
    assert.ok(e.start.endsWith(`14:30:00.000${offset}`));
    assert.ok(e.end.endsWith(`16:30:00.000${offset}`));
  }
});

test('Paris days spanning DST have 23 and 25 hours; weeks start Monday', () => {
  for (const [date, hours] of [['2026-03-29', 23], ['2026-10-25', 25]]) {
    const { from, to } = dateRange(date, 'day');
    assert.equal(to.diff(from, 'hours').hours, hours);
  }
  assert.equal(dateRange('2026-10-25').from.toISODate(), '2026-10-19');
  assert.throws(() => dateRange('2026-02-30'));
  assert.throws(() => dateRange('2026-10-20', 'month'));
});

test('RRULE COUNT, EXDATE, RDATE and deduplication', () => {
  const text = calendar(event('RRULE:FREQ=DAILY;COUNT=3\r\nEXDATE;TZID=Europe/Paris:20261021T150000\r\nRDATE;TZID=Europe/Paris:20261023T150000'), event('RRULE:FREQ=DAILY;COUNT=3\r\nEXDATE;TZID=Europe/Paris:20261021T150000\r\nRDATE;TZID=Europe/Paris:20261023T150000'));
  assert.deepEqual(expand(text).map(e => e.start.slice(0, 10)), ['2026-10-20', '2026-10-22', '2026-10-23']);
});

test('modified exceptions can move into another query week; cancellations need no DTSTART', () => {
  const text = calendar(event('RRULE:FREQ=WEEKLY;COUNT=3'),
    'UID:course-1\r\nRECURRENCE-ID;TZID=Europe/Paris:20261027T150000\r\nDTSTART;TZID=Europe/Paris:20261103T100000\r\nDTEND;TZID=Europe/Paris:20261103T120000\r\nSUMMARY:Moved class',
    'UID:course-1\r\nRECURRENCE-ID;TZID=Europe/Paris:20261103T150000\r\nSTATUS:CANCELLED');
  assert.equal(expand(text, '2026-10-27').length, 0);
  const moved = expand(text, '2026-11-03');
  assert.equal(moved.length, 1);
  assert.equal(moved[0].title, 'Moved class');
  assert.equal(moved[0].recurrenceId, '2026-10-27T14:00:00.000Z');
});

test('sequence resolves duplicates and cancelled series disappear', () => {
  const text = calendar(event('SEQUENCE:1'), event('SEQUENCE:2\r\nSTATUS:CANCELLED'));
  assert.equal(expand(text).length, 0);
});

test('all-day exclusive end, floating events and overnight events', () => {
  const allDay = calendar('UID:day\r\nDTSTART;VALUE=DATE:20261020\r\nDTEND;VALUE=DATE:20261022');
  assert.equal(expand(allDay, '2026-10-21', 'day')[0].allDay, true);
  assert.equal(expand(allDay, '2026-10-22', 'day').length, 0);
  const overnight = calendar('UID:night\r\nDTSTART:20261019T230000\r\nDTEND:20261020T010000');
  assert.equal(expand(overnight, '2026-10-20', 'day').length, 1);
});

test('conflicts retain both events, touching boundaries are not conflicts', t => {
  const { store, service } = setup(t);
  store.saveSync(calendar(event()), now().toISO());
  const result = service.schedule('2026-10-20', 'day');
  assert.equal(result.events.length, 2);
  assert.equal(result.conflicts.length, 1);
  assert.equal(findConflicts([{ id: 'a', start: '2026-10-20T10:00Z', end: '2026-10-20T11:00Z' }, { id: 'b', start: '2026-10-20T11:00Z', end: '2026-10-20T12:00Z' }]).length, 0);
});

test('repeated sync is idempotent; changed and deleted events replace the snapshot', async t => {
  let text = calendar(event());
  const { service } = setup(t, async () => new Response(text));
  assert.equal((await service.sync()).ok, true);
  await service.sync();
  assert.equal(service.schedule('2026-10-20', 'day').events.length, 2);
  text = calendar(event().replace('Probability', 'Changed subject'));
  await service.sync();
  assert.ok(service.schedule('2026-10-20', 'day').events.some(e => e.title === 'Changed subject'));
  text = calendar();
  await service.sync();
  assert.equal(service.schedule('2026-10-20', 'day').events.length, 1);
});

test('offline, HTTP and malformed refresh failures preserve last success and never disclose URL', async t => {
  let mode = 0;
  const { service, store } = setup(t, async () => {
    if (mode === 1) throw new Error(config.calendarUrl);
    if (mode === 2) return new Response('error', { status: 503 });
    return new Response(mode === 3 ? 'not ICS' : calendar(event()));
  });
  await service.sync();
  const before = store.source();
  for (mode = 1; mode <= 3; mode++) {
    const result = await service.sync();
    assert.equal(result.ok, false);
    assert.equal(store.source().ics, before.ics);
    assert.equal(result.lastSyncedAt, before.last_synced_at);
    assert.ok(!JSON.stringify(result).includes('SECRET'));
  }
});

test('unsupported RANGE and unknown timezone preserve cache', async t => {
  let text = calendar(event());
  const { service, store } = setup(t, async () => new Response(text));
  await service.sync();
  const before = store.source().ics;
  text = calendar(event('RECURRENCE-ID;RANGE=THISANDFUTURE;TZID=Europe/Paris:20261020T150000'));
  assert.equal((await service.sync()).ok, false);
  text = calendar(event().replaceAll('Europe/Paris', 'Unknown/Zone'));
  assert.equal((await service.sync()).ok, false);
  assert.equal(store.source().ics, before);
});

test('concurrent refresh calls share one fetch', async t => {
  let count = 0;
  const { service } = setup(t, async () => { count++; await new Promise(r => setTimeout(r, 10)); return new Response(calendar()); });
  await Promise.all([service.sync(), service.sync(), service.sync()]);
  assert.equal(count, 1);
});

test('French overrides require confirmation, are local-only, and support moved/cancelled instances', t => {
  const { service } = setup(t);
  const e = service.schedule('2026-10-20', 'day').events[0];
  assert.throws(() => service.overrideOccurrence({ ...e, cancelled: true }));
  assert.throws(() => service.overrideOccurrence({ ...e, uid: 'university', cancelled: true, confirmed: true }));
  service.overrideOccurrence({ ...e, start: '2026-11-03T18:00:00+01:00', end: '2026-11-03T20:00:00+01:00', cancelled: false, confirmed: true });
  assert.equal(service.schedule('2026-10-20', 'day').events.length, 0);
  assert.equal(service.schedule('2026-11-03', 'day').events.length, 2);
  service.overrideOccurrence({ ...e, cancelled: true, confirmed: true });
  assert.equal(service.schedule('2026-11-03', 'day').events.length, 1);
  assert.equal(service.schedule('2026-10-27', 'day').events.length, 1);
});

test('startup and periodic refresh run without a model and stop cleanly', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let count = 0;
  const { service } = setup(t, async () => { count++; return new Response(calendar()); });
  service.startRefresh();
  await service.pendingSync;
  assert.equal(count, 1);
  t.mock.timers.tick(15 * 60000);
  await service.pendingSync;
  assert.equal(count, 2);
  await service.stop();
  t.mock.timers.tick(15 * 60000);
  assert.equal(count, 2);
});

test('cancelled series suppresses exceptions and single-event exception replaces original', () => {
  const moved = 'UID:course-1\r\nRECURRENCE-ID;TZID=Europe/Paris:20261020T150000\r\nDTSTART;TZID=Europe/Paris:20261020T180000\r\nDTEND;TZID=Europe/Paris:20261020T190000';
  assert.equal(expand(calendar(event('STATUS:CANCELLED'), moved)).length, 0);
  const replaced = expand(calendar(event(), moved));
  assert.equal(replaced.length, 1);
  assert.ok(replaced[0].start.includes('T18:00'));
});

test('database cache and overrides survive reopen; seeding does not duplicate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'academic-'));
  const path = join(dir, 'academic.sqlite');
  let store;
  try {
    store = new Store(path);
    let service = new AcademicService(store, config, fetch, now);
    store.saveSync(calendar(event()), now().toISO());
    const lesson = service.schedule('2026-10-20', 'day').events.find(e => e.source === 'local');
    service.overrideOccurrence({ ...lesson, cancelled: true, confirmed: true });
    store.close();
    store = new Store(path);
    service = new AcademicService(store, config, fetch, now);
    assert.equal(store.locals().length, 2);
    assert.equal(service.schedule('2026-10-20', 'day').events.length, 1);
    assert.equal(service.syncStatus().hasCache, true);
  } finally { store?.close(); rmSync(dir, { recursive: true, force: true }); }
});
