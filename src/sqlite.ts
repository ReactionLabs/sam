import Database from "better-sqlite3";

/**
 * The one SQLite open (F1, cross-process database locking).
 *
 * Two SAM processes on one workspace (the dashboard and a
 * heartbeat, the CLI and a tick) write the same files. A
 * connection left in DELETE journal mode takes a lock the other
 * process cannot share, and a connection with no busy timeout
 * turns the wait into an immediate "database is locked". Journal
 * mode lives in the file only after an opener sets it: the first
 * connection otherwise creates a DELETE-mode database. The busy
 * timeout is per connection, and this driver will honor a timeout
 * of 0, so the library default is not the contract.
 *
 * That pair is not the whole lock. A deferred transaction that
 * reads and then writes still throws "database is locked"
 * (SQLITE_BUSY_SNAPSHOT) when a peer commits in between, and the
 * busy handler is not invoked for that code, so busy_timeout never
 * gets to wait. Write transactions on these connections therefore
 * begin IMMEDIATE: the writer takes the lock up front, the peer
 * waits out the timeout, and the snapshot cannot go stale.
 *
 * Every open in the codebase goes through this function. There is
 * no other `new Database`. A writable connection sets WAL and
 * requires the pragma to report wal. A readonly connection cannot
 * flip the mode; it sets the same busy timeout and requires the
 * file to already be wal, which every writer here, including the
 * backup snapshot, guarantees before the file is sealed.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

export function openDatabase(path: string, options?: Database.Options): Database.Database {
  const db = new Database(path, { ...options, timeout: SQLITE_BUSY_TIMEOUT_MS });
  db.pragma("busy_timeout = " + SQLITE_BUSY_TIMEOUT_MS);
  if (options?.readonly) {
    const mode = db.pragma("journal_mode", { simple: true });
    if (mode !== "wal") throw new Error("SQLite database is not in WAL mode (" + String(mode) + "): " + path);
    return db;
  }
  const mode = db.pragma("journal_mode = WAL", { simple: true });
  if (mode !== "wal") throw new Error("SQLite refused WAL journal mode (" + String(mode) + "): " + path);
  beginImmediate(db);
  return db;
}

/** Default `db.transaction()` to BEGIN IMMEDIATE. Nested calls stay
 *  savepoints: better-sqlite3 uses a savepoint once a transaction
 *  is already open, so an inner immediate does not start a second
 *  BEGIN. Explicit `.deferred()` is left available and unused. */
function beginImmediate(db: Database.Database): void {
  const original = db.transaction.bind(db);
  const wrapped: Database.Database["transaction"] = (fn) => {
    const tx = original(fn);
    const call = (...args: unknown[]) => (tx.immediate as (...params: unknown[]) => unknown)(...args);
    const run = call as unknown as typeof tx;
    run.default = call as unknown as typeof tx.default;
    run.deferred = tx.deferred;
    run.immediate = tx.immediate;
    run.exclusive = tx.exclusive;
    return run;
  };
  db.transaction = wrapped;
}
