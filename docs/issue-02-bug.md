# BUG: MemoryManager read-modify-write — lost updates under concurrent activations

**Labels:** bug, concurrency

## Problem
Every mutation in `MemoryManager` uses non-atomic get-mutate-set: `recordEpisode`, `upsertPattern`, `upsertGoal`, `addSkill`, `addKnowledge` all do:
```js
const items = await this.store.get(key);
items.push/filter/splice(...);
await this.store.set(key, items);
```
With concurrent activations, two cycles can read the same list, both mutate, and one write clobbers the other's change. Episodes are silently dropped; patterns and goals can be lost.

## Location
`kernel.js` — `MemoryManager` class, all mutation methods

## Suggested Fix
**Option A (fast, SQLite-only):** Use individual `INSERT` statements for episodes. Add a `WHERE NOT EXISTS` check for upserts on patterns/goals using a unique `id` or `pattern.id` key.

**Option B (correct, store-agnostic):** Refactor MemoryManager to use per-entity tables in the store — `addEpisode(episode)` does `INSERT INTO episodes VALUES (...)` directly, `upsertPattern(pattern)` does `INSERT OR REPLACE INTO patterns ...`, etc. This eliminates the read-modify-write pattern entirely.

## Priority
Critical


**Suggested labels:** bug, concurrency
