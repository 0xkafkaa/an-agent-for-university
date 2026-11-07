import { DateTime } from 'luxon';
import { ZONE, findConflicts } from './calendar.js';
import { recordSchemas } from './records.js';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const string = { type: 'string' }, nullableString = { type: ['string', 'null'] };
const array = items => ({ type: 'array', items });
const pick = (row, keys) => Object.fromEntries(keys.map(key => [key, row[key]]));
const assignmentKeys = ['id', 'title', 'course', 'dueDate', 'dueTime', 'priority', 'status', 'estimatedMinutes', 'deadlineState'];
const examKeys = ['id', 'subject', 'examDate', 'startTime', 'durationMinutes', 'location', 'preparationStatus'];
const eventKeys = ['id', 'title', 'source', 'start', 'end', 'allDay', 'location', 'status'];
const assignmentSchema = object(pick(recordSchemas.assignments.output.properties, assignmentKeys));
const examSchema = object({
  ...pick(recordSchemas.exams.output.properties, examKeys),
  daysUntil: { type: ['integer', 'null'] }, startsAt: nullableString, endsAt: nullableString,
  timingStatus: { type: 'string', enum: ['undated', 'date_passed', 'time_unknown_today', 'upcoming', 'in_progress', 'started_end_unknown', 'finished'] },
});
const eventSchema = object({ id: string, title: string, source: { type: 'string', enum: ['university', 'local'] }, start: string, end: string, allDay: { type: 'boolean' }, location: nullableString, status: string });
const conflictSchema = object({
  eventIds: array(string), start: string, end: string,
  events: array(object({ id: string, title: string, source: { type: 'string', enum: ['university', 'local', 'exam'] }, start: string, end: string, location: nullableString })),
});
export const OVERVIEW_POLICY = Object.freeze({ deadlineWindowDays: 7, preparationWindowDays: 14, examWindowDays: 30 });
export const overviewParameters = object({});
export const overviewOutput = object({
  timezone: { type: 'string', const: ZONE }, generatedAt: string,
  policy: object(Object.fromEntries(Object.entries(OVERVIEW_POLICY).map(([key, value]) => [key, { type: 'integer', const: value }]))),
  calendar: object({ lastSyncedAt: nullableString, lastAttemptAt: nullableString, error: nullableString, hasCache: { type: 'boolean' }, queryError: nullableString }),
  today: object({ date: string, events: array(eventSchema), assignments: array(assignmentSchema), exams: array(examSchema), conflicts: array(conflictSchema) }),
  week: object({ from: string, to: string, events: array(eventSchema), assignments: array(assignmentSchema), exams: array(examSchema), pendingAssignments: array(assignmentSchema), conflicts: array(conflictSchema) }),
  upcoming: object({ assignments: array(assignmentSchema), exams: array(examSchema) }),
  needsAttention: object({
    overdueAssignments: array(assignmentSchema), approachingAssignments: array(assignmentSchema),
    examsNeedingPreparation: array(examSchema), undatedAssignments: array(assignmentSchema), undatedExams: array(examSchema),
    examsWithIncompleteTiming: array(examSchema), conflicts: array(conflictSchema),
  }),
});

export function summarizeExam(row, now) {
  now = now.setZone(ZONE);
  const exam = pick(row, examKeys);
  const today = now.startOf('day');
  const date = row.examDate ? DateTime.fromISO(row.examDate, { zone: ZONE }) : null;
  const start = date && row.startTime ? DateTime.fromISO(`${row.examDate}T${row.startTime}`, { zone: ZONE }) : null;
  const end = start && row.durationMinutes !== null ? start.plus({ minutes: row.durationMinutes }) : null;
  let timingStatus;
  if (!date) timingStatus = 'undated';
  else if (end && end <= now) timingStatus = 'finished';
  else if (start && start <= now && end) timingStatus = 'in_progress';
  else if (!end && date < today) timingStatus = 'date_passed';
  else if (start && start <= now) timingStatus = 'started_end_unknown';
  else if (!start && date.equals(today)) timingStatus = 'time_unknown_today';
  else timingStatus = 'upcoming';
  return { ...exam, daysUntil: date ? Math.round(date.diff(today, 'days').days) : null, startsAt: start?.toISO() ?? null, endsAt: end?.toISO() ?? null, timingStatus };
}
function ordered(rows, dateKey, timeKey) {
  return rows.sort((a, b) => (a[dateKey] ?? '9999-99-99').localeCompare(b[dateKey] ?? '9999-99-99') || (a[timeKey] ?? '99:99').localeCompare(b[timeKey] ?? '99:99') || a.id.localeCompare(b.id));
}
function overlaps(event, from, to) {
  const start = DateTime.fromISO(event.start), end = DateTime.fromISO(event.end);
  return start < to && (end > from || (start.equals(end) && start >= from));
}
function conflictsFor(events) {
  const byId = new Map(events.map(event => [event.id, event]));
  return findConflicts(events).map(({ eventIds }) => {
    const pair = eventIds.map(id => byId.get(id));
    return {
      eventIds, start: DateTime.max(...pair.map(e => DateTime.fromISO(e.start))).setZone(ZONE).toISO(),
      end: DateTime.min(...pair.map(e => DateTime.fromISO(e.end))).setZone(ZONE).toISO(),
      events: pair.map(e => pick(e, ['id', 'title', 'source', 'start', 'end', 'location'])),
    };
  });
}

