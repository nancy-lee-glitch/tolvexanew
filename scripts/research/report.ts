/**
 * scripts/research/report.ts — Generates Markdown & CSV Reports for Stage R1 Research
 */

import { BONFERRONI_ALPHA, MIN_VALIDATION_TRADES, NUM_HYPOTHESES, computeHypothesisBlockStats, evaluateSurvival, type HypothesisBlockStats, type SurvivalEvaluation } from './stats.ts';
import { PRE_REGISTERED_HYPOTHESES, type HypothesisId } from './hypotheses.ts';
import type { ResearchSimulationOutput, ResearchTradeRecord } from './simulator.ts';

export interface HypothesisSummaryRow {
  id: HypothesisId;
  shortName: string;
  description: string;
  learning: HypothesisBlockStats;
  validation: HypothesisBlockStats;
  survival: SurvivalEvaluation;
}

function fmtR(val: number | null): string {
  if (val === null || !Number.isFinite(val)) return 'N/A';
  const sign = val > 0 ? '+' : '';
  return `${sign}${val.toFixed(4)}R`;
}

function fmtCi(st: HypothesisBlockStats): string {
  if (st.ci95LowR === null || st.ci95HighR === null) return 'N/A';
  return `[${fmtR(st.ci95LowR)}, ${fmtR(st.ci95HighR)}]`;
}

function fmtP(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return 'N/A';
  if (p < 0.0001) return '< 0.0001';
  return p.toFixed(4);
}

function fmtDateOnly(iso: string): string {
  return iso.slice(0, 10);
}

export function buildResearchSummaries(sim: ResearchSimulationOutput): HypothesisSummaryRow[] {
  return PRE_REGISTERED_HYPOTHESES.map((hyp) => {
    const trades = sim.tradesByHypothesis[hyp.id] || [];
    const learnR = trades.filter((t) => t.block === 'learning').map((t) => t.netR);
    const valR = trades.filter((t) => t.block === 'validation').map((t) => t.netR);

    const learning = computeHypothesisBlockStats(learnR, NUM_HYPOTHESES);
    const validation = computeHypothesisBlockStats(valR, NUM_HYPOTHESES);
    const survival = evaluateSurvival({
      learning,
      validation,
      minValidationTrades: MIN_VALIDATION_TRADES,
      numHypotheses: NUM_HYPOTHESES,
    });

    return {
      id: hyp.id,
      shortName: hyp.shortName,
      description: hyp.description,
      learning,
      validation,
      survival,
    };
  });
}

