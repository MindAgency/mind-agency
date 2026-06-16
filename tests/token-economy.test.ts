/**
 * Token Economy Tests
 */

import { describe, it, expect, vi } from 'vitest';
import path from 'path';

vi.mock('../src/lib/data-dir', () => ({
  MIND_DIR: path.join(__dirname, '.test-data', '.mind'),
  default: path.join(__dirname, '.test-data'),
}));

import {
  getAgentAccount,
  getBalance,
  deposit,
  transfer,
  reward,
  withdraw,
  penalize,
} from '../src/lib/token-economy';

describe('Token Economy', () => {
  const testAgent = `test-economy-${Date.now()}`;

  it('should get agent account', () => {
    const account = getAgentAccount(testAgent);
    expect(account).toHaveProperty('agent');
    expect(account).toHaveProperty('balance');
    expect(account).toHaveProperty('earned');
    expect(account).toHaveProperty('spent');
    expect(account).toHaveProperty('transactions');
  });

  it('should deposit tokens', async () => {
    const balance = await deposit(testAgent, 100, 'test deposit');
    expect(balance).toBeGreaterThanOrEqual(100);
  });

  it('should get balance', async () => {
    await deposit(testAgent, 50, 'test');
    const balance = getBalance(testAgent);
    expect(balance).toBeGreaterThanOrEqual(50);
  });

  it('should transfer tokens', async () => {
    const fromAgent = `test-from-${Date.now()}`;
    const toAgent = `test-to-${Date.now()}`;

    await deposit(fromAgent, 100, 'setup');
    const result = await transfer(fromAgent, toAgent, 30, 'test transfer');

    expect(result).toBe(true);
    expect(getBalance(toAgent)).toBeGreaterThanOrEqual(30);
  });

  it('should reject transfer with insufficient balance', async () => {
    const fromAgent = `test-poor-${Date.now()}`;
    const toAgent = `test-rich-${Date.now()}`;

    const result = await transfer(fromAgent, toAgent, 1000, 'test');
    expect(result).toBe(false);
  });

  it('should reward tokens', async () => {
    const account = await reward(testAgent, 50, 'test-task', 'normal');
    expect(account.balance).toBeGreaterThanOrEqual(50);
  });

  it('should withdraw tokens', async () => {
    await deposit(testAgent, 100, 'setup');
    const account = await withdraw(testAgent, 30, 'test penalty');
    expect(account.spent).toBeGreaterThanOrEqual(30);
  });

  it('should penalize tokens', async () => {
    await deposit(testAgent, 100, 'setup');
    const account = await penalize(testAgent, 20, 'test');
    expect(account.spent).toBeGreaterThanOrEqual(20);
  });
});
