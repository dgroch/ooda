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
    // Production-grade SQLite settings
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id          TEXT PRIMARY KEY,
        from_agent  TEXT NOT NULL,
        to_agent    TEXT NOT NULL,
        content     TEXT NOT NULL,
        goal_id     TEXT,
        step_id     TEXT,
        status      TEXT DEFAULT 'pending',
        metadata    TEXT DEFAULT '{}',
        created_at   TEXT DEFAULT (datetime('now')),
        acknowledged_at TEXT
      )
    `);

    // Prepared statements for performance
    this._get = this.db.prepare('SELECT value FROM kv WHERE key = ?');
    this._set = this.db.prepare('INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))');
    this._del = this.db.prepare('DELETE FROM kv WHERE key = ?');
    this._list = this.db.prepare('SELECT key FROM kv WHERE key LIKE ?');
    this._all = this.db.prepare('SELECT key FROM kv');

    // Message statements
    this._msgInsert = this.db.prepare(
      'INSERT INTO messages (id, from_agent, to_agent, content, goal_id, step_id, status, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    );
    this._msgGet = this.db.prepare('SELECT * FROM messages WHERE id = ?');
    this._msgListPending = this.db.prepare('SELECT * FROM messages WHERE to_agent = ? AND status = ? ORDER BY created_at ASC');
    this._msgAck = this.db.prepare("UPDATE messages SET status = 'acknowledged', acknowledged_at = datetime('now') WHERE id = ?");
    this._msgListByGoal = this.db.prepare('SELECT * FROM messages WHERE goal_id = ? ORDER BY created_at ASC');
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

  // ── Message Inbox ──────────────────────────────────────────

  async saveMessage(msg) {
    this._msgInsert.run(
      msg.id, msg.from, msg.to, msg.content,
      msg.goalId ?? null, msg.stepId ?? null,
      msg.status ?? 'pending',
      JSON.stringify(msg.metadata ?? {}),
    );
    return msg;
  }

  async getMessage(id) {
    const row = this._msgGet.get(id);
    return row ? { ...row, metadata: JSON.parse(row.metadata) } : null;
  }

  async getPendingMessages(toAgent) {
    const rows = this._msgListPending.all(toAgent, 'pending');
    return rows.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));
  }

  async acknowledgeMessage(id) {
    const row = this._msgGet.get(id);
    if (!row) return null;
    this._msgAck.run(id);
    return { ...row, status: 'acknowledged' };
  }

  async getMessagesByGoal(goalId) {
    const rows = this._msgListByGoal.all(goalId);
    return rows.map((r) => ({ ...r, metadata: JSON.parse(r.metadata) }));
  }

  close() {
    this.db.close();
  }
}

export { SqliteStore };
