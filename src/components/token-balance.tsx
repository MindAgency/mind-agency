'use client';

import { useState, useEffect } from 'react';
import { DollarSign } from 'lucide-react';

// ── v1.2: Token Balance Component (compact) ──────────────────
export function TokenBalance({ agent }: { agent: string }) {
  const [account, setAccount] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/economy/account?agent=${agent}`)
      .then(r => r.json()).then(d => setAccount(d.account)).catch(() => {});
  }, [agent]);

  if (!account) return null;

  return (
    <div className="flex items-center gap-1.5 px-2 py-1 bg-surface rounded-lg">
      <DollarSign size={11} className="text-muted-foreground" />
      <span className="text-[12px] font-bold text-foreground font-mono">{account.balance.toLocaleString()}</span>
      <span className="text-[9px] text-muted-foreground">tokens</span>
    </div>
  );
}

// ── v1.2: Token Balance Full (in config panel) ───────────────
export function TokenBalanceFull({ agent }: { agent: string }) {
  const [account, setAccount] = useState<any>(null);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    fetch(`/api/economy/account?agent=${agent}`)
      .then(r => r.json()).then(d => setAccount(d.account)).catch(() => {});
  }, [agent]);

  if (!account) return null;

  const recentTx = (account.transactions || []).slice(-5).reverse();

  return (
    <div className="space-y-2">
      <label className="text-[10px] text-muted-foreground block">💰 Token 账户</label>
      <div className="bg-canvas border border-border rounded-xl p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-[18px] font-bold text-foreground font-mono">{account.balance.toLocaleString()}</span>
          <span className="text-[10px] text-muted-foreground">tokens</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[10px]">
          <div className="bg-surface rounded-lg px-2 py-1.5">
            <p className="text-muted-foreground">累计收入</p>
            <p className="font-medium text-foreground font-mono">{account.earned.toLocaleString()}</p>
          </div>
          <div className="bg-surface rounded-lg px-2 py-1.5">
            <p className="text-muted-foreground">累计支出</p>
            <p className="font-medium text-foreground font-mono">{account.spent.toLocaleString()}</p>
          </div>
        </div>
        {recentTx.length > 0 && (
          <div className="mt-2 pt-2 border-t border-border">
            <button onClick={() => setShowHistory(!showHistory)} className="text-[10px] text-muted hover:text-foreground transition-colors">
              {showHistory ? '收起' : '最近交易'} ▾
            </button>
            {showHistory && (
              <div className="mt-1.5 space-y-1">
                {recentTx.map((tx: any, i: number) => (
                  <div key={i} className="flex items-center gap-1.5 text-[9px]">
                    <span className={`px-1 py-0.5 rounded font-medium ${
                      tx.type === 'deposit' || tx.type === 'reward' || tx.type === 'bonus' || tx.type === 'transfer_in'
                        ? 'bg-success-muted text-success' : 'bg-destructive-muted text-destructive'
                    }`}>{tx.type === 'deposit' ? '存入' : tx.type === 'reward' ? '奖励' : tx.type === 'bonus' ? '优质' : tx.type === 'transfer_in' ? '转入' : tx.type === 'transfer_out' ? '转出' : tx.type === 'withdraw' ? '扣费' : '处罚'}</span>
                    <span className="font-mono text-foreground">{tx.amount > 0 ? '+' : ''}{tx.amount}</span>
                    {tx.reason && <span className="text-muted-foreground truncate flex-1">{tx.reason}</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
