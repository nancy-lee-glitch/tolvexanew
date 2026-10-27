# PulseTrade Cockpit & Analysis Engine Upgrade

Enhance the trading cockpit with dual analysis output profiles (Quick Expiry for EO/Deriv vs. MT5 Style for forex/crypto), a strict confirmation gate with market structure detection and pass/fail confluence checklist, transparent VIP vs. Credit tier access, and a dense, mobile-optimized trading layout.

---

## User Review & Critical Decisions

> [!IMPORTANT]
> The following architectural decisions were aligned during Phase 1 interactive clarification:
> - **Default Analysis Mode**: Quick Expiry mode (`CALL` | `PUT` | `WAIT`) for binary/fast expiration trading on first launch.
> - **Non-VIP & Credit Experience**: Core pass/fail factors remain visible with clean locked indicator badges for institutional rows (Liquidity Sweeps, FVGs, and MT5 precision SL/TP), without degrading analysis accuracy.
> - **Mobile Viewport Structure**: Single compact scrollable column with pinned primary action bar ensuring touch targets $\ge 44\text{px}$ on 375px–430px smartphone viewports without empty gutters.

---

## 1. Overview & Core Concept

- **What It Does**: Upgrades the quantitative engine to perform algorithmic confluence checking across tick buffers. Enforces mandatory instrument and timeframe binding, calculates market structure (Higher Highs / Higher Lows vs. Lower Highs / Lower Lows vs. Range), and gates trade recommendations behind a strict 5-factor confirmation checklist (EMA, RSI, Volume/Range, Liquidity Sweeps, Fair Value Gaps). If any required factor is `FAIL` or `UNSURE`, the system commands `WAIT / NO TRADE`.
- **Dual Outputs**:
  - **Mode A (Quick Expiry / EO / Deriv)**: Fast-horizon execution (`CALL` | `PUT` | `WAIT`), momentum trajectory, safe exit timing window, and risk note.
  - **Mode B (MT5 Style)**: Institutional trade blueprint (`BUY` | `SELL` | `WAIT`), structural classification, 9-point card hierarchy, Entry Zone, calculated Stop Loss, Take Profit 1 & 2, and invalidation criteria.
- **Target Persona**: Both high-frequency binary option scalpers and spot/forex MT5 traders seeking mathematical clarity over hype.

---

## 2. User Experience & Visual Design

### Visual Identity & Theme
- **Color Discipline**: 60% neutral obsidian (`#020617` / `#0b0f19`), 30% structural panels with subtle hairline borders (`#1e293b`), and 10% high-intent emerald (`#10b981`) and amber (`#f59e0b`) accents.
- **Typography**: Inter as the primary UI sans sitewide, paired with monospace tabular numerals (`JetBrains Mono` / `ui-monospace tabular-nums`) strictly for prices, pip deltas, countdown timers, and order parameters.
- **Anti-Slop Restraint**: Zero fake win rates (no "98% guaranteed"), zero decorative pulsing dots on static text, zero card-in-card nesting, and zero comment-style headers.

### Mobile Navigation & Layout ($375\text{px}$–$430\text{px}$)
- Full-bleed mobile shell eliminating awkward max-width side margins.
- Top navigation bar strictly adheres to the 3-Zone Top Bar Contract (Wordmark · Status/Credits · Help/Menu).
- Prominent Mode Switcher: Compact segmented toggle between `Quick (EO/Deriv)` and `MT5` prominently placed in the trading toolbar.
- Pinned bottom action bar containing the primary `Generate Signal` button (touch target $\ge 48\text{px}$), maintaining total sticky chrome within the 15% mobile viewport ceiling.

---

## 3. Key Product Decisions & Trade-Offs

### Decision 1: Shared Confirmation Engine, Differentiated Outputs
- **Chosen Approach**: A single `analyzeMarketStructureAndConfluence` pipeline executes all mathematical indicator, liquidity, and FVG routines regardless of mode. Mode A translates bullish/bearish confluence into `CALL`/`PUT` with safe close horizons; Mode B translates into `BUY`/`SELL` with MT5 SL/TP orders.
- **Why**: Eliminates code drift and ensures a trade setup valid in MT5 is identically backed in Quick Expiry, maintaining institutional integrity.

### Decision 2: Strict WAIT / NO TRADE Gate Rule
- **Chosen Approach**: When market structure is `RANGING` or any required factor evaluates to `FAIL` or `UNSURE`, the engine explicitly emits `WAIT`. It details the failed or unsure factors in the checklist.
- **Why**: Eliminates forced low-probability trades and builds genuine trader trust.

### Decision 3: Access Control Transparency
- **Chosen Approach**: Credit users receive real analysis directions and primary factor states, while advanced institutional parameters (fair value gaps, liquidity sweep levels, and calculated MT5 SL/TP) are visually marked with subtle VIP lock badges.
- **Why**: Allows non-paying or trial users to experience authentic analysis without giving away the full institutional suite, creating an honest upsell path.

---

## 4. Technical Architecture & Data Strategy

