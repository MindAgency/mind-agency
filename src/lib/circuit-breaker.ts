/**
 * Circuit Breaker pattern for preventing cascade failures.
 *
 * States: CLOSED (normal) -> OPEN (failing) -> HALF_OPEN (testing)
 *
 * When an agent fails N times consecutively, the circuit opens
 * and stops sending requests for a cooldown period.
 */

export enum CircuitState { CLOSED = 'closed', OPEN = 'open', HALF_OPEN = 'half_open' }

export class CircuitBreaker {
  private failures = 0;
  private state: CircuitState = CircuitState.CLOSED;
  private lastFailureTime = 0;
  private readonly threshold: number;
  private readonly cooldownMs: number;

  constructor(threshold: number = 3, cooldownMs: number = 60000) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  /** Record a failure. Opens circuit if threshold reached. */
  recordFailure() {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= this.threshold) {
      this.state = CircuitState.OPEN;
    }
  }

  /** Record a success. Resets circuit. */
  recordSuccess() {
    this.failures = 0;
    this.state = CircuitState.CLOSED;
  }

  /** Check if requests are allowed. */
  canExecute(): boolean {
    if (this.state === CircuitState.CLOSED) return true;
    if (this.state === CircuitState.OPEN) {
      if (Date.now() - this.lastFailureTime > this.cooldownMs) {
        this.state = CircuitState.HALF_OPEN;
        return true;
      }
      return false;
    }
    return true; // HALF_OPEN allows one request
  }

  getState(): CircuitState { return this.state; }
  getFailures(): number { return this.failures; }
}
