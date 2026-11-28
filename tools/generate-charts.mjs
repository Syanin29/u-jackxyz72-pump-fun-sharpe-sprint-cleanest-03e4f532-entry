// generate-charts.mjs — Clean Sharpe Sniper (v3 tooling).
//
// Two modes, both deterministic (Node stdlib only, no network, no clock,
// no randomness beyond a fixed-seed LCG used for the bootstrap):
//
//   node tools/generate-charts.mjs
//       Read tools/equity-hourly.json and (re)write figures/equity-curve.svg
//       AND figures/fee-pnl-sensitivity.svg. Re-running it produces
//       byte-identical files (checked by verify.mjs).
//
//   node tools/generate-charts.mjs --from-grade <grade-save-dir> --dataset <kit-dataset-dir>
//       Recompute tools/equity-hourly.json from a grade-local --save directory
//       (result.json + action-log.json) and the kit dataset events, then
//       regenerate both figures. This is how the committed JSON was produced:
//         node cli/makefun.mjs grade-local --kit <kit> --bot <entry> \
//           --driver process --worktree --save <dir> --json
//         node tools/generate-charts.mjs --from-grade <dir> --dataset <kit>/dataset
//
// v3 additions: deriveFromGrade also emits `fee_sensitivity_fine` (0x..3x in
// 0.5x steps) and `per_mint_distribution` (the 58 per-mint PnL values sorted
// desc, leave-one-out net PnL without the top-1/top-3/top-5, median PnL per
// mint, breakeven fee multiplier), which feed the second figure
// (renderFeePnlSvg) and the v3 deep-dive tables in the README.
//
// Method (see tools/equity-hourly.json "provenance" + README "How the figure
// is made"): per-token realized PnL from the scorer is attributed to the hour
// of that mint's creation in the dataset. Round trips close within 600 slots
// (~4 min) of entry and entry is within 6 slots of creation, so at most ~4
// minutes of PnL can spill across an hour boundary. The curve is realized
// PnL only: the scorer's hourly mark-to-market equity is not in its output,
// which is why the recomputed Sharpe (+0.1649) differs from the official one
// (+0.1643) by 0.0005, and why the realized-curve max drawdown (0.35%) is
// slightly below the scorer's official max drawdown (0.43%).
//
// Chart style follows the trading-visualization skill: dark theme
// (#1a1a2e background, #00ff88 profit green, #ff4444 loss red), equity curve
// panel above a drawdown panel (height ratio 2:1), grid, labelled axes with
// readable numbers, final PnL and max drawdown annotated.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA_PATH = path.join(ROOT, 'tools', 'equity-hourly.json');
const FIG_PATH = path.join(ROOT, 'figures', 'equity-curve.svg');
const FEE_FIG_PATH = path.join(ROOT, 'figures', 'fee-pnl-sensitivity.svg');

const LAMPORTS_PER_SOL = 1e9;
const TX_FEE_LAMPORTS = 105000; // 5000 base + 100000 priority, per fill
const EXPECTED_SHA = '904e01d5d157e9923caa45c5f98b7bc1f3b46207555dfa82ebe071d17a0c3240';

const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sd1 = (a) => {
  const mu = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - mu) ** 2, 0) / (a.length - 1));
};
const sharpeOf = (rets) => mean(rets) / sd1(rets);

