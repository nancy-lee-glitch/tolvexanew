import React, { useState, useEffect } from 'react';

export function MarketRadar() {
  const [utcTime, setUtcTime] = useState('');
  const [status, setStatus] = useState<{
    color: string;
    dotColor: string;
    text: string;
    borderColor: string;
    textColor: string;
  }>({
    color: 'bg-emerald-950/80',
    dotColor: 'bg-emerald-400',
    text: 'OPTIMAL SESSION: Safe to Trade (Peak Volume)',
    borderColor: 'border-emerald-500/40',
    textColor: 'text-emerald-300',
  });

  useEffect(() => {
    const update = () => {
      const now = new Date();
      const h = now.getUTCHours();
      const m = String(now.getUTCMinutes()).padStart(2, '0');
      const s = String(now.getUTCSeconds()).padStart(2, '0');
      setUtcTime(`${String(h).padStart(2, '0')}:${m}:${s} UTC`);

      if (h >= 12 && h < 16) {
        setStatus({
          color: 'bg-slate-900/90',
          dotColor: 'bg-emerald-400 animate-pulse',
          text: 'OPTIMAL SESSION: Safe to Trade (Peak Volume)',
          borderColor: 'border-emerald-500/40',
          textColor: 'text-emerald-300',
        });
      } else if ((h >= 21 && h <= 23) || (h >= 0 && h < 1)) {
        setStatus({
          color: 'bg-slate-900/90',
          dotColor: 'bg-rose-400 animate-pulse',
          text: 'HIGH RISK: Low Liquidity Session (Caution)',
          borderColor: 'border-rose-500/40',
          textColor: 'text-rose-300',
        });
      } else {
        setStatus({
          color: 'bg-slate-900/90',
          dotColor: 'bg-amber-400',
          text: 'NORMAL: Trade with Caution',
          borderColor: 'border-amber-500/40',
          textColor: 'text-amber-300',
        });
      }
    };

    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <aside id="floating-market-radar" className="sticky top-2 z-30 flex justify-center px-2 pointer-events-none mb-1 w-full max-w-full">
      <div
        className={`pointer-events-auto max-w-[calc(100vw-16px)] shadow-2xl backdrop-blur-md px-2.5 sm:px-3.5 py-1 sm:py-1.5 rounded-full border ${status.borderColor} ${status.color} text-xs font-mono font-medium flex items-center justify-between gap-1.5 sm:gap-2 transition-all duration-300`}
      >
        <div className="flex items-center gap-1.5 min-w-0 truncate">
          <span className={`w-2 h-2 rounded-full shrink-0 ${status.dotColor}`} />
          <span className={`${status.textColor} font-semibold text-[10px] sm:text-xs truncate`}>{status.text}</span>
        </div>
        <span className="text-[9px] sm:text-[10px] text-slate-400 bg-slate-800/90 px-1.5 py-0.5 rounded font-bold border border-slate-700/60 shrink-0">
          {utcTime || '00:00:00 UTC'}
        </span>
      </div>
    </aside>
  );
}
