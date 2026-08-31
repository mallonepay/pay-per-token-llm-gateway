'use client';

import { useState } from 'react';
import {
  Wallet,
  Coins,
  History,
  Search,
  CheckCircle2,
  ExternalLink,
  Copy,
  Check,
  Loader2,
  ArrowUpRight,
  ShieldCheck,
} from 'lucide-react';
import { useEscrowBalance, useEscrowUsage } from '@/lib/hooks';
import { getWalletAddress } from '@/lib/api';

export default function EscrowPage() {
  const connectedAddress = getWalletAddress();
  const [searchAddress, setSearchAddress] = useState('');
  const [activeAddress, setActiveAddress] = useState(connectedAddress || '');
  const [copied, setCopied] = useState<string | null>(null);

  const targetAddress = activeAddress || connectedAddress || '';

  const {
    data: balanceData,
    isLoading: isBalanceLoading,
    isError: isBalanceError,
    error: balanceError,
  } = useEscrowBalance(targetAddress);

  const {
    data: usageData,
    isLoading: isUsageLoading,
    isError: isUsageError,
  } = useEscrowUsage(targetAddress);

  const copyToClipboard = (text: string) => {
    if (typeof navigator !== 'undefined') {
      navigator.clipboard.writeText(text);
    }
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  };

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchAddress.trim()) {
      setActiveAddress(searchAddress.trim());
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Credit Escrow</h1>
        <p className="text-muted-foreground mt-1">
          Prepaid on-chain USDC credit escrow balances and per-token usage deductions
        </p>
      </div>

      {/* Address Search / Selector */}
      <div className="card">
        <form onSubmit={handleSearch} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <input
              type="text"
              value={searchAddress}
              onChange={(e) => setSearchAddress(e.target.value)}
              placeholder="Search by Stellar address (e.g. GB4Y...)"
              className="w-full pl-9 pr-4 py-2 bg-gray-900 border border-border rounded-lg text-sm font-mono focus:outline-none focus:border-green-500 transition-colors"
            />
          </div>
          <button
            type="submit"
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition-colors shrink-0"
          >
            Check Balance
          </button>
          {connectedAddress && activeAddress !== connectedAddress && (
            <button
              type="button"
              onClick={() => {
                setActiveAddress(connectedAddress);
                setSearchAddress('');
              }}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-200 text-sm font-medium rounded-lg transition-colors shrink-0"
            >
              My Wallet
            </button>
          )}
        </form>
        {targetAddress && (
          <div className="flex items-center gap-2 mt-3 text-xs text-muted-foreground">
            <span>Viewing address:</span>
            <span className="font-mono text-gray-200">{targetAddress}</span>
            <button
              onClick={() => copyToClipboard(targetAddress)}
              className="hover:text-green-400 transition-colors"
            >
              {copied === targetAddress ? (
                <Check className="w-3 h-3 text-green-400" />
              ) : (
                <Copy className="w-3 h-3" />
              )}
            </button>
          </div>
        )}
      </div>

      {/* Balance & Info Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="card lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <span className="stat-label">Prepaid Escrow Balance</span>
            <div className="p-2 bg-green-900/20 rounded-lg">
              <Wallet className="w-5 h-5 text-green-400" />
            </div>
          </div>

          {!targetAddress ? (
            <div className="py-8 text-center text-muted-foreground text-sm">
              Enter a Stellar address or connect a wallet to view escrow balance.
            </div>
          ) : isBalanceLoading ? (
            <div className="flex items-center gap-3 py-6">
              <Loader2 className="w-6 h-6 text-green-400 animate-spin" />
              <span className="text-muted-foreground text-sm">Querying Soroban contract...</span>
            </div>
          ) : isBalanceError ? (
            <div className="py-6">
              <p className="text-red-400 text-sm">
                Failed to load balance: {(balanceError as Error).message}
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <div>
                <div className="stat-value text-green-400">
                  {balanceData?.balanceUsdc || '0.0000000'} USDC
                </div>
                <div className="text-xs font-mono text-muted-foreground mt-1">
                  {balanceData?.balance || '0'} stroops
                </div>
              </div>

              <div className="pt-4 border-t border-border flex flex-wrap items-center gap-4 text-xs">
                <div className="flex items-center gap-1.5 text-green-400">
                  <ShieldCheck className="w-4 h-4" />
                  <span>Soroban Smart Contract Escrow</span>
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground">
                  <CheckCircle2 className="w-4 h-4 text-blue-400" />
                  <span>Bypasses per-request Horizon payments when balance &gt; 0</span>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="card space-y-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <Coins className="w-5 h-5 text-yellow-400" />
            How Escrow Works
          </h2>
          <ul className="text-xs text-muted-foreground space-y-2.5 leading-relaxed">
            <li className="flex items-start gap-2">
              <span className="text-green-400 font-bold">1.</span>
              <span>Deposit USDC once to the Soroban credit-escrow contract.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400 font-bold">2.</span>
              <span>Send LLM requests with your wallet address header.</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="text-green-400 font-bold">3.</span>
              <span>
                The gateway automatically deducts exact token usage on-chain without 402 delays.
              </span>
            </li>
          </ul>
        </div>
      </div>

      {/* Escrow Usage History */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold flex items-center gap-2">
            <History className="w-5 h-5 text-blue-400" />
            Escrow Usage History
          </h2>
          {usageData && usageData.total > 0 && (
            <span className="text-xs text-muted-foreground">
              {usageData.total} charge event{usageData.total === 1 ? '' : 's'}
            </span>
          )}
        </div>

        {!targetAddress ? (
          <p className="text-muted-foreground text-sm py-8 text-center">
            Enter an address above to view usage history.
          </p>
        ) : isUsageLoading ? (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Loader2 className="w-8 h-8 text-green-400 animate-spin" />
            <p className="text-sm text-muted-foreground">Loading usage events from contract...</p>
          </div>
        ) : isUsageError ? (
          <p className="text-red-400 text-sm py-8 text-center">Failed to load usage history</p>
        ) : !usageData?.usage?.length ? (
          <p className="text-muted-foreground text-sm py-8 text-center">
            No escrow usage events recorded for this address yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                    Quote ID
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                    Deducted Cost
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                    Stroops
                  </th>
                  <th className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider py-3 px-4">
                    Timestamp
                  </th>
                </tr>
              </thead>
              <tbody>
                {usageData.usage.map((item, i) => (
                  <tr
                    key={i}
                    className="border-b border-border last:border-0 hover:bg-gray-800/30 transition-colors"
                  >
                    <td className="py-3 px-4 font-mono text-sm">
                      <div className="flex items-center gap-2">
                        <span>{item.quoteId || '—'}</span>
                        {item.quoteId && (
                          <button
                            onClick={() => copyToClipboard(item.quoteId)}
                            className="hover:text-green-400 transition-colors"
                          >
                            {copied === item.quoteId ? (
                              <Check className="w-3 h-3 text-green-400" />
                            ) : (
                              <Copy className="w-3 h-3" />
                            )}
                          </button>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-sm font-mono font-medium text-green-400">
                      {item.amountUsdc || '0.0000000'} USDC
                    </td>
                    <td className="py-3 px-4 text-sm font-mono text-muted-foreground">
                      {item.amount}
                    </td>
                    <td className="py-3 px-4 text-sm text-muted-foreground">
                      {item.timestamp ? new Date(item.timestamp * 1000).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
