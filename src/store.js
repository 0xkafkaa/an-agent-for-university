import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrate } from './migrations.js';

const COLUMNS = {
  assignments: { id: 'id', title: 'title', course: 'course', description: 'description', dueDate: 'due_date', dueTime: 'due_time', timezone: 'timezone', priority: 'priority', status: 'status', estimatedMinutes: 'estimated_minutes', createdAt: 'created_at', modifiedAt: 'modified_at', version: 'version' },
  exams: { id: 'id', subject: 'subject', examDate: 'exam_date', startTime: 'start_time', timezone: 'timezone', durationMinutes: 'duration_minutes', location: 'location', topics: 'topics_json', preparationStatus: 'preparation_status', createdAt: 'created_at', modifiedAt: 'modified_at', version: 'version' },
};
function columns(kind) {
  if (!Object.hasOwn(COLUMNS, kind)) throw new Error('Unknown record kind.');
  return COLUMNS[kind];
}
function decode(kind, row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(columns(kind)).map(([key, column]) => [key, key === 'topics' ? JSON.parse(row[column]) : row[column]]));
}

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    try { migrate(this.db); }
    catch (error) { this.db.close(); throw error; }
  }
  readSnapshot(read) {
    this.db.exec('BEGIN');
    try {
      const result = read();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  source() { return this.db.prepare('SELECT * FROM calendar_sources').get(); }
  saveSync(ics, now) {
    this.db.prepare(`UPDATE calendar_sources SET ics=?, last_synced_at=?, last_attempt_at=?, sync_error=NULL WHERE id='university'`).run(ics, now, now);
  }
  failSync(now, error) {
    this.db.prepare(`UPDATE calendar_sources SET last_attempt_at=?, sync_error=? WHERE id='university'`).run(now, error);
  }
  seedLocal(uid, ics) { this.db.prepare('INSERT OR IGNORE INTO local_events(uid,ics) VALUES (?,?)').run(uid, ics); }
  locals() { return this.db.prepare('SELECT * FROM local_events').all(); }
  overrides() { return this.db.prepare('SELECT * FROM occurrence_overrides').all(); }
  setOverride(uid, recurrenceId, replacement) {
    this.db.prepare(`INSERT INTO occurrence_overrides VALUES (?,?,?,?,?) ON CONFLICT(uid,recurrence_id)
      DO UPDATE SET cancelled=excluded.cancelled, replacement_json=excluded.replacement_json, modified_at=excluded.modified_at`)
      .run(uid, recurrenceId, replacement ? 0 : 1, replacement ? JSON.stringify(replacement) : null, new Date().toISOString());
  }
  insertRecord(kind, record) {
    const entries = Object.entries(columns(kind));
    this.db.prepare(`INSERT INTO ${kind} (${entries.map(([, c]) => c).join(',')}) VALUES (${entries.map(() => '?').join(',')})`)
      .run(...entries.map(([key]) => key === 'topics' ? JSON.stringify(record[key]) : record[key]));
  }
  getRecord(kind, id) {
    columns(kind);
    return decode(kind, this.db.prepare(`SELECT * FROM ${kind} WHERE id=?`).get(id));
  }
  listRecords(kind) {
    columns(kind);
    return this.db.prepare(`SELECT * FROM ${kind}`).all().map(row => decode(kind, row));
  }
  updateRecord(kind, record, expectedVersion) {
    const entries = Object.entries(columns(kind)).filter(([key]) => key !== 'id' && key !== 'createdAt');
    return this.db.prepare(`UPDATE ${kind} SET ${entries.map(([, c]) => `${c}=?`).join(',')} WHERE id=? AND version=?`)
      .run(...entries.map(([key]) => key === 'topics' ? JSON.stringify(record[key]) : record[key]), record.id, expectedVersion).changes === 1;
  }
  deleteRecord(kind, id, version) {
    columns(kind);
    return this.db.prepare(`DELETE FROM ${kind} WHERE id=? AND version=?`).run(id, version).changes === 1;
  }
  close() { this.db.close(); }
}
