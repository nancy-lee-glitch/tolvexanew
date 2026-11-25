/**
 * scripts/research/index.ts — CLI Entry Point for Stage R1 Pre-Registered Research
 *
 * Usage:
 *   npm run research
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadResearchUniverseAndHistories } from './cacheLoader.ts';
import { runAllPreRegisteredHypotheses } from './simulator.ts';
import {
  buildResearchMarkdownReport,
  buildResearchSummaries,
  buildResearchTradesCsv,
} from './report.ts';
import { PRE_REGISTERED_HYPOTHESES } from './hypotheses.ts';

async function main(): Promise<void> {
  console.log('============================================================');
  console.log('  TICKVERE STAGE R1: PRE-REGISTERED STRATEGY RESEARCH');
  console.log('============================================================');
  console.log(`Pre-registered hypotheses: ${PRE_REGISTERED_HYPOTHESES.map((h) => h.id).join(', ')}`);

  const { assets, histories, m5RatesMap, downloadedAny } =
    await loadResearchUniverseAndHistories();
  console.log(
    `Loaded ${assets.length} non-synthetic symbols (${downloadedAny ? 'downloaded missing cache files' : '100% from local data/cache'})`
  );

  const sim = runAllPreRegisteredHypotheses({ histories, m5RatesMap });
  console.log(
    `Time Split: Learning=${sim.timeSplit.globalStartIso.slice(0, 10)}..${sim.timeSplit.learningEndIso.slice(0, 10)} (~${Math.round(sim.timeSplit.learningDays)}d)`
  );
  console.log(
    `            Validation=${sim.timeSplit.learningEndIso.slice(0, 10)}..${sim.timeSplit.validationEndIso.slice(0, 10)} (~${Math.round(sim.timeSplit.validationDays)}d)`
  );
  console.log(
    `            LOCKED Forward (unread)=${sim.lockedForwardBlock.startIso.slice(0, 10)}..${sim.lockedForwardBlock.endIso.slice(0, 10)} (~${Math.round(sim.timeSplit.lockedForwardDays)}d)`
  );

  const summaries = buildResearchSummaries(sim);
  const generatedAtIso = new Date().toISOString();
  const dateTag = generatedAtIso.slice(0, 10);

  const markdown = buildResearchMarkdownReport({
    generatedAtIso,
    sim,
    summaries,
  });
  const csv = buildResearchTradesCsv(sim);

  const reportsDir = resolve(process.cwd(), 'reports');
  mkdirSync(reportsDir, { recursive: true });
  const mdPath = resolve(reportsDir, `research-${dateTag}.md`);
  const csvPath = resolve(reportsDir, `research-trades-${dateTag}.csv`);

  writeFileSync(mdPath, markdown, 'utf8');
  writeFileSync(csvPath, csv, 'utf8');

  console.log('\n' + markdown);
  console.log(`\nSaved research report: ${mdPath}`);
  console.log(`Saved research trades CSV: ${csvPath}`);
}

main().catch((err) => {
  console.error('[research] Fatal error:', err?.message || err);
  process.exit(1);
});