```
┌────────────────────────────────────────────────────────────────────────┐
│                        App Trading Cockpit                             │
│       ┌──────────────────────┐        ┌───────────────────────┐        │
│       │   Active Instrument  │        │   Selected Timeframe  │        │
│       │   (e.g., EUR/USD)    │        │   (30s, 1m, 5m, etc.) │        │
│       └──────────┬───────────┘        └───────────┬───────────┘        │
└──────────────────┼────────────────────────────────┼────────────────────┘
                   ▼                                ▼
┌────────────────────────────────────────────────────────────────────────┐
│             Mandatory Input Binding & Verification Gate                │
│   • Missing Instrument? ──> Status: ANALYSIS BLOCKED                   │
│   • Missing Timeframe?  ──> Status: ANALYSIS BLOCKED                   │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│             Live Ticker Stream / Tick Rolling Buffers                  │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│              Market Structure & Confluence Engine                      │
│                                                                        │
│   1. Market Structure Classification                                   │
│      ├── Highs & Lows Vector (HH/HL -> BULLISH, LH/LL -> BEARISH)      │
│      └── Range / Compression Detection -> RANGING / NEUTRAL            │
│                                                                        │
│   2. 5-Factor Confluence Checklist                                     │
│      ├── [1] EMA 9/21/50 Alignment & Slope    (PASS / FAIL / UNSURE)   │
│      ├── [2] RSI 14 Momentum & Exhaustion     (PASS / FAIL / UNSURE)   │
│      ├── [3] Volume / Range Profile Proxy     (PASS / FAIL / UNSURE)   │
│      ├── [4] Liquidity Sweep Detection        (PASS / FAIL / UNSURE)   │
│      └── [5] Fair Value Gap (FVG) Imbalance   (PASS / FAIL / UNSURE)   │
│                                                                        │
│   3. Strict Confirmation Gate Rule:                                    │
│      If Structure != Directional OR ANY Factor != PASS ──> WAIT        │
└──────────────────┬────────────────────────────────┬────────────────────┘
                   │                                │
                   ▼                                ▼
┌────────────────────────────────────┐ ┌─────────────────────────────────┐
│     Mode A: Quick Expiry           │ │     Mode B: MT5 Style Card      │
│  • Direction: CALL | PUT | WAIT    │ │  • Direction: BUY | SELL | WAIT │
│  • Safe Exit Window (e.g. 25s)     │ │  • 9-Point Stacked Card Order   │
│  • Confluence Score (no fake 98%)  │ │  • Structure & Invalidation     │
│  • Risk & Execution Note           │ │  • Entry Zone, SL, TP1, TP2     │
└────────────────────────────────────┘ └─────────────────────────────────┘
```

### Component & File Mapping (Surgical Modifications)
1. `src/utils/quantEngine.ts`:
   - Add `detectMarketStructure(ticks, pipSize)`: Computes swing highs/lows, determines `BULLISH` (HH/HL), `BEARISH` (LH/LL), or `RANGING`.
   - Add `evaluateConfluenceChecklist(ticks, structure, timeframe, isVIP)`: Generates structured checklist for EMA, RSI, Volume/Range proxy, Liquidity Sweep, and FVG.
   - Enforce gate rule: Any fail/unsure triggers `recommendedAction = 'WAIT'`.
   - Update `calculateMT5Parameters` to suppress SL/TP when in `WAIT` or `RANGING` state.
2. `src/components/SignalEngine.tsx`:
   - Add blocked state screen when instrument or timeframe is not bound.
   - Add `Quick (EO/Deriv)` vs. `MT5` execution mode toggle in the toolbar.
   - Render Mode A (Quick Expiry) and Mode B (MT5 9-point structured card).
   - Render pass/fail checklist items with locked badges for non-VIP accounts.
   - Optimize mobile layout for compact single-column flow with pinned CTA.
3. `src/components/VipSafeRadarModal.tsx`:
   - Connect asset cards directly to the updated confirmation engine.
   - Ensure the countdown timer and manual re-scan button remain visible and accessible on all viewport widths.
4. `src/types.ts`:
   - Extend `SignalData` and `TechnicalAudit` to include market structure details (`structureType`, `structureNote`), checklist array (`ConfluenceFactorItem`), and mode flag.

---

## 5. Verification & QA Plan

1. **Compilation Check**: Run `compile_applet` to verify TypeScript interfaces, JSX syntax, and imports.
2. **Blocked State Verification**: Test triggering signal without asset or timeframe; verify `ANALYSIS BLOCKED` modal guidance displays.
3. **Wait Gate Verification**: In choppy or conflicting tick conditions, verify that `WAIT / NO TRADE` is enforced with clear plain-English reasons.
4. **Actionable Trade Verification**: In strong trending ticks, verify `CALL` / `BUY` or `PUT` / `SELL` generates with verified checklist passes.
5. **Mode Switching**: Toggle between Quick Expiry and MT5 modes; verify instantaneous UI response and correct data presentation.
6. **Mobile Ergonomics**: Test on 375px and 390px viewport simulations to confirm zero horizontal bleed, visible countdown, and thumb-friendly controls.
