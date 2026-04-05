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

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS episodes (
        id TEXT PRIMARY KEY,
        activation_id TEXT,
        cycle INTEGER,
        phase TEXT,
        action_type TEXT,
        outcome TEXT,
        timestamp TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS patterns (
        id TEXT PRIMARY KEY,
        condition TEXT,
        action TEXT,
        priority INTEGER,
        last_matched TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS skills (
        id TEXT PRIMARY KEY,
        data TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        data TEXT,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY,
        fact TEXT,
        confidence REAL,
        learned_at TEXT DEFAULT (datetime('now'))
      )
    `);

    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_timestamp ON episodes(timestamp)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_episodes_activation ON episodes(activation_id)`);

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

    // Episode statements
    this._epInsert = this.db.prepare('INSERT INTO episodes (id, activation_id, cycle, phase, action_type, outcome, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)');
    this._epGetRecent = this.db.prepare('SELECT * FROM episodes ORDER BY timestamp DESC LIMIT ?');
    this._epCount = this.db.prepare('SELECT COUNT(*) as count FROM episodes');
    this._epDeleteOldest = this.db.prepare('DELETE FROM episodes WHERE id IN (SELECT id FROM episodes ORDER BY timestamp ASC LIMIT ?)');

    // Pattern statements
    this._patternUpsert = this.db.prepare('INSERT OR REPLACE INTO patterns (id, condition, action, priority, last_matched) VALUES (?, ?, ?, ?, ?)');
    this._patternGetAll = this.db.prepare('SELECT * FROM patterns');

    // Skill statements
    this._skillUpsert = this.db.prepare('INSERT OR REPLACE INTO skills (id, data) VALUES (?, ?)');
    this._skillGetAll = this.db.prepare('SELECT * FROM skills');

    // Goal statements
    this._goalUpsert = this.db.prepare('INSERT OR REPLACE INTO goals (id, data, updated_at) VALUES (?, ?, datetime("now"))');
    this._goalGetAll = this.db.prepare('SELECT * FROM goals');

    // Knowledge statements
    this._knowledgeUpsert = this.db.prepare('INSERT OR REPLACE INTO knowledge (id, fact, confidence, learned_at) VALUES (?, ?, ?, datetime("now"))');
    this._knowledgeGetAll = this.db.prepare('SELECT * FROM knowledge');
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

  // ── Episodes ──────────────────────────────────────────

  async appendEpisode(episode) {
    this._epInsert.run(
      episode.id,
      episode.activation_id ?? null,
      episode.cycle ?? null,
      episode.phase ?? null,
      episode.action_type ?? null,
      episode.outcome ?? null,
      episode.timestamp ?? new Date().toISOString(),
    );
    // Trim to 200 most recent
    const { count } = this._epCount.get();
    if (count > 200) {
      this._epDeleteOldest.run(count - 200);
    }
  }

  async getRecentEpisodes(n) {
    return this._epGetRecent.all(n);
  }

  // ── Patterns ──────────────────────────────────────────

  async upsertPattern(pattern) {
    this._patternUpsert.run(
      pattern.id,
      pattern.condition ?? null,
      pattern.action ?? null,
      pattern.priority ?? null,
      pattern.lastMatched ?? null,
    );
  }

  async listPatterns() {
    return this._patternGetAll.all();
  }

  // ── Skills ──────────────────────────────────────────

  async upsertSkill(skill) {
    this._skillUpsert.run(skill.id, JSON.stringify(skill));
  }

  async listSkills() {
    return this._skillGetAll.all();
  }

  // ── Goals ──────────────────────────────────────────

  async upsertGoal(goal) {
    this._goalUpsert.run(goal.id, JSON.stringify(goal));
  }

  async listGoals() {
    return this._goalGetAll.all();
  }

  // ── Knowledge ──────────────────────────────────────────

  async upsertKnowledge(entry) {
    this._knowledgeUpsert.run(entry.id, entry.fact, entry.confidence ?? 0.5);
    // Evict lowest confidence when > 1000
    const rows = this._knowledgeGetAll.all();
    if (rows.length > 1000) {
      rows.sort((a, b) => (a.confidence ?? 0.5) - (b.confidence ?? 0.5));
      const toEvict = rows.slice(0, rows.length - 1000);
      for (const r of toEvict) {
        this.db.prepare('DELETE FROM knowledge WHERE id = ?').run(r.id);
      }
    }
  }

  async listKnowledge() {
    return this._knowledgeGetAll.all();
  }

  close() {
    this.db.close();
  }
}

export { SqliteStore };
