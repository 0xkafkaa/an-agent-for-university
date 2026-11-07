import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { ZONE } from './calendar.js';

export class RecordError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const text = (maxLength, nullable = false) => ({ type: nullable ? ['string', 'null'] : 'string', maxLength });
const choice = values => ({ type: 'string', enum: values });
const date = { type: ['string', 'null'], pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const time = { type: ['string', 'null'], pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' };
const minutes = { type: ['integer', 'null'], minimum: 1, maximum: 1000000 };
const fields = {
  assignments: {
    title: { ...text(300), minLength: 1 }, course: text(300, true), description: text(10000, true),
    dueDate: date, dueTime: time, priority: choice(['low', 'normal', 'high']),
    status: choice(['pending', 'in_progress', 'completed']), estimatedMinutes: minutes,
  },
  exams: {
    subject: { ...text(300), minLength: 1 }, examDate: date, startTime: time, durationMinutes: minutes,
    location: text(500, true), topics: { type: 'array', maxItems: 100, items: { ...text(2000), minLength: 1 } },
    preparationStatus: choice(['not_started', 'in_progress', 'ready']),
  },
};
const idSchema = { type: 'string', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' };
const versionSchema = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const object = (properties, required = [], extra = {}) => ({ type: 'object', properties, required, additionalProperties: false, ...extra });
const commonFilters = {
  query: text(300), from: { ...date, type: 'string' }, to: { ...date, type: 'string' },
  period: choice(['today', 'this_week', 'next_week', 'this_month', 'next_month']),
  undated: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 200 }, offset: { type: 'integer', minimum: 0, maximum: 1000000 },
};
export const recordSchemas = Object.fromEntries(Object.entries(fields).map(([kind, properties]) => [kind, {
  create: object(properties, [kind === 'assignments' ? 'title' : 'subject']),
  patch: object(properties, [], { minProperties: 1 }),
  update: object({ id: idSchema, version: versionSchema, changes: object(properties, [], { minProperties: 1 }) }, ['id', 'version', 'changes']),
  identity: object({ id: idSchema, version: versionSchema }, ['id', 'version']),
  filters: object({ ...commonFilters, ...(kind === 'assignments' ? { course: text(300), status: properties.status, priority: properties.priority, overdue: { type: 'boolean' } } : { preparationStatus: properties.preparationStatus }) }),
  output: object({
    ...Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, schema])),
    id: idSchema, timezone: { type: 'string', const: ZONE }, createdAt: { type: 'string' }, modifiedAt: { type: 'string' }, version: versionSchema,
    ...(kind === 'assignments' ? { deadlineState: choice(['unknown', 'upcoming', 'due_today', 'overdue', 'completed']) } : {}),
  }, [...Object.keys(properties), 'id', 'timezone', 'createdAt', 'modifiedAt', 'version', ...(kind === 'assignments' ? ['deadlineState'] : [])]),
}]));

// Deliberately limited to the schema keywords used above. Service validation is
// independent of Pi so HTTP/manual entry has exactly the same checks.
export function validate(schema, value, name = 'input') {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (!types.includes(actual) && !(types.includes('integer') && Number.isSafeInteger(value))) throw new RecordError(`${name}: invalid type.`);
  if (value === null) return;
  if (schema.enum && !schema.enum.includes(value)) throw new RecordError(`${name}: invalid option.`);
  if (schema.const !== undefined && value !== schema.const) throw new RecordError(`${name}: invalid value.`);
  if (typeof value === 'string') {
    if (value.length > (schema.maxLength ?? Infinity) || value.trim().length < (schema.minLength ?? 0) || (schema.pattern && !new RegExp(schema.pattern).test(value))) throw new RecordError(`${name}: invalid text or format.`);
  }
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) throw new RecordError(`${name}: invalid number.`);
  if (actual === 'array') {
    if (value.length > schema.maxItems) throw new RecordError(`${name}: too many items.`);
    value.forEach((item, i) => validate(schema.items, item, `${name}[${i}]`));
  }
  if (actual === 'object') {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new RecordError(`${name}: missing ${key}.`);
    if (Object.keys(value).length < (schema.minProperties ?? 0)) throw new RecordError(`${name}: no changes supplied.`);
    for (const [key, item] of Object.entries(value)) {
      if (!Object.hasOwn(schema.properties, key)) throw new RecordError(`${name}: unknown field.`);
      validate(schema.properties[key], item, `${name}.${key}`);
    }
  }
}
function validDate(value, name) {
  if (value !== null && !DateTime.fromISO(value, { zone: ZONE }).isValid) throw new RecordError(`${name}: invalid calendar date.`);
}
function checkDateTime(dateValue, timeValue) {
  validDate(dateValue, 'date');
  if (timeValue === null) return;
  if (dateValue === null) throw new RecordError('A time requires a date.');
  const wallTime = `${dateValue}T${timeValue}`;
  const dt = DateTime.fromISO(wallTime, { zone: ZONE });
  if (!dt.isValid || dt.toFormat("yyyy-MM-dd'T'HH:mm") !== wallTime) throw new RecordError('This Paris time does not exist because of daylight saving time.');
  if (dt.getPossibleOffsets().length > 1) throw new RecordError('This Paris time is ambiguous because of daylight saving time. Clarify the time before saving.');
}

