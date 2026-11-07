import { DateTime } from 'luxon';
import { RecordsService, validate } from './records.js';
import { buildAcademicOverview, overviewParameters } from './overview.js';
import { buildStudyPlan } from './planning.js';
import { normalizePlanningPreferences } from './planning-policy.js';
import { ZONE, dateRange, expandCalendar, frenchCalendars, findConflicts, parseCalendar } from './calendar.js';

export class AcademicService {
  constructor(store, config, fetcher = fetch, now = () => DateTime.now().setZone(ZONE)) {
    this.store = store;
    this.config = config;
    this.planningPolicy = normalizePlanningPreferences(config.planning);
    this.fetcher = fetcher;
    this.now = now;
    this.records = new RecordsService(store, now);
    const start = config.frenchStartDate ?? now().startOf('week').toISODate();
    for (const event of frenchCalendars(start)) store.seedLocal(event.uid, event.ics);
  }
  sync() {
    if (this.pendingSync) return this.pendingSync;
    this.pendingSync = this.performSync().finally(() => { this.pendingSync = null; });
    return this.pendingSync;
  }
  async performSync() {
    const now = this.now().toUTC().toISO();
    try {
      const response = await this.fetcher(this.config.calendarUrl, {
        signal: AbortSignal.timeout(15000), redirect: 'error', headers: { Accept: 'text/calendar' },
      });
      if (!response.ok) throw new Error('Fetch failed.');
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 5 * 1024 * 1024) throw new Error('Calendar too large.');
          chunks.push(Buffer.from(value));
        }
      } finally { await reader.cancel(); }
      const text = Buffer.concat(chunks).toString('utf8');
      parseCalendar(text);
      // Exercise expansion before replacing a usable offline snapshot.
      expandCalendar(text, 'university', this.now().startOf('day'), this.now().plus({ years: 1 }));
      this.store.saveSync(text, now);
      return { ok: true, ...this.syncStatus() };
    } catch {
      // Never persist or return fetch/parser errors that might contain the private URL.
      this.store.failSync(now, 'Calendar refresh failed. Last successful cache retained.');
      return { ok: false, ...this.syncStatus() };
    }
  }
  syncStatus() {
    const source = this.store.source();
    return { lastSyncedAt: source.last_synced_at, lastAttemptAt: source.last_attempt_at, error: source.sync_error, hasCache: source.ics !== null };
  }
  schedule(date = this.now().toISODate(), view = 'week') {
    const { from, to } = dateRange(date, view);
    return this.scheduleBetween(from, to);
  }
  // Internal range query shared by the day/week calendar and academic overview.
  scheduleBetween(from, to) {
    const source = this.store.source();
    let events = source.ics ? expandCalendar(source.ics, 'university', from, to) : [];
    let local = this.store.locals().flatMap(row => expandCalendar(row.ics, 'local', from, to));
    for (const override of this.store.overrides()) {
      local = local.filter(e => !(e.uid === override.uid && e.recurrenceId === override.recurrence_id));
      if (!override.cancelled) {
        const replacement = JSON.parse(override.replacement_json);
        if (DateTime.fromISO(replacement.start) < to && DateTime.fromISO(replacement.end) > from) local.push(replacement);
      }
    }
    events = [...events, ...local].sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
    return { timezone: ZONE, from: from.toISO(), to: to.toISO(), events, conflicts: findConflicts(events), sync: this.syncStatus() };
  }
  overview(input = {}) {
    validate(overviewParameters, input);
    const now = this.now().setZone(ZONE);
    return this.store.readSnapshot(() => buildAcademicOverview(this, now));
  }
  suggestStudyPlan(input = {}) {
    const now = this.now().setZone(ZONE);
    return this.store.readSnapshot(() => buildStudyPlan(this, now, input));
  }
  overrideOccurrence(input) {
    if (input.confirmed !== true) throw new Error('Explicit confirmation is required.');
    const { uid, recurrenceId, cancelled } = input;
    if (typeof uid !== 'string' || typeof recurrenceId !== 'string' || typeof cancelled !== 'boolean') throw new Error('Invalid occurrence override.');
    const row = this.store.locals().find(e => e.uid === uid);
    if (!row) throw new Error('Only local French lessons can be edited.');
    const originalTime = DateTime.fromISO(recurrenceId, { zone: ZONE });
    if (!originalTime.isValid) throw new Error('Invalid recurrence ID.');
    const { from, to } = dateRange(originalTime.setZone(ZONE).toISODate(), 'day');
    const original = expandCalendar(row.ics, 'local', from, to).find(e => e.recurrenceId === recurrenceId);
    if (!original) throw new Error('Occurrence not found.');
    let replacement = null;
    if (!cancelled) {
      if (typeof input.start !== 'string' || typeof input.end !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(input.start) || !/(Z|[+-]\d{2}:\d{2})$/.test(input.end)) throw new Error('Start/end require ISO timestamps with offsets.');
      const start = DateTime.fromISO(input.start, { setZone: true }).setZone(ZONE);
      const end = DateTime.fromISO(input.end, { setZone: true }).setZone(ZONE);
      if (!start.isValid || !end.isValid || end <= start) throw new Error('End must be after start.');
      if (input.location != null && (typeof input.location !== 'string' || input.location.length > 500)) throw new Error('Invalid location.');
      replacement = { ...original, start: start.toISO(), end: end.toISO(), location: input.location ?? original.location };
    }
    this.store.setOverride(uid, recurrenceId, replacement);
    return { ok: true };
  }
  startRefresh() {
    void this.sync();
    this.timer = setInterval(() => void this.sync(), this.config.refreshMinutes * 60000);
    this.timer.unref();
  }
  async stop() { clearInterval(this.timer); await this.pendingSync; }
}
