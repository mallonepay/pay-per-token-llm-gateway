'use client';

import { useState } from 'react';
import { Search, Wallet, Loader2, AlertCircle } from 'lucide-react';

interface EscrowBalance {
  address: string;
  balance: string;
  asset: string;
  contractId: string;
}

export default function EscrowPage() {
  const [address, setAddress] = useState('');
  const [balance, setBalance] = useState<EscrowBalance | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchBalance = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!address) return;

    setLoading(true);
    setError(null);
    setBalance(null);

    try {
      const res = await fetch(`/api/v1/escrow/${address}/balance`);
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to fetch balance');
      }
      const data = await res.json();
      setBalance(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Escrow</h1>
        <p className="text-muted-foreground mt-1">
          Check prepaid credit-escrow balances and usage history
        </p>
      </div>

      <div className="card">
        <form onSubmit={fetchBalance} className="flex gap-3">
          <div className="relative flex-1">
            <Wallet className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Enter Stellar address (G...)"
              className="w-full pl-10 pr-4 py-2 bg-gray-900 border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-green-500/50"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !address}
            className="inline-flex items-center gap-2 px-4 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {loading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            Check
          </button>
        </form>

        {error && (
          <div className="mt-4 flex items-start gap-2 text-red-400 text-sm">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <p>{error}</p>
          </div>
        )}

        {balance && (
          <div className="mt-6 space-y-4">
            <div className="flex items-center justify-between p-4 bg-gray-900/50 rounded-lg border border-border">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wider">Balance</p>
                <p className="text-2xl font-mono font-semibold mt-1">
                  {balance.balance}{' '}
                  <span className="text-sm text-muted-foreground">{balance.asset}</span>
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs text-muted-foreground uppercase tracking-wider">Contract</p>
              <p className="font-mono text-sm break-all">{balance.contractId}</p>
            </div>

            <div className="pt-4 border-t border-border">
              <p className="text-sm text-muted-foreground">
                Deposit USDC to the credit-escrow contract, then send requests with the{' '}
                <code className="px-1.5 py-0.5 bg-gray-900 rounded text-xs">
                  X-Escrow-User: {balance.address}
                </code>{' '}
                header to pay from your escrow balance.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
