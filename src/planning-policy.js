import { RecordError, validate } from './records.js';

export const DEFAULT_PLANNING = Object.freeze({
  windows: [{ start: '08:00', end: '20:00' }], weekdays: [1, 2, 3, 4, 5, 6, 7],
  minSessionMinutes: 25, maxSessionMinutes: 60, breakMinutes: 10,
  eventBufferMinutes: 15, dailyLimitMinutes: 180, starterMinutes: 60,
});
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const time = { type: 'string', pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' };
export const planningPreferenceProperties = {
  windows: { type: 'array', maxItems: 4, items: { type: 'object', properties: { start: time, end: { type: 'string', pattern: '^(([01]\\d|2[0-3]):[0-5]\\d|24:00)$' } }, required: ['start', 'end'], additionalProperties: false } },
  weekdays: { type: 'array', maxItems: 7, items: integer(1, 7) },
  minSessionMinutes: integer(5, 120), maxSessionMinutes: integer(5, 180),
  breakMinutes: integer(0, 60), eventBufferMinutes: integer(0, 120),
  dailyLimitMinutes: integer(0, 720), starterMinutes: integer(5, 600),
};
export const planningPreferencesSchema = { type: 'object', properties: planningPreferenceProperties, additionalProperties: false };
export const planningParameters = {
  type: 'object', additionalProperties: false,
  properties: {
    date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'First Paris date, today or up to one year ahead. Defaults to today.' },
    days: integer(1, 14),
    subject: { type: 'string', minLength: 1, maxLength: 300, description: 'Optional course/topic filter. If no active records match, this is an explicit user-requested study topic, not a new academic record.' },
    minutes: { ...integer(5, 10080), description: 'Optional total recommendation budget across the entire requested range, not an invented effort estimate.' },
    preferences: planningPreferencesSchema,
  },
};
export function normalizePlanningPreferences(input = {}, base = DEFAULT_PLANNING) {
  validate(planningPreferencesSchema, input, 'planning preferences');
  const policy = structuredClone({ ...base, ...input });
  if (!policy.windows.length || !policy.weekdays.length || new Set(policy.weekdays).size !== policy.weekdays.length) throw new RecordError('Study windows and unique weekdays must not be empty.');
  policy.windows.sort((a, b) => a.start.localeCompare(b.start));
  policy.weekdays.sort((a, b) => a - b);
  for (let i = 0; i < policy.windows.length; i++) {
    const window = policy.windows[i];
    if (window.start >= window.end || (i > 0 && policy.windows[i - 1].end > window.start)) throw new RecordError('Study windows must be same-day, ordered and non-overlapping. Use 24:00 for midnight at the end of a day.');
  }
  if (policy.maxSessionMinutes < policy.minSessionMinutes || policy.starterMinutes < policy.minSessionMinutes || (policy.dailyLimitMinutes !== 0 && policy.dailyLimitMinutes < policy.minSessionMinutes)) throw new RecordError('Maximum session, starter budget and nonzero daily limit must be at least the minimum session length.');
  return policy;
}
