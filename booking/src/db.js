import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS bookings (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      email           TEXT NOT NULL,
      note            TEXT NOT NULL DEFAULT '',
      visitor_tz      TEXT NOT NULL,
      start_ms        INTEGER NOT NULL,
      end_ms          INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | cancelled
      google_event_id TEXT,
      meet_link       TEXT,
      google_error    TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS bookings_time ON bookings (status, start_ms);
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const q = {
    insert: db.prepare(`INSERT INTO bookings (id, name, email, note, visitor_tz, start_ms, end_ms, created_at, updated_at)
                        VALUES (:id, :name, :email, :note, :visitor_tz, :start_ms, :end_ms, :now, :now)`),
    get: db.prepare('SELECT * FROM bookings WHERE id = ?'),
    busy: db.prepare(`SELECT id, start_ms, end_ms FROM bookings
                      WHERE status = 'confirmed' AND end_ms > ? AND start_ms < ?`),
    upcoming: db.prepare(`SELECT * FROM bookings WHERE status = 'confirmed' AND end_ms > ? ORDER BY start_ms LIMIT 200`),
    reschedule: db.prepare('UPDATE bookings SET start_ms = ?, end_ms = ?, updated_at = ? WHERE id = ?'),
    cancel: db.prepare(`UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE id = ?`),
    google: db.prepare('UPDATE bookings SET google_event_id = ?, meet_link = ?, google_error = ?, updated_at = ? WHERE id = ?'),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    delSetting: db.prepare('DELETE FROM settings WHERE key = ?'),
  };

  return {
    raw: db,
    insertBooking: (b) => q.insert.run({ ...b, now: Date.now() }),
    getBooking: (id) => q.get.get(id),
    // Confirmed bookings overlapping [from, to), optionally ignoring one booking.
    busyBookings: (from, to, excludeId = null) =>
      q.busy.all(from, to)
        .filter((r) => r.id !== excludeId)
        .map((r) => ({ start: r.start_ms, end: r.end_ms })),
    upcomingBookings: (now) => q.upcoming.all(now),
    rescheduleBooking: (id, start, end) => q.reschedule.run(start, end, Date.now(), id),
    cancelBooking: (id) => q.cancel.run(Date.now(), id),
    setGoogle: (id, eventId, meetLink, error) => q.google.run(eventId, meetLink, error, Date.now(), id),
    getSetting: (key) => q.getSetting.get(key)?.value ?? null,
    setSetting: (key, value) => q.setSetting.run(key, value),
    deleteSetting: (key) => q.delSetting.run(key),
  };
}
