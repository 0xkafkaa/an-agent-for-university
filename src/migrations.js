// Each migration is applied once, inside the same transaction as user_version.
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS calendar_sources (
    id TEXT PRIMARY KEY CHECK(id='university'), ics TEXT,
    last_synced_at TEXT, last_attempt_at TEXT, sync_error TEXT
  );
  INSERT OR IGNORE INTO calendar_sources(id) VALUES ('university');
  CREATE TABLE IF NOT EXISTS local_events (
    uid TEXT PRIMARY KEY, ics TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE IF NOT EXISTS occurrence_overrides (
    uid TEXT NOT NULL REFERENCES local_events(uid), recurrence_id TEXT NOT NULL,
    cancelled INTEGER NOT NULL CHECK(cancelled IN (0,1)), replacement_json TEXT, modified_at TEXT NOT NULL,
    PRIMARY KEY(uid,recurrence_id),
    CHECK((cancelled=1 AND replacement_json IS NULL) OR (cancelled=0 AND replacement_json IS NOT NULL))
  );`,
  `CREATE TABLE assignments (
    id TEXT PRIMARY KEY, title TEXT NOT NULL CHECK(length(trim(title)) > 0), course TEXT, description TEXT,
    due_date TEXT, due_time TEXT, timezone TEXT NOT NULL CHECK(timezone='Europe/Paris'),
    priority TEXT NOT NULL CHECK(priority IN ('low','normal','high')),
    status TEXT NOT NULL CHECK(status IN ('pending','in_progress','completed')),
    estimated_minutes INTEGER CHECK(estimated_minutes > 0),
    created_at TEXT NOT NULL, modified_at TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
    CHECK(due_time IS NULL OR due_date IS NOT NULL)
  );
  CREATE TABLE exams (
    id TEXT PRIMARY KEY, subject TEXT NOT NULL CHECK(length(trim(subject)) > 0), exam_date TEXT, start_time TEXT,
    timezone TEXT NOT NULL CHECK(timezone='Europe/Paris'), duration_minutes INTEGER CHECK(duration_minutes > 0),
    location TEXT, topics_json TEXT NOT NULL CHECK(json_valid(topics_json) AND json_type(topics_json)='array'),
    preparation_status TEXT NOT NULL CHECK(preparation_status IN ('not_started','in_progress','ready')),
    created_at TEXT NOT NULL, modified_at TEXT NOT NULL, version INTEGER NOT NULL CHECK(version > 0),
    CHECK(start_time IS NULL OR exam_date IS NOT NULL)
  );
  CREATE INDEX assignments_due ON assignments(status,due_date);
  CREATE INDEX exams_date ON exams(exam_date);`,
];

export function migrate(db) {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version > MIGRATIONS.length) throw new Error('Database is newer than this application. Upgrade the application; do not reset the database.');
    for (let i = version; i < MIGRATIONS.length; i++) {
      db.exec(MIGRATIONS[i]);
      db.exec(`PRAGMA user_version=${i + 1}`);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
