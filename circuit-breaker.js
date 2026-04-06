/**
 * @typedef {Object} CircuitState
 * @property {'closed'|'open'|'half-open'} state
 * @property {number} failureThreshold
 * @property {number} halfOpenMs
 * @property {number} resetOnSuccess
 * @property {number} failureCount
 * @property {number} successCount
 * @property {string|null} lastFailureAt
 * @property {string|null} openedAt
 * @property {string|null} openReason
 * @property {string|null} nextRetryAt
 */

/**
 * Runtime description for the CircuitState shape.
 */
export const CircuitStateDescription = {
  state: 'closed|open|half-open',
  failureThreshold: 'number',
  halfOpenMs: 'number',
  resetOnSuccess: 'number',
  failureCount: 'number',
  successCount: 'number',
  lastFailureAt: 'ISO timestamp | null',
  openedAt: 'ISO timestamp | null',
  openReason: 'string | null',
  nextRetryAt: 'ISO timestamp | null',
};

function safeInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = safeInt(
      options.failureThreshold,
      safeInt(process.env.CIRCUIT_FAILURE_THRESHOLD, 5),
    );
    this.halfOpenMs = safeInt(
      options.halfOpenMs,
      safeInt(process.env.CIRCUIT_HALF_OPEN_MS, 30000),
    );
    this.resetOnSuccess = safeInt(
      options.resetOnSuccess,
      safeInt(process.env.CIRCUIT_RESET_ON_SUCCESS, 1),
    );

    // Cross-activation failure tracking — survives across activate() calls
    // on the same kernel instance. Prevents runaway retry loops.
    this.totalActivationFailures = 0;
    this.maxActivationFailures = safeInt(
      options.maxActivationFailures,
      safeInt(process.env.CIRCUIT_MAX_ACTIVATION_FAILURES, 10),
    );
    this.permanentlyOpen = false;
    this.permanentOpenReason = null;

    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureAt = null;
    this.openedAt = null;
    this.openReason = null;
  }

  _toIso(ts) {
    if (!Number.isFinite(ts) || ts <= 0) return null;
    try {
      return new Date(ts).toISOString();
    } catch {
      return null;
    }
  }

  _refreshState(now = Date.now()) {
    if (this.state !== 'open') return;
    if (!Number.isFinite(this.openedAt)) return;
    if ((now - this.openedAt) >= this.halfOpenMs) {
      this.state = 'half-open';
      this.failureCount = 0;
      this.successCount = 0;
    }
  }

  /**
   * Record a failed activation (cross-activation tracking).
   * Call this when an entire activate() call ends in failure/no-progress.
   * If totalActivationFailures exceeds the threshold, the breaker locks permanently.
   */
  recordActivationFailure(reason) {
    this.totalActivationFailures++;
    if (this.totalActivationFailures >= this.maxActivationFailures) {
      this.permanentlyOpen = true;
      this.permanentOpenReason = `Activation failure limit reached (${this.totalActivationFailures}/${this.maxActivationFailures}): ${reason ?? 'unknown'}`;
      this.state = 'open';
      this.openedAt = Date.now();
      this.openReason = this.permanentOpenReason;
    }
  }

  /**
   * Record a successful activation (cross-activation tracking).
   * Resets the cross-activation failure counter.
   */
  recordActivationSuccess() {
    this.totalActivationFailures = 0;
  }

  isPermanentlyOpen() {
    return this.permanentlyOpen === true;
  }

  getState() {
    this._refreshState();
    return {
      state: this.permanentlyOpen ? 'permanently_open' : this.state,
      failureThreshold: this.failureThreshold,
      halfOpenMs: this.halfOpenMs,
      resetOnSuccess: this.resetOnSuccess,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalActivationFailures: this.totalActivationFailures,
      maxActivationFailures: this.maxActivationFailures,
      permanentlyOpen: this.permanentlyOpen,
      permanentOpenReason: this.permanentOpenReason ?? null,
      lastFailureAt: this._toIso(this.lastFailureAt),
      openedAt: this._toIso(this.openedAt),
      openReason: this.openReason ?? null,
      nextRetryAt: this.getNextRetryAt(),
    };
  }

  recordSuccess() {
    this._refreshState();
    if (this.state === 'half-open') {
      this.successCount += 1;
      if (this.successCount >= this.resetOnSuccess) {
        this.reset();
      }
      return;
    }
    this.failureCount = 0;
    this.successCount = 0;
  }

  recordFailure(reason) {
    this._refreshState();
    const now = Date.now();
    this.lastFailureAt = now;
    this.openReason = reason ? String(reason) : 'Unknown failure';

    if (this.state === 'half-open') {
      this.state = 'open';
      this.openedAt = now;
      this.failureCount = this.failureThreshold;
      this.successCount = 0;
      return;
    }

    this.failureCount += 1;
    this.successCount = 0;
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'open';
      this.openedAt = now;
    }
  }

  isOpen() {
    if (this.permanentlyOpen) return true;
    this._refreshState();
    return this.state === 'open';
  }

  isHalfOpen() {
    if (this.permanentlyOpen) return false;
    this._refreshState();
    return this.state === 'half-open';
  }

  isClosed() {
    if (this.permanentlyOpen) return false;
    this._refreshState();
    return this.state === 'closed';
  }

  reset() {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureAt = null;
    this.openedAt = null;
    this.openReason = null;
    // Note: does NOT reset cross-activation counters or permanent state.
    // Call fullReset() to clear everything including permanent lockout.
  }

  fullReset() {
    this.reset();
    this.totalActivationFailures = 0;
    this.permanentlyOpen = false;
    this.permanentOpenReason = null;
  }

  getNextRetryAt() {
    this._refreshState();
    if (this.state !== 'open' || !Number.isFinite(this.openedAt)) return null;
    return this._toIso(this.openedAt + this.halfOpenMs);
  }
}
