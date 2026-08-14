/**
 * Circuit Breaker Tests
 *
 * Tests for the Circuit Breaker pattern that prevents cascade failures.
 * States: CLOSED (normal) -> OPEN (failing) -> HALF_OPEN (testing)
 * Source: src/lib/circuit-breaker.ts
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'path';

vi.mock('../src/lib/data-dir', () => ({
  MIND_DIR: path.join(__dirname, '.test-data', '.mind'),
  default: path.join(__dirname, '.test-data'),
}));

import { CircuitBreaker, CircuitState } from '../src/lib/circuit-breaker';

describe('Circuit Breaker', () => {
  // ──────────────────────────────────────────────
  // Initial state
  // ──────────────────────────────────────────────
  describe('Initial state', () => {
    it('should start in CLOSED state', () => {
      const cb = new CircuitBreaker();
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it('should have zero failures initially', () => {
      const cb = new CircuitBreaker();
      expect(cb.getFailures()).toBe(0);
    });

    it('should allow execution initially', () => {
      const cb = new CircuitBreaker();
      expect(cb.canExecute()).toBe(true);
    });

    it('should expose the CircuitState enum values', () => {
      expect(CircuitState.CLOSED).toBe('closed');
      expect(CircuitState.OPEN).toBe('open');
      expect(CircuitState.HALF_OPEN).toBe('half_open');
    });
  });

  // ──────────────────────────────────────────────
  // Failures below threshold
  // ──────────────────────────────────────────────
  describe('Failures below threshold', () => {
    it('should stay CLOSED when failures are below the threshold', () => {
      const cb = new CircuitBreaker(3);
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.getState()).toBe(CircuitState.CLOSED);
      expect(cb.getFailures()).toBe(2);
    });

    it('should still allow execution when below the threshold', () => {
      const cb = new CircuitBreaker(3);
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.canExecute()).toBe(true);
    });

    it('should track the exact failure count', () => {
      const cb = new CircuitBreaker(10);
      for (let i = 0; i < 5; i++) {
        cb.recordFailure();
      }
      expect(cb.getFailures()).toBe(5);
      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });
  });

  // ──────────────────────────────────────────────
  // Reaching threshold
  // ──────────────────────────────────────────────
  describe('Reaching threshold', () => {
    it('should open the circuit when the threshold is reached', () => {
      const cb = new CircuitBreaker(3);
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.getState()).toBe(CircuitState.OPEN);
      expect(cb.getFailures()).toBe(3);
    });

    it('should open the circuit exactly at the threshold', () => {
      const cb = new CircuitBreaker(5);
      for (let i = 0; i < 5; i++) {
        cb.recordFailure();
      }
      expect(cb.getState()).toBe(CircuitState.OPEN);
    });

    it('should open with a threshold of 1', () => {
      const cb = new CircuitBreaker(1);
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.OPEN);
    });
  });

  // ──────────────────────────────────────────────
  // canExecute when OPEN
  // ──────────────────────────────────────────────
  describe('canExecute when OPEN', () => {
    it('should return false when OPEN and cooldown has not elapsed', () => {
      const cb = new CircuitBreaker(2, 60000);
      cb.recordFailure();
      cb.recordFailure();

      expect(cb.getState()).toBe(CircuitState.OPEN);
      expect(cb.canExecute()).toBe(false);
    });

    it('should return true and transition to HALF_OPEN when cooldown has elapsed', () => {
      vi.useFakeTimers();
      try {
        const cb = new CircuitBreaker(2, 1000);
        cb.recordFailure();
        cb.recordFailure();

        expect(cb.getState()).toBe(CircuitState.OPEN);
        expect(cb.canExecute()).toBe(false);

        // Advance past the cooldown period
        vi.advanceTimersByTime(1001);

        expect(cb.canExecute()).toBe(true);
        expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not transition to HALF_OPEN before the cooldown expires', () => {
      vi.useFakeTimers();
      try {
        const cb = new CircuitBreaker(1, 5000);
        cb.recordFailure();

        vi.advanceTimersByTime(4999);
        expect(cb.canExecute()).toBe(false);
        expect(cb.getState()).toBe(CircuitState.OPEN);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ──────────────────────────────────────────────
  // recordSuccess
  // ──────────────────────────────────────────────
  describe('recordSuccess', () => {
    it('should reset to CLOSED on success', () => {
      const cb = new CircuitBreaker(3);
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.OPEN);

      cb.recordSuccess();
      expect(cb.getState()).toBe(CircuitState.CLOSED);
      expect(cb.getFailures()).toBe(0);
    });

    it('should allow execution after a reset', () => {
      const cb = new CircuitBreaker(2, 60000);
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.canExecute()).toBe(false);

      cb.recordSuccess();
      expect(cb.canExecute()).toBe(true);
    });

    it('should reset even from HALF_OPEN state', () => {
      vi.useFakeTimers();
      try {
        const cb = new CircuitBreaker(1, 1000);
        cb.recordFailure();

        vi.advanceTimersByTime(1001);
        cb.canExecute(); // transitions to HALF_OPEN
        expect(cb.getState()).toBe(CircuitState.HALF_OPEN);

        cb.recordSuccess();
        expect(cb.getState()).toBe(CircuitState.CLOSED);
        expect(cb.getFailures()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ──────────────────────────────────────────────
  // Custom threshold and cooldown
  // ──────────────────────────────────────────────
  describe('Custom threshold and cooldown', () => {
    it('should respect a custom threshold', () => {
      const cb = new CircuitBreaker(5, 60000);

      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.CLOSED); // 4 < 5

      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.OPEN); // 5 >= 5
    });

    it('should respect a custom cooldown duration', () => {
      vi.useFakeTimers();
      try {
        const cb = new CircuitBreaker(1, 5000);
        cb.recordFailure();
        expect(cb.getState()).toBe(CircuitState.OPEN);

        // Just under the cooldown
        vi.advanceTimersByTime(4999);
        expect(cb.canExecute()).toBe(false);

        // Just past the cooldown
        vi.advanceTimersByTime(2);
        expect(cb.canExecute()).toBe(true);
        expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should use default values when no arguments are provided', () => {
      const cb = new CircuitBreaker();

      // Default threshold is 3
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.CLOSED);

      cb.recordFailure();
      expect(cb.getState()).toBe(CircuitState.OPEN);
    });
  });

  // ──────────────────────────────────────────────
  // HALF_OPEN state
  // ──────────────────────────────────────────────
  describe('HALF_OPEN state', () => {
    it('should allow execution in HALF_OPEN state', () => {
      vi.useFakeTimers();
      try {
        const cb = new CircuitBreaker(1, 1000);
        cb.recordFailure();

        vi.advanceTimersByTime(1001);
        cb.canExecute(); // transitions to HALF_OPEN

        expect(cb.getState()).toBe(CircuitState.HALF_OPEN);
        // HALF_OPEN always returns true
        expect(cb.canExecute()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should transition back to CLOSED on success from HALF_OPEN', () => {
      vi.useFakeTimers();
      try {
        const cb = new CircuitBreaker(1, 1000);
        cb.recordFailure();

        vi.advanceTimersByTime(1001);
        cb.canExecute(); // HALF_OPEN

        cb.recordSuccess();
        expect(cb.getState()).toBe(CircuitState.CLOSED);
        expect(cb.getFailures()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should allow a full CLOSED -> OPEN -> HALF_OPEN -> CLOSED recovery cycle', () => {
      vi.useFakeTimers();
      try {
        const cb = new CircuitBreaker(2, 1000);

        // CLOSED -> OPEN
        cb.recordFailure();
        cb.recordFailure();
        expect(cb.getState()).toBe(CircuitState.OPEN);
        expect(cb.canExecute()).toBe(false);

        // OPEN -> HALF_OPEN
        vi.advanceTimersByTime(1001);
        expect(cb.canExecute()).toBe(true);
        expect(cb.getState()).toBe(CircuitState.HALF_OPEN);

        // HALF_OPEN -> CLOSED
        cb.recordSuccess();
        expect(cb.getState()).toBe(CircuitState.CLOSED);
        expect(cb.getFailures()).toBe(0);
        expect(cb.canExecute()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