// --- normal CDF helpers (Acklam inverse + Abramowitz-Stegun erf) for DSR.
const erf = (x) => {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax));
  return s * y;
};
const phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
const phiInv = (p) => {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  let q;
  let x;
  if (p < plow) {
    q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= phigh) {
    q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  return x;
};
// Deflated Sharpe (Bailey & Lopez de Prado), N = disclosed trials, T = obs.
const deflatedSharpe = (sr, nTrials, nObs) => {
  const gamma = 0.5772156649;
  const variance = (1 + (sr * sr) / 2) / nObs;
  const sd = Math.sqrt(variance);
  const sr0 = sd * ((1 - gamma) * phiInv(1 - 1 / nTrials) + gamma * phiInv(1 - 1 / (nTrials * Math.E)));
  return phi((sr - sr0) / sd);
};
// Deterministic bootstrap of the Sharpe (fixed-seed LCG, 10k resamples).
const bootstrapSharpe5th = (rets) => {
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const boots = [];
  for (let b = 0; b < 10000; b++) {
    const sample = Array.from({ length: rets.length }, () => rets[Math.floor(rnd() * rets.length)]);
    boots.push(sharpeOf(sample));
  }
  boots.sort((x, y) => x - y);
  return boots[500];
};

const fmtSol = (lamports) => {
  const sign = lamports < 0 ? '-' : '+';
  return `${sign}${(Math.abs(lamports) / LAMPORTS_PER_SOL).toFixed(4)}`;
};

// Recompute the derived JSON from a grade-local --save directory.
function deriveFromGrade(saveDir, datasetDir) {
  const result = JSON.parse(fs.readFileSync(path.join(saveDir, 'result.json'), 'utf8'));
  if (result.action_log_sha256 !== EXPECTED_SHA) {
    throw new Error(`action_log_sha256 mismatch: ${result.action_log_sha256} (expected ${EXPECTED_SHA}) — strategy output changed, refusing to derive`);
  }
  const metrics = result.performance.metrics;
  const perToken = metrics.per_token;
  const manifest = JSON.parse(fs.readFileSync(path.join(datasetDir, 'manifest.json'), 'utf8'));
  const w0 = manifest.window.first_block_time;
  const created = new Map();
  for (const part of fs.readdirSync(path.join(datasetDir, 'events')).sort()) {
    if (!part.endsWith('.ndjson.gz')) continue;
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(datasetDir, 'events', part)));
    for (const line of raw.toString('utf8').split('\n')) {
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.event === 'CreateEvent' && !created.has(e.mint)) created.set(e.mint, e.block_time);
    }
  }
  const capital = 10_000_000_000;
  const hourly = Array.from({ length: 24 }, (_, i) => ({ hour: i, pnl_lamports: 0, curve_fees_lamports: 0, fills: 0, mints: 0, wins: 0 }));
  for (const t of perToken) {
    const ct = created.get(t.mint);
    if (ct === undefined) throw new Error(`no CreateEvent for traded mint ${t.mint}`);
    const h = Math.floor((ct - w0) / 3600);
    if (h < 0 || h > 23) throw new Error(`mint ${t.mint} created outside the 24 h window (hour ${h})`);
    hourly[h].pnl_lamports += Number(t.realized_pnl_lamports);
    hourly[h].curve_fees_lamports += Number(t.fees_lamports);
    hourly[h].fills += t.fills;
    hourly[h].mints += 1;
    if (Number(t.realized_pnl_lamports) > 0) hourly[h].wins += 1;
  }
  const sumPnl = hourly.reduce((s, x) => s + x.pnl_lamports, 0);
  if (sumPnl !== Number(metrics.net_pnl_lamports)) {
    throw new Error(`hourly PnL sum ${sumPnl} != scorer net PnL ${metrics.net_pnl_lamports}`);
  }
  const rets = hourly.map((x) => x.pnl_lamports / capital);
  const half = (slice) => ({
    pnl_lamports: slice.reduce((s, x) => s + x.pnl_lamports, 0),
    sharpe_recomputed: Number(sharpeOf(slice.map((x) => x.pnl_lamports / capital)).toFixed(6)),
    positive_hours: slice.filter((x) => x.pnl_lamports > 0).length,
  });
  const halves = [
    { label: 'H1 hours 0-11', ...half(hourly.slice(0, 12)) },
    { label: 'H2 hours 12-23', ...half(hourly.slice(12)) },
  ];
  // Fee sensitivity: PnL at 0x/3x is a linear extrapolation from the scorer's
  // own 1x and 2x points (slope = 1x PnL - 2x PnL per 1x of fees). Sharpe at
  // each level is recomputed from hourly returns with per-hour fees
  // (curve fees + 105000 lamports per fill). The scorer's 2x PnL differs
  // from this hourly recomputation by 305365 lamports (0.000305 SOL); the
  // cause is not visible in the scorer output, so the scorer's number is
  // used for the 2x row and the gap is disclosed in the README.
  const slope = Number(metrics.net_pnl_lamports) - Number(metrics.cost_sensitivity.net_pnl_lamports);
  const feeSensitivity = [0, 1, 2, 3].map((mult) => {
    const pnlH = hourly.map((x) => x.pnl_lamports + (1 - mult) * (x.curve_fees_lamports + TX_FEE_LAMPORTS * x.fills));
    const r = pnlH.map((v) => v / capital);
    const pnl =
      mult === 1
        ? Number(metrics.net_pnl_lamports)
        : mult === 2
          ? Number(metrics.cost_sensitivity.net_pnl_lamports)
          : Number(metrics.net_pnl_lamports) + (1 - mult) * slope;
    return {
      multiplier: mult,
      pnl_lamports: pnl,
      sharpe_recomputed: Number(sharpeOf(r).toFixed(6)),
      pnl_source: mult === 1 ? 'scorer official' : mult === 2 ? 'scorer official (cost_sensitivity)' : 'linear extrapolation from scorer 1x/2x slope',
    };
  });
  // v3: fine-grained fee sensitivity (0x..3x in 0.5x steps) — same
  // convention as fee_sensitivity: scorer numbers at 1x/2x, linear
  // extrapolation from the 1x/2x slope elsewhere; Sharpe recomputed
  // from hourly returns with per-hour fees at each tier. The 2x row's
  // hourly recomputation differs from the scorer by the same 305365
  // lamports gap disclosed in the README (scorer number is used).
  const feeSensitivityFine = [0, 0.5, 1, 1.5, 2, 2.5, 3].map((mult) => {
    const pnlH = hourly.map((x) => x.pnl_lamports + (1 - mult) * (x.curve_fees_lamports + TX_FEE_LAMPORTS * x.fills));
    const r = pnlH.map((v) => v / capital);
    const pnl =
      mult === 1
        ? Number(metrics.net_pnl_lamports)
        : mult === 2
          ? Number(metrics.cost_sensitivity.net_pnl_lamports)
          : Number(metrics.net_pnl_lamports) + (1 - mult) * slope;
    return {
      multiplier: mult,
      pnl_lamports: pnl,
      sharpe_recomputed: Number(sharpeOf(r).toFixed(6)),
      pnl_source: mult === 1 ? 'scorer official' : mult === 2 ? 'scorer official (cost_sensitivity)' : 'linear extrapolation from scorer 1x/2x slope',
    };
  });
  // v3: per-mint realized PnL distribution (58 mints, sorted desc) —
  // the raw material for the leave-one-out table and the histogram in
  // figures/fee-pnl-sensitivity.svg. Breakeven fee multiplier from the
  // same slope: PnL(m) = net + (1-m)*slope = 0 at m = 1 + net/slope.
  const perMint = [...perToken]
    .map((t) => ({ mint: t.mint, pnl_lamports: Number(t.realized_pnl_lamports), fills: t.fills }))
    .sort((a, b) => b.pnl_lamports - a.pnl_lamports);
  const topSum = (k) => perMint.slice(0, k).reduce((s, t) => s + t.pnl_lamports, 0);
  const sortedPnl = perToken.map((t) => Number(t.realized_pnl_lamports)).sort((a, b) => a - b);
  const perMintDistribution = {
    per_mint: perMint,
    wins: perToken.filter((t) => Number(t.realized_pnl_lamports) > 0).length,
    losses: perToken.filter((t) => Number(t.realized_pnl_lamports) < 0).length,
    median_pnl_lamports: (sortedPnl[28] + sortedPnl[29]) / 2,
    leave_one_out: [1, 3, 5].map((k) => ({
      without_top_k: k,
      net_pnl_lamports: Number(metrics.net_pnl_lamports) - topSum(k),
    })),
    breakeven_fee_multiplier: Number((1 + Number(metrics.net_pnl_lamports) / slope).toFixed(6)),
    note: 'per_mint sorted by realized PnL desc. leave_one_out = net PnL with the top-k mints removed. breakeven_fee_multiplier is the linear-extrapolation point where net PnL hits 0 (slope method; the total-fees method 1 + net/totalFees gives 1.775804 — both round to ~1.77x).',
  };
  // Probe vs snipe split from the action log: a probe buy is exactly
  // probeSol (0.01 SOL = 10,000,000 lamports); every other buy is a snipe
  // first buy (min of the 1%-of-reserve cap and 0.05 SOL).
  const actionLog = JSON.parse(fs.readFileSync(path.join(saveDir, 'action-log.json'), 'utf8'));
  const probeMints = new Set();
  const snipeMints = new Set();
  let probeBuys = 0;
  let snipeBuys = 0;
  for (const rep of actionLog.replies) {
    for (const o of rep.orders || []) {
      if (o.side !== 'buy') continue;
      if (o.quote_lamports === '10000000') {
        probeBuys++;
        probeMints.add(o.mint);
      } else {
        snipeBuys++;
        snipeMints.add(o.mint);
      }
    }
  }
  const byMint = new Map(perToken.map((t) => [t.mint, t]));
  const probeOnly = [...probeMints].filter((x) => !snipeMints.has(x));
  const snipeFilled = [...snipeMints].filter((x) => byMint.has(x));
  const probeSplit = {
    probe_buys: probeBuys,
    probe_mints: probeMints.size,
    probe_only_mints: probeOnly.length,
    probe_only_pnl_lamports: probeOnly.reduce((s, x) => s + Number(byMint.get(x).realized_pnl_lamports), 0),
    probe_only_fills: probeOnly.reduce((s, x) => s + byMint.get(x).fills, 0),
    probe_only_wins: probeOnly.filter((x) => Number(byMint.get(x).realized_pnl_lamports) > 0).length,
    snipe_buys: snipeBuys,
    snipe_mints: snipeMints.size,
    snipe_mints_with_fills: snipeFilled.length,
    snipe_pnl_lamports: snipeFilled.reduce((s, x) => s + Number(byMint.get(x).realized_pnl_lamports), 0),
    snipe_fills: snipeFilled.reduce((s, x) => s + byMint.get(x).fills, 0),
    snipe_wins: snipeFilled.filter((x) => Number(byMint.get(x).realized_pnl_lamports) > 0).length,
    note: 'Probe = buy of exactly 0.01 SOL (probeSol). Snipe = any other buy (first buy = min(1%-of-reserve cap, 0.05 SOL), so capped snipes have variable sizes 0.011-0.049 SOL). One probed mint was later sniped (5sQyLNyz..., net +0.000474 SOL, counted in snipe). One snipe buy (7waAwdMm...) never filled; 3 of 68 buy orders never filled (2 rejected + 1 failed tx).',
  };
  const validation = {
    sharpe_recomputed: Number(sharpeOf(rets).toFixed(6)),
    sharpe_official: metrics.sharpe,
    bootstrap_sharpe_5th_pct: Number(bootstrapSharpe5th(rets).toFixed(4)),
    deflated_sharpe_approx: Number(deflatedSharpe(Number(metrics.sharpe), 25, 24).toFixed(3)),
    note: 'DSR approx uses the Bailey-Lopez de Prado formula with N=25 disclosed trials (best of ~25 graded variants) and T=24 hourly observations; it is an approximation, not fa-quant output (this bot is not a fa-quant strategy). Bootstrap is a fixed-seed resample of the 24 hourly returns.',
  };
  return {
    provenance:
      'Derived 2026-11-28 from grade-local --save output (result.json per_token + action-log.json) and kit dataset events (CreateEvent block_time). Per-token realized PnL attributed to the hour of the mint creation; round trips close within <=600 slots (~4 min) of entry (entry <=6 slots after creation), so cross-hour spill is at most ~4 min at hour boundaries. Hourly Sharpe recomputed from these 24 hourly returns (mean/std, ddof=1) = +0.1649 vs scorer official +0.1643 (gap 0.0005: scorer uses mark-to-market hourly equity, this file uses realized-only PnL). Tx fee 105000 lamports/fill; the single failed tx (105000 lamports) is excluded from the hourly split (its hour is not identifiable from the action log) and is noted in the README. Fee sensitivity PnL at 0x/3x is a linear extrapolation from the scorer own 1x/2x points (slope 0.06328307 SOL per 1x); Sharpe at each fee level is recomputed from hourly returns with per-hour fees (curve fees from per_token + 105000/fill). v3 (28 Nov 2026): added fee_sensitivity_fine (0x..3x in 0.5x steps, same convention) and per_mint_distribution (58 per-mint PnL values, leave-one-out without top-1/top-3/top-5, median PnL per mint, breakeven fee multiplier 1.773348) — re-derived from the same frozen grade output (action_log_sha256 unchanged).',
    window_start_epoch: w0,
    capital_lamports: capital,
    hourly,
    totals: {
      net_pnl_lamports: Number(metrics.net_pnl_lamports),
      sharpe: metrics.sharpe,
      max_drawdown: metrics.max_drawdown,
      fills: metrics.fills,
      distinct_mints: metrics.distinct_mints,
    },
    window: {
      start_utc: new Date(w0 * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
      end_utc: new Date((w0 + 24 * 3600) * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
      start_epoch: w0,
      hours: 24,
    },
    halves,
    fee_sensitivity: feeSensitivity,
    fee_sensitivity_fine: feeSensitivityFine,
    per_mint_distribution: perMintDistribution,
    probe_split: probeSplit,
    validation,
  };
}

// --- SVG rendering (deterministic: fixed layout, toFixed numbers only). ---
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
function renderSvg(data) {
  const W = 960;
  const H = 560;
  const L = 78;
  const R = 20;
  const T = 46;
  const MID = 396; // boundary between equity panel and drawdown panel
  const B = 516;
  const plotW = W - L - R;
  const hourly = data.hourly;
  const capital = data.capital_lamports;
  let cum = 0;
  const cumSol = hourly.map((x) => {
    cum += x.pnl_lamports;
    return cum / LAMPORTS_PER_SOL;
  });
  let peak = 0;
  const dd = cumSol.map((v) => {
    if (v > peak) peak = v;
    return (peak - v) / (10 + peak);
  });
  const maxDd = Math.max(...dd);
  const maxDdHour = dd.indexOf(maxDd);
  const minEq = Math.min(0, ...cumSol);
  const maxEq = Math.max(0.01, ...cumSol);
  const eqPad = (maxEq - minEq) * 0.08 + 0.002;
  const eqTop = maxEq + eqPad;
  const eqBot = minEq - eqPad;
  const x = (i) => L + (i / 23) * plotW;
  const yEq = (v) => T + ((eqTop - v) / (eqTop - eqBot)) * (MID - T - 28);
  const yDd = (v) => MID + 22 + (v / (Math.max(maxDd * 1.15, 0.001))) * (B - MID - 52);
  const points = (vals, yFn) => vals.map((v, i) => `${x(i).toFixed(1)},${yFn(v).toFixed(1)}`).join(' ');
  const area = `${L},${yEq(0).toFixed(1)} ${points(cumSol, yEq)} ${x(23).toFixed(1)},${yEq(0).toFixed(1)}`;
  const gridEq = [0, 0.02, 0.04, 0.06].filter((v) => v >= eqBot && v <= eqTop);
  const gridDd = [0, 0.001, 0.002, 0.003, 0.004].filter((v) => v <= Math.max(maxDd * 1.15, 0.001));
  const hourTicks = [0, 4, 8, 12, 16, 20, 23];
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="monospace" font-size="12">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#1a1a2e"/>`);
  parts.push(`<text x="${L}" y="24" fill="#e0e0e0" font-size="16" font-weight="bold">Equity curve — realized PnL, dev window 24 h (2–3 Nov 2026)</text>`);
  parts.push(`<text x="${L}" y="40" fill="#aaaaaa" font-size="11">Capital 10 SOL · final ${fmtSol(data.totals.net_pnl_lamports)} SOL · Sharpe (hourly) ${data.totals.sharpe} · 145 fills / 58 mints</text>`);
  // Equity panel grid + labels.
  for (const v of gridEq) {
    parts.push(`<line x1="${L}" y1="${yEq(v).toFixed(1)}" x2="${W - R}" y2="${yEq(v).toFixed(1)}" stroke="#333333" stroke-width="1"/>`);
    parts.push(`<text x="${L - 8}" y="${(yEq(v) + 4).toFixed(1)}" fill="#aaaaaa" text-anchor="end">${v >= 0 ? '+' : ''}${v.toFixed(2)} SOL</text>`);
  }
  for (const i of hourTicks) {
    parts.push(`<line x1="${x(i).toFixed(1)}" y1="${T}" x2="${x(i).toFixed(1)}" y2="${MID - 28}" stroke="#2a2a44" stroke-width="1"/>`);
    parts.push(`<text x="${x(i).toFixed(1)}" y="${MID - 12}" fill="#aaaaaa" text-anchor="middle">h+${i}</text>`);
  }
  parts.push(`<polygon points="${esc(area)}" fill="#00ff88" opacity="0.12"/>`);
  parts.push(`<polyline points="${esc(points(cumSol, yEq))}" fill="none" stroke="#00ff88" stroke-width="2"/>`);
  parts.push(`<line x1="${L}" y1="${yEq(0).toFixed(1)}" x2="${W - R}" y2="${yEq(0).toFixed(1)}" stroke="#555555" stroke-width="1" stroke-dasharray="4 3"/>`);
  // Annotations: hour-16 spike and final value.
  parts.push(`<circle cx="${x(16).toFixed(1)}" cy="${yEq(cumSol[16]).toFixed(1)}" r="4" fill="#ffcc00"/>`);
  parts.push(`<text x="${(x(16) + 8).toFixed(1)}" y="${(yEq(cumSol[16]) - 8).toFixed(1)}" fill="#ffcc00">h+16: +0.0461 SOL (GAPWCmtX +0.0315)</text>`);
  parts.push(`<circle cx="${x(23).toFixed(1)}" cy="${yEq(cumSol[23]).toFixed(1)}" r="4" fill="#00ff88"/>`);
  parts.push(`<text x="${(x(23) - 8).toFixed(1)}" y="${(yEq(cumSol[23]) - 10).toFixed(1)}" fill="#e0e0e0" text-anchor="end">final ${fmtSol(data.totals.net_pnl_lamports)} SOL</text>`);
  parts.push(`<text x="${L}" y="${MID + 14}" fill="#e0e0e0" font-size="13" font-weight="bold">Drawdown (realized curve, % of equity)</text>`);
  for (const v of gridDd) {
    parts.push(`<line x1="${L}" y1="${yDd(v).toFixed(1)}" x2="${W - R}" y2="${yDd(v).toFixed(1)}" stroke="#333333" stroke-width="1"/>`);
    parts.push(`<text x="${L - 8}" y="${(yDd(v) + 4).toFixed(1)}" fill="#aaaaaa" text-anchor="end">${(v * 100).toFixed(1)}%</text>`);
  }
  parts.push(`<polygon points="${L},${yDd(0).toFixed(1)} ${points(dd, yDd)} ${x(23).toFixed(1)},${yDd(0).toFixed(1)}" fill="#ff4444" opacity="0.45"/>`);
  parts.push(`<polyline points="${esc(points(dd, yDd))}" fill="none" stroke="#ff4444" stroke-width="1.5"/>`);
  parts.push(`<circle cx="${x(maxDdHour).toFixed(1)}" cy="${yDd(maxDd).toFixed(1)}" r="4" fill="#ff4444"/>`);
  parts.push(`<text x="${(x(maxDdHour) + 8).toFixed(1)}" y="${(yDd(maxDd) - 8).toFixed(1)}" fill="#ff4444">max DD ${(maxDd * 100).toFixed(2)}% at h+${maxDdHour} (scorer official 0.43%)</text>`);
  parts.push(`<text x="${L}" y="${B + 26}" fill="#888888" font-size="11">Hour h+n = n-th hour of the dev window from 2026-11-02T03:09:03Z. Realized PnL only (per-token PnL attributed to mint creation hour); scorer mark-to-market max DD is 0.43%.</text>`);
  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

// --- v3: second figure — fee sensitivity curve over a per-mint PnL
// histogram (960x560, same dark theme). Top panel: net PnL vs fee
// multiplier 0x..3x, breakeven vertical (~1.77x) and the loss zone above
// it shaded red. Bottom panel: histogram of realized PnL across the 58
// mints (green = winning bins, red = losing bins), median and top-3
// annotated. Fallback: if the JSON has no per_mint_distribution (an older
// committed JSON), the bottom panel shows the 24 hourly PnL bars instead
// of the histogram, so the figure still renders from committed data.
function renderFeePnlSvg(data) {
  const W = 960;
  const H = 560;
  const L = 78;
  const R = 20;
  const T = 46;
  const MID = 316; // boundary between fee-curve panel and histogram panel
  const B = 516;
  const plotW = W - L - R;
  const fee = data.fee_sensitivity_fine || data.fee_sensitivity;
  const breakeven =
    data.per_mint_distribution && data.per_mint_distribution.breakeven_fee_multiplier
      ? data.per_mint_distribution.breakeven_fee_multiplier
      : 1.773348;
  const feeMult = fee.map((r) => r.multiplier);
  const feePnl = fee.map((r) => r.pnl_lamports / LAMPORTS_PER_SOL);
  const feeMin = Math.min(0, ...feePnl);
  const feeMax = Math.max(0.01, ...feePnl);
  const feePad = (feeMax - feeMin) * 0.08 + 0.005;
  const feeTop = feeMax + feePad;
  const feeBot = feeMin - feePad;
  const xFee = (m) => L + (m / 3) * plotW;
  const yFee = (v) => T + ((feeTop - v) / (feeTop - feeBot)) * (MID - T - 28);
  const feePts = feePnl.map((v, i) => `${xFee(feeMult[i]).toFixed(1)},${yFee(v).toFixed(1)}`).join(' ');
  const feeGrid = [-0.05, 0, 0.05, 0.1].filter((v) => v >= feeBot && v <= feeTop);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="monospace" font-size="12">`);
  parts.push(`<rect width="${W}" height="${H}" fill="#1a1a2e"/>`);
  parts.push(`<text x="${L}" y="24" fill="#e0e0e0" font-size="16" font-weight="bold">Fee sensitivity — net PnL vs fee multiplier (dev window 24 h)</text>`);
  parts.push(`<text x="${L}" y="40" fill="#aaaaaa" font-size="11">Breakeven at ${breakeven.toFixed(2)}x fees · 1x fees = 0.0633 SOL · edge dies between 1x and 2x</text>`);
  // Loss zone above breakeven, shaded red.
  parts.push(`<rect x="${xFee(breakeven).toFixed(1)}" y="${T}" width="${(xFee(3) - xFee(breakeven)).toFixed(1)}" height="${(MID - T - 28).toFixed(1)}" fill="#ff4444" opacity="0.08"/>`);
  parts.push(`<text x="${((xFee(breakeven) + xFee(3)) / 2).toFixed(1)}" y="${(T + 16).toFixed(1)}" fill="#ff4444" text-anchor="middle">loss zone</text>`);
  for (const v of feeGrid) {
    parts.push(`<line x1="${L}" y1="${yFee(v).toFixed(1)}" x2="${W - R}" y2="${yFee(v).toFixed(1)}" stroke="#333333" stroke-width="1"/>`);
    parts.push(`<text x="${L - 8}" y="${(yFee(v) + 4).toFixed(1)}" fill="#aaaaaa" text-anchor="end">${v >= 0 ? '+' : ''}${v.toFixed(2)} SOL</text>`);
  }
  for (const m of [0, 0.5, 1, 1.5, 2, 2.5, 3]) {
    parts.push(`<line x1="${xFee(m).toFixed(1)}" y1="${T}" x2="${xFee(m).toFixed(1)}" y2="${MID - 28}" stroke="#2a2a44" stroke-width="1"/>`);
    parts.push(`<text x="${xFee(m).toFixed(1)}" y="${MID - 12}" fill="#aaaaaa" text-anchor="middle">${m}x</text>`);
  }
  parts.push(`<line x1="${L}" y1="${yFee(0).toFixed(1)}" x2="${W - R}" y2="${yFee(0).toFixed(1)}" stroke="#555555" stroke-width="1" stroke-dasharray="4 3"/>`);
  parts.push(`<polyline points="${esc(feePts)}" fill="none" stroke="#00ff88" stroke-width="2"/>`);
  feePnl.forEach((v, i) => {
    parts.push(`<circle cx="${xFee(feeMult[i]).toFixed(1)}" cy="${yFee(v).toFixed(1)}" r="3.5" fill="${v >= 0 ? '#00ff88' : '#ff4444'}"/>`);
    parts.push(`<text x="${xFee(feeMult[i]).toFixed(1)}" y="${(yFee(v) - 8).toFixed(1)}" fill="#e0e0e0" text-anchor="middle">${v >= 0 ? '+' : ''}${v.toFixed(3)}</text>`);
  });
  parts.push(`<line x1="${xFee(breakeven).toFixed(1)}" y1="${T}" x2="${xFee(breakeven).toFixed(1)}" y2="${MID - 28}" stroke="#ffaa00" stroke-width="1.5" stroke-dasharray="5 3"/>`);
  parts.push(`<text x="${(xFee(breakeven) + 6).toFixed(1)}" y="${(MID - 34).toFixed(1)}" fill="#ffaa00">breakeven ${breakeven.toFixed(2)}x</text>`);

  // Bottom panel.
  parts.push(`<text x="${L}" y="${MID + 14}" fill="#e0e0e0" font-size="13" font-weight="bold">${data.per_mint_distribution ? 'Distribution of realized PnL per mint — 58 mints' : 'Hourly PnL — 24 hours (fallback: no per-mint data in JSON)'}</text>`);
  const histTop = MID + 22;
  const histBarTop = histTop + 18; // annotation line sits in the 18px strip above the bars
  const histBot = B - 8;
  const histH = histBot - histBarTop;
  if (data.per_mint_distribution) {
    const d = data.per_mint_distribution;
    const bins = [
      { lo: -Infinity, hi: -0.01, label: '<-0.01' },
      { lo: -0.01, hi: -0.005, label: '-0.01..-0.005' },
      { lo: -0.005, hi: -0.002, label: '-0.005..-0.002' },
      { lo: -0.002, hi: 0, label: '-0.002..0' },
      { lo: 0, hi: 0.002, label: '0..0.002' },
      { lo: 0.002, hi: 0.005, label: '0.002..0.005' },
      { lo: 0.005, hi: 0.01, label: '0.005..0.01' },
      { lo: 0.01, hi: 0.02, label: '0.01..0.02' },
      { lo: 0.02, hi: Infinity, label: '>=0.02' },
    ];
    const counts = bins.map((b) => d.per_mint.filter((t) => t.pnl_lamports / LAMPORTS_PER_SOL >= b.lo && t.pnl_lamports / LAMPORTS_PER_SOL < b.hi).length);
    const maxC = Math.max(...counts);
    const barW = plotW / bins.length;
    for (let i = 0; i < bins.length; i++) {
      const bx = L + i * barW;
      const bh = (counts[i] / maxC) * histH;
      const win = bins[i].lo >= 0;
      parts.push(`<rect x="${(bx + 3).toFixed(1)}" y="${(histBot - bh).toFixed(1)}" width="${(barW - 6).toFixed(1)}" height="${bh.toFixed(1)}" fill="${win ? '#00ff88' : '#ff4444'}" opacity="0.75"/>`);
      parts.push(`<text x="${(bx + barW / 2).toFixed(1)}" y="${(histBot - bh - 5).toFixed(1)}" fill="#e0e0e0" text-anchor="middle">${counts[i]}</text>`);
      parts.push(`<text x="${(bx + barW / 2).toFixed(1)}" y="${(B + 14).toFixed(1)}" fill="#aaaaaa" text-anchor="middle" font-size="10">${bins[i].label}</text>`);
    }
    parts.push(`<text x="${L}" y="${(histTop + 12).toFixed(1)}" fill="#aaaaaa" font-size="11">median ${fmtSol(d.median_pnl_lamports)} SOL · ${d.wins} wins / ${d.losses} losses · top-3: GAPWCmtX +0.0315, J4nMyqq3 +0.0277, 9DU5CwdW +0.0102 (47.9% of gross gains)</text>`);
    parts.push(`<text x="${L}" y="${B + 26}" fill="#888888" font-size="11">PnL per mint in SOL (realized, from scorer per_token). Without the top-3 mints net PnL is -0.0205 SOL; without the top-5 it is -0.0394 SOL.</text>`);
  } else {
    const hourly = data.hourly;
    const vals = hourly.map((x) => x.pnl_lamports / LAMPORTS_PER_SOL);
    const vMax = Math.max(0.01, ...vals.map(Math.abs));
    const barW = plotW / 24;
    vals.forEach((v, i) => {
      const bx = L + i * barW;
      const bh = (Math.abs(v) / vMax) * (histH / 2);
      const y0 = histBarTop + histH / 2;
      parts.push(`<rect x="${(bx + 2).toFixed(1)}" y="${(v >= 0 ? y0 - bh : y0).toFixed(1)}" width="${(barW - 4).toFixed(1)}" height="${bh.toFixed(1)}" fill="${v >= 0 ? '#00ff88' : '#ff4444'}" opacity="0.75"/>`);
      parts.push(`<text x="${(bx + barW / 2).toFixed(1)}" y="${(B + 14).toFixed(1)}" fill="#aaaaaa" text-anchor="middle" font-size="10">${i % 4 === 0 ? 'h+' + i : ''}</text>`);
    });
    parts.push(`<line x1="${L}" y1="${(histBarTop + histH / 2).toFixed(1)}" x2="${W - R}" y2="${(histBarTop + histH / 2).toFixed(1)}" stroke="#555555" stroke-width="1" stroke-dasharray="4 3"/>`);
    parts.push(`<text x="${L}" y="${B + 26}" fill="#888888" font-size="11">Hourly realized PnL in SOL (24 bars). Fallback panel: this JSON predates the per-mint distribution; re-derive with --from-grade to get the histogram.</text>`);
  }
  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

function main() {
  const args = process.argv.slice(2);
  const fromGrade = args.indexOf('--from-grade');
  if (fromGrade !== -1) {
    const saveDir = args[fromGrade + 1];
    const dsIdx = args.indexOf('--dataset');
    if (!saveDir || dsIdx === -1 || !args[dsIdx + 1]) {
      throw new Error('usage: generate-charts.mjs --from-grade <grade-save-dir> --dataset <kit-dataset-dir>');
    }
    const derived = deriveFromGrade(saveDir, args[dsIdx + 1]);
    fs.writeFileSync(DATA_PATH, JSON.stringify(derived, null, 2) + '\n');
    console.log(`wrote ${DATA_PATH}`);
  }
  const data = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
  fs.mkdirSync(path.dirname(FIG_PATH), { recursive: true });
  const svg = renderSvg(data);
  fs.writeFileSync(FIG_PATH, svg);
  console.log(`wrote ${FIG_PATH} (${svg.length} bytes, sha256 ${createHash('sha256').update(svg).digest('hex').slice(0, 16)}…)`);
  const feeSvg = renderFeePnlSvg(data);
  fs.writeFileSync(FEE_FIG_PATH, feeSvg);
  console.log(`wrote ${FEE_FIG_PATH} (${feeSvg.length} bytes, sha256 ${createHash('sha256').update(feeSvg).digest('hex').slice(0, 16)}…)`);
}

main();
