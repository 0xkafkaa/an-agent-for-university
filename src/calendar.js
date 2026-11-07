import ICAL from 'ical.js';
import { DateTime } from 'luxon';

export const ZONE = 'Europe/Paris';
// Modern EU DST rules; feed-provided VTIMEZONE definitions take precedence.
const PARIS = `BEGIN:VTIMEZONE\r\nTZID:Europe/Paris\r\nBEGIN:STANDARD\r\nDTSTART:19961027T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nBEGIN:DAYLIGHT\r\nDTSTART:19960331T020000\r\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU\r\nTZOFFSETFROM:+0100\r\nTZOFFSETTO:+0200\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE`;

export function parseCalendar(text) {
  const root = new ICAL.Component(ICAL.parse(text));
  if (root.name !== 'vcalendar' || root.getFirstPropertyValue('version') !== '2.0') throw new Error('Expected an ICS 2.0 calendar.');
  // Parsing and expansion are synchronous: isolate timezone registration per calendar.
  ICAL.TimezoneService.reset();
  ICAL.TimezoneService.register(new ICAL.Timezone(new ICAL.Component(ICAL.parse(PARIS))));
  for (const zone of root.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(new ICAL.Timezone(zone));
  const selected = new Map();
  for (const component of root.getAllSubcomponents('vevent')) {
    const uid = component.getFirstPropertyValue('uid');
    if (!uid) throw new Error('Event missing UID.');
    const rid = component.getFirstProperty('recurrence-id');
    if (rid?.getParameter('range')) throw new Error('Recurrence RANGE edits are not supported.');
    for (const name of ['dtstart', 'dtend', 'recurrence-id', 'rdate', 'exdate']) {
      for (const p of component.getAllProperties(name)) {
        const tzid = p.getParameter('tzid');
        if (tzid && !ICAL.TimezoneService.has(tzid)) throw new Error('Unsupported calendar timezone.');
        if (p.type === 'period') throw new Error('RDATE periods are not supported.');
      }
    }
    const event = new ICAL.Event(component);
    const cancelled = component.getFirstPropertyValue('status') === 'CANCELLED';
    if (!cancelled && !event.startDate) throw new Error('Event missing start date.');
    if (event.startDate && toDateTime(event.endDate) < toDateTime(event.startDate)) throw new Error('Event ends before it starts.');
    const key = `${uid}\0${rid ? recurrenceKey(event.recurrenceId) : ''}`;
    const rank = [Number(component.getFirstPropertyValue('sequence') ?? 0), String(component.getFirstPropertyValue('last-modified') ?? component.getFirstPropertyValue('dtstamp') ?? '')];
    const previous = selected.get(key);
    if (!previous || rank[0] > previous.rank[0] || (rank[0] === previous.rank[0] && rank[1] >= previous.rank[1])) selected.set(key, { event, rank });
  }
  return [...selected.values()].map(x => x.event);
}

function toDateTime(time) {
  if (!time) throw new Error('Missing calendar time.');
  const tzid = time.zone?.tzid;
  // Floating times and all-day dates are interpreted in the academic timezone.
  const zone = time.isDate || tzid === 'floating' ? ZONE : tzid === 'UTC' ? 'UTC' : tzid;
  const wall = { year: time.year, month: time.month, day: time.day, hour: time.hour, minute: time.minute, second: time.second };
  let dt = DateTime.fromObject(wall, { zone });
  if (!dt.isValid && time.zone) dt = DateTime.fromJSDate(time.toJSDate());
  if (!dt.isValid) throw new Error('Invalid calendar time.');
  return dt.setZone(ZONE);
}

function recurrenceKey(time) { return time.isDate ? time.toString() : toDateTime(time).toUTC().toISO(); }
function cancelled(event) { return event.component.getFirstPropertyValue('status') === 'CANCELLED'; }

export function expandCalendar(text, source, from, to) {
  const definitions = parseCalendar(text);
  const exceptions = new Map();
  for (const event of definitions) {
    if (event.isRecurrenceException()) {
      if (!exceptions.has(event.uid)) exceptions.set(event.uid, new Set());
      exceptions.get(event.uid).add(recurrenceKey(event.recurrenceId));
    }
  }
  const cancelledSeries = new Set(definitions.filter(e => !e.isRecurrenceException() && cancelled(e)).map(e => e.uid));
  const result = new Map();
  function add(event, startTime, endTime, rid) {
    const start = toDateTime(startTime);
    const end = toDateTime(endTime);
    if (start >= to || (end <= from && !(end.equals(start) && start >= from))) return;
    const id = `${source}:${event.uid}:${rid}`;
    result.set(id, {
      id, uid: event.uid, source, recurrenceId: rid,
      title: event.summary || '(Untitled class)', start: start.toISO(), end: end.toISO(),
      allDay: startTime.isDate, location: event.location || null, description: event.description || null,
      status: event.component.getFirstPropertyValue('status') || 'CONFIRMED',
      organizer: String(event.component.getFirstPropertyValue('organizer') || '') || null,
      readOnly: source === 'university',
    });
  }
  for (const event of definitions) {
    if (cancelled(event) || cancelledSeries.has(event.uid)) continue;
    if (event.isRecurrenceException()) {
      add(event, event.startDate, event.endDate, recurrenceKey(event.recurrenceId));
    } else if (!event.isRecurring()) {
      const rid = recurrenceKey(event.startDate);
      if (!exceptions.get(event.uid)?.has(rid)) add(event, event.startDate, event.endDate, rid);
    } else {
      const iterator = event.iterator();
      let steps = 0;
      for (let time; (time = iterator.next());) {
        if (++steps > 100000) throw new Error('Recurrence expansion limit exceeded.');
        if (toDateTime(time) >= to) break;
        const rid = recurrenceKey(time);
        if (exceptions.get(event.uid)?.has(rid)) continue;
        const end = time.clone();
        end.addDuration(event.duration);
        add(event, time, end, rid);
      }
    }
  }
  return [...result.values()];
}

export function dateRange(date, view = 'week') {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Use a YYYY-MM-DD date.');
  if (!['day', 'week'].includes(view)) throw new Error('View must be day or week.');
  let from = DateTime.fromISO(date, { zone: ZONE });
  if (!from.isValid) throw new Error('Invalid date.');
  from = view === 'week' ? from.startOf('week') : from.startOf('day');
  return { from, to: from.plus(view === 'week' ? { weeks: 1 } : { days: 1 }) };
}

export function frenchCalendars(startDate) {
  const { from } = dateRange(startDate, 'day');
  return [2, 4].map(weekday => {
    const first = from.plus({ days: (weekday - from.weekday + 7) % 7 });
    const date = first.toFormat('yyyyMMdd');
    const uid = `french-${weekday}`;
    return { uid, ics: `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Academic Manager//FR\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTART;TZID=Europe/Paris:${date}T143000\r\nDTEND;TZID=Europe/Paris:${date}T163000\r\nRRULE:FREQ=WEEKLY\r\nSUMMARY:French lesson\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n` };
  });
}

export function findConflicts(events) {
  const conflicts = [];
  const sorted = events.filter(e => Date.parse(e.end) > Date.parse(e.start)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length && Date.parse(sorted[j].start) < Date.parse(sorted[i].end); j++) {
      if (Date.parse(sorted[j].end) > Date.parse(sorted[i].start)) conflicts.push({ eventIds: [sorted[i].id, sorted[j].id] });
    }
  }
  return conflicts;
}
