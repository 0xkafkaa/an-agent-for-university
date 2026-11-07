import { planningPreferenceProperties } from './planning-policy.js';
import { overviewOutput } from './overview.js';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = items => ({ type: 'array', items });
const string = { type: 'string' }, nullableString = { type: ['string', 'null'] }, integer = { type: 'integer' };
const nullableInteger = { type: ['integer', 'null'] };
const kind = { type: 'string', enum: ['assignment', 'exam', 'requested'] };
const basis = { type: 'string', enum: ['record_estimate', 'starter_suggestion', 'user_request'] };
export const planningOutput = object({
  timezone: { type: 'string', const: 'Europe/Paris' }, generatedAt: string,
  range: object({ from: string, to: string }), subject: nullableString,
  availability: { type: 'string', enum: ['calendar_based', 'provisional', 'unavailable'] },
  calendar: overviewOutput.properties.calendar,
  policy: object(planningPreferenceProperties),
  warnings: array(object({ code: string, message: string, recordIds: array(string) })), notes: array(string), insights: array(string),
  excludedDates: array(object({ date: string, reason: string, recordIds: array(string) })),
  blockedPeriods: array(object({ start: string, end: string })),
  freePeriods: array(object({ date: string, start: string, end: string, minutes: integer })),
  days: array(object({ date: string, freeMinutes: integer, plannedMinutes: integer })),
  workload: array(object({
    id: string, recordId: nullableString, kind, title: string, course: nullableString, topics: array(string),
    dueDate: nullableString, dueTime: nullableString, priority: nullableString, status: string,
    estimatedMinutes: nullableInteger, budgetMinutes: integer, budgetBasis: basis,
    urgency: { type: 'string', enum: ['overdue', 'dated', 'undated'] },
    deadlineAt: nullableString, planningCutoff: nullableString,
    cutoffReason: { type: 'string', enum: ['exact_deadline', 'before_date_only_deadline', 'overdue_recovery', 'no_deadline'] },
    reason: string, allocatedMinutes: integer, unallocatedMinutes: integer, unallocatedReason: nullableString,
  })),
  sessions: array(object({ taskId: string, kind, title: string, start: string, end: string, minutes: integer, tentative: { type: 'boolean' }, budgetBasis: basis, reason: string, topics: array(string) })),
  summary: object({
    freeMinutes: integer, plannedMinutes: integer, targetMinutes: integer, unallocatedMinutes: integer,
    requestedMinutes: nullableInteger, requestedShortfallMinutes: nullableInteger,
    unknownEffortCount: integer, undatedWorkCount: integer, overdueWorkCount: integer,
  }),
});
