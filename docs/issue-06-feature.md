# FEATURE: Per-entity storage — eliminate JSON blob reads/writes

**Labels:** enhancement, performance, refactor

## Problem
Episodes, patterns, goals, and knowledge are each stored as a single JSON array in the KV store. Every mutation reads the entire array, deserialises it, mutates, re-serialises, and writes it back — O(n) on every cycle. With 200 episodes and concurrent activations, this causes:
- Lost updates (race condition — see BUG: MemoryManager read-modify-write)
- Multi-KB JSON writes on every cycle via SQLite
- Episode trimming that drops entries from other concurrent activations

## Location
`store-sqlite.js`, `kernel.js` — `MemoryManager` class

## Suggested Fix
Redesign `SqliteStore` with proper per-entity tables:
```sql
CREATE TABLE episodes (id, activation_id, cycle, phase, action, outcome, timestamp);
CREATE TABLE patterns (id PRIMARY KEY, condition, action, priority, last_matched);
CREATE TABLE goals (id PRIMARY KEY, status, priority, ...);
CREATE TABLE knowledge (id PRIMARY KEY, fact, confidence, learned_at);
CREATE TABLE team (id PRIMARY KEY, ...);
```
MemoryManager calls `INSERT INTO episodes ...` directly instead of `get → push → set`.
This fixes both the race condition and the O(n) write problem in one change.

## Priority
Critical


**Suggested labels:** enhancement, performance, refactor
