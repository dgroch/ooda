/**
 * SQLite Store Adapter
 *
 * Drop-in replacement for InMemoryStore. Uses Node 22's native
 * node:sqlite module — zero dependencies.
 *
 * Data persists across process restarts. Each key-value pair is
 * stored as a JSON-serialised row in a single table.
 */

import { DatabaseSync } from 'node:sqlite';

class SqliteStore {
  /**
   * @param {string} dbPath - Path to SQLite file (e.g. './agent.db')
   */
  constructor(dbPath = './agent.db') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Prepared statements for performance
    this._get = this.db.prepare('SELECT value FROM kv WHERE key = ?');
    this._set = this.db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))');
    this._del = this.db.prepare('DELETE FROM kv WHERE key = ?');
    this._list = this.db.prepare('SELECT key FROM kv WHERE key LIKE ?');
    this._all = this.db.prepare('SELECT key FROM kv');
  }

  async get(key) {
    const row = this._get.get(key);
    return row ? JSON.parse(row.value) : null;
  }

  async set(key, value) {
    this._set.run(key, JSON.stringify(value));
  }

  async delete(key) {
    this._del.run(key);
  }

  async list(prefix) {
    if (prefix) {
      return this._list.all(`${prefix}%`).map((r) => r.key);
    }
    return this._all.all().map((r) => r.key);
  }

  close() {
    this.db.close();
  }
}

export { SqliteStore };
