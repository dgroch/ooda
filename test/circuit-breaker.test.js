import test from 'node:test';
import assert from 'node:assert/strict';

import { CircuitBreaker } from '../circuit-breaker.js';

function withFakeNow(t, startMs = 1700000000000) {
  const originalNow = Date.now;
  let now = startMs;
  Date.now = () => now;
  t.after(() => {
    Date.now = originalNow;
  });
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
      return now;
    },
  };
}

test('constructor defaults and custom options', () => {
  const defaults = new CircuitBreaker();
  assert.equal(defaults.failureThreshold, 5);
  assert.equal(defaults.halfOpenMs, 30000);
  assert.equal(defaults.resetOnSuccess, 1);

  const custom = new CircuitBreaker({
    failureThreshold: 2,
    halfOpenMs: 1000,
    resetOnSuccess: 3,
  });
  assert.equal(custom.failureThreshold, 2);
  assert.equal(custom.halfOpenMs, 1000);
  assert.equal(custom.resetOnSuccess, 3);
});

test('recordFailure opens after threshold', (t) => {
  withFakeNow(t);
  const breaker = new CircuitBreaker({ failureThreshold: 2 });

  breaker.recordFailure('first');
  assert.equal(breaker.isClosed(), true);
  assert.equal(breaker.isOpen(), false);

  breaker.recordFailure('second');
  assert.equal(breaker.isOpen(), true);
  assert.equal(breaker.getState().openReason, 'second');
});

test('isOpen/isHalfOpen/isClosed transitions', (t) => {
  const clock = withFakeNow(t);
  const breaker = new CircuitBreaker({ failureThreshold: 1, halfOpenMs: 500 });

  assert.equal(breaker.isClosed(), true);
  breaker.recordFailure('boom');
  assert.equal(breaker.isOpen(), true);
  assert.equal(breaker.isHalfOpen(), false);

  clock.advance(499);
  assert.equal(breaker.isOpen(), true);
  assert.equal(breaker.isHalfOpen(), false);

  clock.advance(1);
  assert.equal(breaker.isOpen(), false);
  assert.equal(breaker.isHalfOpen(), true);
  assert.equal(breaker.isClosed(), false);
});

test('recordSuccess in half-open closes when reset threshold reached', (t) => {
  const clock = withFakeNow(t);
  const breaker = new CircuitBreaker({ failureThreshold: 1, halfOpenMs: 100, resetOnSuccess: 1 });

  breaker.recordFailure('fail');
  clock.advance(100);
  assert.equal(breaker.isHalfOpen(), true);

  breaker.recordSuccess();
  assert.equal(breaker.isClosed(), true);
  assert.equal(breaker.getState().openReason, null);
});

test('recordFailure in half-open reopens', (t) => {
  const clock = withFakeNow(t);
  const breaker = new CircuitBreaker({ failureThreshold: 1, halfOpenMs: 100 });

  breaker.recordFailure('first');
  clock.advance(100);
  assert.equal(breaker.isHalfOpen(), true);

  breaker.recordFailure('probe failed');
  assert.equal(breaker.isOpen(), true);
  assert.equal(breaker.getState().openReason, 'probe failed');
});

test('reset() forces closed', (t) => {
  withFakeNow(t);
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  breaker.recordFailure('x');
  assert.equal(breaker.isOpen(), true);
  breaker.reset();
  assert.equal(breaker.isClosed(), true);
  assert.equal(breaker.getState().failureCount, 0);
});

test('getState() shape', (t) => {
  withFakeNow(t);
  const breaker = new CircuitBreaker({ failureThreshold: 1 });
  breaker.recordFailure('shape');
  const state = breaker.getState();

  assert.equal(typeof state.state, 'string');
  assert.equal(typeof state.failureCount, 'number');
  assert.equal(typeof state.successCount, 'number');
  assert.ok('lastFailureAt' in state);
  assert.ok('nextRetryAt' in state);
  assert.ok('openReason' in state);
});

test('getNextRetryAt() returns valid ISO when open', (t) => {
  withFakeNow(t, 1700000000000);
  const breaker = new CircuitBreaker({ failureThreshold: 1, halfOpenMs: 1200 });
  breaker.recordFailure('retry');
  const next = breaker.getNextRetryAt();
  assert.equal(typeof next, 'string');
  assert.equal(Number.isNaN(Date.parse(next)), false);
});
