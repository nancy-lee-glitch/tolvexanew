import React from 'react';
import {
  CONDITIONS_DISCLAIMER_TEXT,
  type ConditionsAssessment,
} from '../utils/conditions.ts';

export interface ConditionsBannerProps {
  assessment: ConditionsAssessment;
  isExpanded: boolean;
  onToggleExpand: () => void;
  assetName?: string;
}

export function ConditionsBanner({
  assessment,
  isExpanded,
  onToggleExpand,
  assetName,
}: ConditionsBannerProps) {
  const { level, reasons, nextBetterWindowText } = assessment;

  const palette =
    level === 'NOT_ADVISED'
      ? {
          wrap: 'bg-rose-950/60 border-rose-500/60 text-rose-100',
          dot: 'bg-rose-500',
          title: 'text-rose-200',
          badge: 'bg-rose-500/20 text-rose-200 border-rose-500/40',
          bullet: 'text-rose-400',
          windowText: 'text-amber-200',
        }
      : level === 'CAUTION'
      ? {
          wrap: 'bg-amber-950/50 border-amber-500/50 text-amber-100',
          dot: 'bg-amber-400',
          title: 'text-amber-200',
          badge: 'bg-amber-500/20 text-amber-200 border-amber-500/40',
          bullet: 'text-amber-400',
          windowText: 'text-amber-200',
        }
      : {
          wrap: 'bg-emerald-950/40 border-emerald-500/40 text-emerald-100',
          dot: 'bg-emerald-400',
          title: 'text-emerald-200',
          badge: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
          bullet: 'text-emerald-400',
          windowText: 'text-emerald-200',
        };

  const headline =
    level === 'NOT_ADVISED'
      ? 'NOT ADVISED RIGHT NOW'
      : level === 'CAUTION'
      ? 'CAUTION'
      : 'Conditions look normal';

  return (
    <section
      id="cockpit-conditions-banner"
      data-testid="conditions-banner"
      data-condition-level={level}
      className={`w-full rounded-2xl border p-3.5 shadow-xl space-y-2 transition-colors ${palette.wrap}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${palette.dot}`} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className={`text-xs sm:text-sm font-black font-mono tracking-wide uppercase ${palette.title}`}>
                {headline}
              </h2>
              {assetName && (
                <span className={`text-[10px] font-mono px-2 py-0.5 rounded border ${palette.badge}`}>
                  {assetName}
                </span>
              )}
            </div>
          </div>
        </div>

        {reasons.length > 0 && (
          <button
            type="button"
            onClick={onToggleExpand}
            aria-expanded={isExpanded}
            className="text-[11px] font-mono font-bold px-2 py-1 rounded-lg bg-slate-950/50 hover:bg-slate-900/80 border border-slate-700/60 text-slate-200 shrink-0 cursor-pointer transition"
          >
            {isExpanded ? 'Hide reasons' : `Show reasons (${reasons.length})`}
          </button>
        )}
      </div>

      {isExpanded && reasons.length > 0 && (
        <ul data-testid="conditions-reasons-list" className="space-y-1 text-xs leading-snug pl-1">
          {reasons.map((reason) => (
            <li key={reason.code} className="flex items-start gap-2">
              <span className={`font-bold shrink-0 ${palette.bullet}`}>&bull;</span>
              <span>{reason.text}</span>
            </li>
          ))}
        </ul>
      )}

      {nextBetterWindowText && (
        <p data-testid="conditions-next-window" className={`text-xs font-mono font-semibold ${palette.windowText}`}>
          Next better window: {nextBetterWindowText}
        </p>
      )}

      <p className="text-[11px] text-slate-300/85 leading-snug">
        {CONDITIONS_DISCLAIMER_TEXT}
      </p>
    </section>
  );
}