export class RecordsService {
  constructor(store, now = () => DateTime.now().setZone(ZONE)) { this.store = store; this.now = now; }
  schemas(kind) {
    if (!Object.hasOwn(recordSchemas, kind)) throw new RecordError('Unknown record kind.');
    return recordSchemas[kind];
  }
  context() {
    const now = this.now().setZone(ZONE);
    return { timezone: ZONE, today: now.toISODate(), localTime: now.toFormat('HH:mm'), now: now.toISO() };
  }
  normalize(kind, values) {
    const normalized = Object.fromEntries(Object.entries(values).map(([key, value]) => [key,
      typeof value === 'string' ? value.trim() || null : Array.isArray(value) ? value.map(s => s.trim()) : value,
    ]));
    checkDateTime(kind === 'assignments' ? normalized.dueDate : normalized.examDate, kind === 'assignments' ? normalized.dueTime : normalized.startTime);
    return normalized;
  }
  present(kind, row, referenceTime = this.now()) {
    if (kind !== 'assignments') return row;
    const now = referenceTime.setZone(ZONE);
    const today = now.toISODate();
    const overdue = row.dueDate && (row.dueTime
      ? DateTime.fromISO(`${row.dueDate}T${row.dueTime}`, { zone: ZONE }).toMillis() < now.toMillis()
      : row.dueDate < today);
    return { ...row, deadlineState: row.status === 'completed' ? 'completed' : !row.dueDate ? 'unknown' : overdue ? 'overdue' : row.dueDate === today ? 'due_today' : 'upcoming' };
  }
  get(kind, id) {
    this.schemas(kind);
    validate(idSchema, id, 'id');
    const row = this.store.getRecord(kind, id);
    if (!row) throw new RecordError('Record not found.', 404);
    return this.present(kind, row);
  }
  create(kind, input) {
    validate(this.schemas(kind).create, input);
    const defaults = kind === 'assignments'
      ? { course: null, description: null, dueDate: null, dueTime: null, priority: 'normal', status: 'pending', estimatedMinutes: null }
      : { examDate: null, startTime: null, durationMinutes: null, location: null, topics: [], preparationStatus: 'not_started' };
    const values = this.normalize(kind, { ...defaults, ...input });
    const timestamp = this.now().toUTC().toISO();
    const row = { ...values, id: randomUUID(), timezone: ZONE, createdAt: timestamp, modifiedAt: timestamp, version: 1 };
    this.store.insertRecord(kind, row);
    return this.present(kind, row);
  }
  update(kind, input) {
    validate(this.schemas(kind).update, input);
    const previous = this.get(kind, input.id);
    if (previous.version !== input.version) throw new RecordError('Record changed. Reload it before updating.', 409);
    const { deadlineState: _state, ...stored } = previous;
    const row = { ...this.normalize(kind, { ...stored, ...input.changes }), modifiedAt: this.now().toUTC().toISO(), version: previous.version + 1 };
    if (!this.store.updateRecord(kind, row, input.version)) throw new RecordError('Record changed. Reload it before updating.', 409);
    return this.present(kind, row);
  }
  complete(input) {
    validate(this.schemas('assignments').identity, input);
    return this.update('assignments', { ...input, changes: { status: 'completed' } });
  }
  delete(kind, input, confirmed = false) {
    validate(this.schemas(kind).identity, input);
    if (confirmed !== true) throw new RecordError('Explicit user confirmation is required.', 403);
    const previous = this.get(kind, input.id);
    if (previous.version !== input.version || !this.store.deleteRecord(kind, input.id, input.version)) throw new RecordError('Record changed. Reload it before deleting.', 409);
    return { deleted: true, id: input.id };
  }
  list(kind, filters = {}) {
    validate(this.schemas(kind).filters, filters);
    for (const key of ['from', 'to']) if (filters[key]) validDate(filters[key], key);
    if (filters.period && (filters.from || filters.to)) throw new RecordError('Use a period or explicit dates, not both.');
    const now = this.now().setZone(ZONE);
    let from = filters.from ?? null, to = filters.to ?? null;
    if (filters.period) {
      let start = now.startOf('day'), end = start;
      if (filters.period.endsWith('week')) { start = now.startOf('week').plus({ weeks: filters.period === 'next_week' ? 1 : 0 }); end = start.plus({ days: 6 }); }
      if (filters.period.endsWith('month')) { start = now.startOf('month').plus({ months: filters.period === 'next_month' ? 1 : 0 }); end = start.endOf('month'); }
      from = start.toISODate(); to = end.toISODate();
    }
    if (from && to && from > to) throw new RecordError('from must not be after to.');
    if (filters.undated && (from || to || filters.overdue)) throw new RecordError('Undated records cannot have date/overdue filters.');
    const dateKey = kind === 'assignments' ? 'dueDate' : 'examDate';
    let items = this.store.listRecords(kind).map(row => this.present(kind, row)).filter(row => {
      const day = row[dateKey];
      if ((from && (!day || day < from)) || (to && (!day || day > to))) return false;
      if (filters.undated !== undefined && (day === null) !== filters.undated) return false;
      for (const key of ['status', 'priority', 'preparationStatus']) if (filters[key] && row[key] !== filters[key]) return false;
      if (filters.course && (row.course ?? '').toLowerCase() !== filters.course.toLowerCase()) return false;
      if (filters.overdue !== undefined && (row.deadlineState === 'overdue') !== filters.overdue) return false;
      if (filters.query && ![row.title, row.subject, row.course, row.description, ...(row.topics ?? [])].some(value => value?.toLowerCase().includes(filters.query.toLowerCase()))) return false;
      return true;
    });
    items.sort((a, b) => (a[dateKey] ?? '9999-99-99').localeCompare(b[dateKey] ?? '9999-99-99') || (a.dueTime ?? a.startTime ?? '99:99').localeCompare(b.dueTime ?? b.startTime ?? '99:99') || a.id.localeCompare(b.id));
    const total = items.length;
    const offset = filters.offset ?? 0, limit = filters.limit ?? 100;
    items = items.slice(offset, offset + limit);
    return { ...this.context(), items, total, offset, limit, hasMore: offset + items.length < total, from, to };
  }
}
