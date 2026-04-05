# BUG: _enqueue race — _activeCount check-then-await is not atomic

**Labels:** bug, concurrency

## Problem
In `ActivationHarness._enqueue` (kernel.js:120-125), the check `this._activeCount < this.maxConcurrent` and the subsequent `await this._run(trigger)` are not atomic. Two near-simultaneous `emit()` calls can both pass the `if` check before either hits `this._activeCount++` inside `_run`. With `maxConcurrent: 1`, this allows two activations to execute in parallel during the TOCTOU window.

## Location
`kernel.js` — `ActivationHarness._enqueue()` lines 120-125

## Suggested Fix
Increment `_activeCount` in `_enqueue` *before* awaiting `_run`, as an atomic pre-check:
```js
async _enqueue(trigger) {
  if (this._activeCount < this.maxConcurrent) {
    this._activeCount++;
    this._run(trigger).finally(() => { this._activeCount--; this._processQueue(); });
  } else {
    this._queue.push(trigger);
  }
}
```
Alternatively, use a semaphore/mutex library.

## Priority
High


**Suggested labels:** bug, concurrency