export function buildResearchMarkdownReport(params: {
  generatedAtIso: string;
  sim: ResearchSimulationOutput;
  summaries: HypothesisSummaryRow[];
}): string {
  const { generatedAtIso, sim, summaries } = params;
  const { timeSplit, lockedForwardBlock, symbolsIncluded, h8SelectedRules } = sim;

  const survivors = summaries.filter((s) => s.survival.verdict === 'SURVIVES');
  const lines: string[] = [];

  lines.push('# Stage R1 Pre-Registered Strategy Research Report');
  lines.push('');
  lines.push(`Generated: ${generatedAtIso}`);
  lines.push(
    `Dataset span: ${fmtDateOnly(timeSplit.globalStartIso)} to ${fmtDateOnly(lockedForwardBlock.endIso)} (~${Math.round(timeSplit.totalDays)} calendar days — note: the data covers only about one year).`
  );
  lines.push(
    `Universe (${symbolsIncluded.length} non-synthetic symbols): ${symbolsIncluded.join(', ')}`
  );
  lines.push('');

  lines.push('## Plain-English Summary');
  lines.push('');
  lines.push(
    `**${survivors.length} of ${NUM_HYPOTHESES} hypotheses survived** pre-registered out-of-sample testing after spread costs and Bonferroni multiple-testing correction.`
  );
  lines.push('');
  if (survivors.length > 0) {
    lines.push(
      `Surviving hypothesis/hypotheses: ${survivors
        .map(
          (s) =>
            `${s.id} (${s.shortName}: n=${s.validation.trades}, avg=${fmtR(s.validation.avgR)}, 95% CI=${fmtCi(s.validation)}, p=${fmtP(s.validation.pValueOneSided)})`
        )
        .join('; ')}.`
    );
  } else {
    lines.push(
      'None of the 8 pre-registered hypotheses cleared all survival gates (at least 100 validation trades, positive validation average R after spread costs, 95% CI strictly above 0, Bonferroni-corrected p < 0.00625, and non-negative learning average R).'
    );
  }
  lines.push('');
  lines.push('These results are historical and do not predict future performance.');
  lines.push('');
  lines.push(
    `- **Data length note**: The cached dataset covers only about one year (~${Math.round(timeSplit.totalDays)} days total). Because 20% is locked for future paper trading and 50% is used for learning, the validation window spans ~${Math.round(timeSplit.validationDays)} days. On ~${Math.round(timeSplit.validationDays)} days of data, smaller positive edges can fail to reach statistical power.`
  );
  lines.push(
    `- **Time split**: Learning (50%) = ${fmtDateOnly(timeSplit.globalStartIso)} to ${fmtDateOnly(timeSplit.learningEndIso)} (~${Math.round(timeSplit.learningDays)}d) | Validation (30%) = ${fmtDateOnly(timeSplit.learningEndIso)} to ${fmtDateOnly(timeSplit.validationEndIso)} (~${Math.round(timeSplit.validationDays)}d) | **LOCKED Forward Block (20%)** = ${fmtDateOnly(lockedForwardBlock.startIso)} to ${fmtDateOnly(lockedForwardBlock.endIso)} (~${Math.round(timeSplit.lockedForwardDays)}d, **UNREAD / 0 trades evaluated**).`
  );
  lines.push(
    `- **Survival rule**: Must pass ALL five checks: (1) validation trades >= ${MIN_VALIDATION_TRADES}, (2) validation avg R > 0 after spread costs, (3) 95% CI excludes 0, (4) one-sided p-value < ${BONFERRONI_ALPHA.toFixed(5)} (0.05 / ${NUM_HYPOTHESES} Bonferroni), (5) learning avg R >= 0.`
  );
  lines.push('');

  lines.push('## 1. Pre-Registered Hypotheses (Fixed Before Testing)');
  lines.push('');
  for (const h of PRE_REGISTERED_HYPOTHESES) {
    lines.push(`- **${h.id} — ${h.shortName}**: ${h.description} (${h.maxHoldNote}; fixed params: \`${JSON.stringify(h.parameters)}\`)`);
  }
  lines.push('');

  lines.push('## 2. Validation Block Results (30% Out-of-Sample, After Spread Costs)');
  lines.push('');
  lines.push(
    '| ID | Strategy | Trades | Win Rate | Avg R | Total R | Max DD (R) | 95% CI (Avg R) | p-value (Avg R > 0) | Bonf. Pass (<0.00625) | Min Detectable Avg R (80% Power) | Verdict |'
  );
  lines.push('|---|---|---:|---:|---:|---:|---:|---|---:|:---:|---:|---|');

  for (const row of summaries) {
    const v = row.validation;
    const powerStr =
      v.minDetectableAvgR80Bonf !== null
        ? `+${v.minDetectableAvgR80Bonf.toFixed(4)}R (uncorr: +${(v.minDetectableAvgR80Uncorr ?? 0).toFixed(4)}R)`
        : 'N/A (n < 2)';
    lines.push(
      `| ${row.id} | ${row.shortName} | ${v.trades} | ${v.winRatePct.toFixed(2)}% | ${fmtR(v.avgR)} | ${fmtR(v.totalR)} | ${v.maxDrawdownR.toFixed(2)}R | ${fmtCi(v)} | ${fmtP(v.pValueOneSided)} | ${v.passesBonferroni ? 'YES' : 'NO'} | ${powerStr} | **${row.survival.verdict}** |`
    );
  }
  lines.push('');

  lines.push('## 3. Learning Block (50%) vs Validation Block (30%) & Survival Decisions');
  lines.push('');
  lines.push(
    '| ID | Learning Trades | Learning Win Rate | Learning Avg R | Learning Total R | Learning Max DD | Validation Verdict & Reason |'
  );
  lines.push('|---|---:|---:|---:|---:|---:|---|');
  for (const row of summaries) {
    const l = row.learning;
    const verdictDetail =
      row.survival.verdict === 'SURVIVES'
        ? '**SURVIVES** — cleared all 5 pre-registered criteria'
        : `**DOES NOT SURVIVE** — ${row.survival.failureReasons.join('; ')}`;
    lines.push(
      `| ${row.id} | ${l.trades} | ${l.winRatePct.toFixed(2)}% | ${fmtR(l.avgR)} | ${fmtR(l.totalR)} | ${l.maxDrawdownR.toFixed(2)}R | ${verdictDetail} |`
    );
  }
  lines.push('');

  lines.push('## 4. Statistical Power Summary (One-Year Sample Limitations)');
  lines.push('');
  lines.push(
    `At Bonferroni-corrected one-sided alpha = ${BONFERRONI_ALPHA.toFixed(5)} and 80% statistical power, the smallest average R per trade each validation sample can reliably detect (Minimum Detectable Effect Size) is:`
  );
  lines.push('');
  for (const row of summaries) {
    const v = row.validation;
    if (v.minDetectableAvgR80Bonf !== null && v.sdR !== null) {
      lines.push(
        `- **${row.id}** (n=${v.trades}, SD=${v.sdR.toFixed(3)}R): smallest detectable avg R = **+${v.minDetectableAvgR80Bonf.toFixed(4)}R** per trade (single-test 5% power threshold: +${(v.minDetectableAvgR80Uncorr ?? 0).toFixed(4)}R).`
      );
    } else {
      lines.push(`- **${row.id}** (n=${v.trades}): insufficient sample size (n < 2) to compute statistical power.`);
    }
  }
  lines.push('');

  lines.push('## 5. H8 Learning Selection Log (Hour-of-Day Drift)');
  lines.push('');
  if (h8SelectedRules.length === 0) {
    lines.push('- Zero `(symbol, UTC hour)` pairs met `|t| >= 2.0` (with n >= 20) in the learning block.');
  } else {
    lines.push(
      `- ${h8SelectedRules.length} \`(symbol, UTC hour)\` pairs met \`|t| >= 2.0\` in the 50% learning block and were carried frozen into the 30% validation block:`
    );
    for (const rule of h8SelectedRules.slice(0, 30)) {
      lines.push(
        `  - ${rule.symbol} @ ${String(rule.utcHour).padStart(2, '0')}:00 UTC -> ${rule.direction} (learning n=${rule.learningCount}, t=${rule.learningTStat.toFixed(2)})`
      );
    }
    if (h8SelectedRules.length > 30) {
      lines.push(`  - ...and ${h8SelectedRules.length - 30} additional symbol-hour pairs.`);
    }
  }
  lines.push('');

  lines.push('## Ideas for a future pre-registered round');
  lines.push('');
  lines.push(
    '- Collect a multi-year intraday dataset (3–5+ years) before re-testing slow daily trend systems like H7 (55-day Donchian) so validation has >= 100 completed trades.'
  );
  lines.push(
    '- Test a time-stop / trailing-stop variant of H1 (EMA trend pullback) capped at H4 swing structure rather than fixed 2R.'
  );
  lines.push(
    '- Pre-register a London-open range expansion hypothesis (07:00–10:00 UTC) with fixed Asian-range ATR ratio bounds.'
  );
  lines.push(
    '- Test cross-sectional FX currency strength ranking on D1/H4 using fixed equal-risk rebalancing windows.'
  );
  lines.push('');

  const markdown = lines.join('\n');
  if (/\baccuracy\b/i.test(markdown) || /probability of winning/i.test(markdown)) {
    throw new Error('Report contains forbidden wording ("accuracy" or "probability of winning").');
  }
  return markdown;
}

export function buildResearchTradesCsv(sim: ResearchSimulationOutput): string {
  const headers = [
    'hypothesis_id',
    'hypothesis_name',
    'block',
    'symbol',
    'entry_time_iso',
    'exit_time_iso',
    'direction',
    'entry_price',
    'stop_loss',
    'take_profit',
    'exit_reason',
    'gross_r',
    'cost_r',
    'net_r',
  ];

  const allTrades: ResearchTradeRecord[] = Object.values(sim.tradesByHypothesis).flat();
  allTrades.sort((a, b) => a.entryTimeSec - b.entryTimeSec || a.hypothesisId.localeCompare(b.hypothesisId));

  const rows = [headers.join(',')];
  for (const t of allTrades) {
    const safeName = `"${t.hypothesisName.replace(/"/g, '""')}"`;
    rows.push(
      [
        t.hypothesisId,
        safeName,
        t.block,
        t.symbol,
        t.entryTimeIso,
        t.exitTimeIso,
        t.direction,
        t.entryPrice,
        t.stopLoss,
        t.takeProfit,
        t.exitReason,
        t.grossR.toFixed(5),
        t.costR.toFixed(5),
        t.netR.toFixed(5),
      ].join(',')
    );
  }
  return rows.join('\n') + '\n';
}
