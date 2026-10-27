import React, { useState } from 'react';

export function RiskAdvisor() {
  const [balance, setBalance] = useState<number>(250);
  const stake = (balance * 0.02).toFixed(2);
  const maxSafeStake = (balance * 0.05).toFixed(2);

  return (
    <div data-tour="risk-advisor" className="bg-slate-900 border border-slate-800 rounded-2xl p-4 shadow-xl space-y-4 font-mono">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <div>
            <h4 className="text-xs font-bold text-white uppercase tracking-wider">Capital Risk & Stake Advisor</h4>
            <span className="text-[10px] text-slate-400">Strict 2% Capital Preservation Guard</span>
          </div>
        </div>
        <span className="text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 px-2 py-0.5 rounded-full font-bold">
          Active Guard
        </span>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {/* Capital Balance Input */}
        <div className="space-y-1">
          <label htmlFor="capital-balance-input" className="text-[10px] text-slate-400 uppercase tracking-wider block">
            Account Balance ($)
          </label>
          <div className="relative">
            <span className="absolute left-3 top-2.5 text-slate-500 font-bold">$</span>
            <input
              type="number"
              id="capital-balance-input"
              value={balance}
              min="10"
              max="100000"
              onChange={(e) => setBalance(Math.max(1, parseFloat(e.target.value) || 0))}
              className="w-full bg-slate-950 border border-slate-800 rounded-xl py-2 pl-7 pr-3 text-sm text-white font-mono focus:border-emerald-500 focus:outline-none"
            />
          </div>
        </div>

        {/* 2% Recommended Stake */}
        <div className="bg-slate-950 border border-emerald-500/30 rounded-xl p-3 text-center">
          <span className="text-[10px] text-emerald-400 uppercase tracking-wider block">2% Max Stake</span>
          <span className="text-xl font-black text-emerald-300 font-mono mt-0.5 block">${stake}</span>
          <span className="text-[9px] text-slate-500">Mathematically Optimal</span>
        </div>

        {/* 5% Ceiling */}
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-3 text-center">
          <span className="text-[10px] text-slate-400 uppercase tracking-wider block">5% Absolute Limit</span>
          <span className="text-xl font-black text-amber-400 font-mono mt-0.5 block">${maxSafeStake}</span>
          <span className="text-[9px] text-slate-500">Do Not Exceed</span>
        </div>
      </div>

      {/* Broker Launch Links */}
      <div className="pt-2 border-t border-slate-800/80 space-y-2">
        <div className="text-[11px] text-slate-400 flex items-center justify-between">
          <span>Broker Instant Execution</span>
          <span className="text-[10px] text-slate-500">External Execution Cockpits</span>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <a
            href="https://expertoption.com"
            target="_blank"
            rel="noopener noreferrer"
            id="broker-link-expertoption"
            className="flex items-center justify-center gap-2 py-2 px-3 bg-slate-950 hover:bg-slate-800 border border-slate-700/80 rounded-xl text-xs font-bold text-slate-200 transition"
          >
            <span>ExpertOption</span>
            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
          <a
            href="https://deriv.com"
            target="_blank"
            rel="noopener noreferrer"
            id="broker-link-deriv"
            className="flex items-center justify-center gap-2 py-2 px-3 bg-slate-950 hover:bg-slate-800 border border-slate-700/80 rounded-xl text-xs font-bold text-slate-200 transition"
          >
            <span>Deriv Trader</span>
            <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        </div>
      </div>
    </div>
  );
}