// A read-only projection of a single SQLite snapshot and a single captured clock.
// Never calls a model, fetches the feed, writes data, or invents unknown times.
export function buildAcademicOverview(service, now) {
  const day = now.startOf('day'), nextDay = day.plus({ days: 1 });
  const weekFrom = day.startOf('week'), weekTo = weekFrom.plus({ weeks: 1 });
  const attentionTo = day.plus({ days: OVERVIEW_POLICY.deadlineWindowDays });
  const preparationTo = day.plus({ days: OVERVIEW_POLICY.preparationWindowDays });
  const examsTo = day.plus({ days: OVERVIEW_POLICY.examWindowDays });
  const todayDate = day.toISODate();
  const inDates = (date, from, to) => date !== null && date >= from.toISODate() && date < to.toISODate();
  const assignments = ordered(service.store.listRecords('assignments').map(row => pick(service.records.present('assignments', row, now), assignmentKeys)), 'dueDate', 'dueTime');
  const pending = assignments.filter(a => a.status !== 'completed');
  const exams = ordered(service.store.listRecords('exams').map(row => summarizeExam(row, now)), 'examDate', 'startTime');
  const calendar = { ...service.syncStatus(), queryError: null };
  let events = [];
  try {
    events = service.scheduleBetween(weekFrom, DateTime.max(weekTo, attentionTo)).events.map(row => pick(row, eventKeys));
  } catch {
    calendar.queryError = 'Cached calendar could not be read. Classes and conflict checks may be incomplete.';
  }
  const examIntervals = exams.filter(e => e.startsAt && e.endsAt).map(e => ({
    id: `exam:${e.id}`, title: e.subject, source: 'exam', start: e.startsAt, end: e.endsAt, location: e.location,
  })).filter(e => overlaps(e, weekFrom, DateTime.max(weekTo, attentionTo)));
  const conflicts = conflictsFor([...events, ...examIntervals]);
  const onExamDateOrOverlapping = (exam, from, to) => inDates(exam.examDate, from, to) || (exam.startsAt && exam.endsAt && overlaps({ start: exam.startsAt, end: exam.endsAt }, from, to));
  const upcomingExams = exams.filter(e => (inDates(e.examDate, day, examsTo) && !['finished', 'date_passed'].includes(e.timingStatus)) || e.timingStatus === 'in_progress');
  const approaching = pending.filter(a => inDates(a.dueDate, day, attentionTo) && a.deadlineState !== 'overdue');
  const weekAssignments = assignments.filter(a => inDates(a.dueDate, weekFrom, weekTo));
  return {
    timezone: ZONE, generatedAt: now.toISO(), policy: { ...OVERVIEW_POLICY }, calendar,
    today: {
      date: todayDate, events: events.filter(e => overlaps(e, day, nextDay)),
      assignments: assignments.filter(a => a.dueDate === todayDate),
      exams: exams.filter(e => onExamDateOrOverlapping(e, day, nextDay)),
      conflicts: conflicts.filter(e => overlaps(e, day, nextDay)),
    },
    week: {
      from: weekFrom.toISO(), to: weekTo.toISO(), events: events.filter(e => overlaps(e, weekFrom, weekTo)),
      assignments: weekAssignments, exams: exams.filter(e => onExamDateOrOverlapping(e, weekFrom, weekTo)),
      pendingAssignments: weekAssignments.filter(a => a.status !== 'completed'), conflicts: conflicts.filter(e => overlaps(e, weekFrom, weekTo)),
    },
    upcoming: { assignments: approaching, exams: upcomingExams },
    needsAttention: {
      overdueAssignments: pending.filter(a => a.deadlineState === 'overdue'), approachingAssignments: approaching,
      examsNeedingPreparation: exams.filter(e => e.preparationStatus !== 'ready' && inDates(e.examDate, day, preparationTo) && ['upcoming', 'time_unknown_today'].includes(e.timingStatus)),
      undatedAssignments: pending.filter(a => a.dueDate === null), undatedExams: exams.filter(e => e.examDate === null),
      examsWithIncompleteTiming: exams.filter(e => inDates(e.examDate, day, attentionTo) && (e.startTime === null || e.durationMinutes === null) && !['finished', 'date_passed'].includes(e.timingStatus)),
      conflicts: conflicts.filter(e => DateTime.fromISO(e.end) > now && DateTime.fromISO(e.start) < attentionTo),
    },
  };
}
