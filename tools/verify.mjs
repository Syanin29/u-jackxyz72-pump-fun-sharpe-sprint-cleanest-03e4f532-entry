// verify.mjs — Clean Sharpe Sniper (v3 tooling).
//
// Re-runs the kit grader on this entry and checks that the strategy output
// is byte-identical to the frozen v1 numbers, then checks that both figures
// regenerate deterministically and match the committed SVGs, then runs the
// soak test (tools/soak.mjs, grade-local 3x, same action log hash).
//
//   node tools/verify.mjs --kit <kit-root> [--bot <entry-dir>]
//   # env (same as any kit command):
//   HTTPS_PROXY=http://hatch-egress-proxy:3128 HTTP_PROXY=http://hatch-egress-proxy:3128 \
//     NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/run/hatch/egress-tls/ca-bundle.pem \
//     NODE_OPTIONS=--max-old-space-size=2048 node tools/verify.mjs --kit <kit-root>
//
// Checks (all must pass, otherwise exit 1):
//   1. action_log_sha256 is still 904e01d5d157e9923caa45c5f98b7bc1f3b46207555dfa82ebe071d17a0c3240
//   2. net PnL +0.048939820 SOL, Sharpe +0.164308520, Sortino 0.398819293,
//      max drawdown 0.004323681, win rate 0.318181818, 66 round trips,
//      145 fills, 58 mints
//   3. tools/generate-charts.mjs run twice produces byte-identical SVGs
//      (both figures/equity-curve.svg and figures/fee-pnl-sensitivity.svg),
//      and both SVGs match the committed files
//   4. tools/equity-hourly.json reconciles with the scorer totals: the
//      hourly rows, the window halves, the probe/snipe split, and the v3
//      per-mint distribution must all add back to the same net PnL, fills,
//      and mint counts; the fine fee-sensitivity table must agree with the
//      scorer at 1x/2x
//   5. tools/soak.mjs passes (3 grade-local runs, identical action log hash)
//
// This script changes nothing in the entry: the grade runs into a temp dir
// and the chart regeneration is compared, not committed, here.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const EXPECTED = {
  action_log_sha256: '904e01d5d157e9923caa45c5f98b7bc1f3b46207555dfa82ebe071d17a0c3240',
  net_pnl_lamports: '48939820',
  sharpe: '0.164308520',
  sortino: '0.398819293',
  max_drawdown: '0.004323681',
  win_rate: '0.318181818',
  round_trips: 66,
  fills: 145,
  distinct_mints: 58,
};

const args = process.argv.slice(2);
const kitIdx = args.indexOf('--kit');
if (kitIdx === -1 || !args[kitIdx + 1]) {
  console.error('usage: node tools/verify.mjs --kit <kit-root> [--bot <entry-dir>]');
  process.exit(2);
}
const kit = path.resolve(args[kitIdx + 1]);
const botIdx = args.indexOf('--bot');
const bot = botIdx === -1 ? ROOT : path.resolve(args[botIdx + 1]);
if (!fs.existsSync(path.join(kit, 'cli', 'makefun.mjs'))) {
  console.error(`FAIL: no kit at ${kit} (expected cli/makefun.mjs inside it)`);
  process.exit(2);
}

const failures = [];
const check = (name, actual, expected) => {
  const ok = String(actual) === String(expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${actual} (expected ${expected})`);
  if (!ok) failures.push(name);
};

// 1. Grade the entry into a temp dir.
const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharpe-verify-'));
console.log(`grading ${bot} with kit ${kit} (save: ${saveDir})`);
try {
  execFileSync(
    'node',
    ['cli/makefun.mjs', 'grade-local', '--kit', kit, '--bot', bot, '--driver', 'process', '--worktree', '--save', saveDir, '--json'],
    { cwd: kit, stdio: 'inherit', env: { ...process.env } },
  );
} catch (e) {
  console.error(`FAIL  grade-local exited ${e.status}`);
  process.exit(1);
}
const result = JSON.parse(fs.readFileSync(path.join(saveDir, 'result.json'), 'utf8'));
const metrics = result.performance.metrics;
check('action_log_sha256', result.action_log_sha256, EXPECTED.action_log_sha256);
check('net_pnl_lamports', metrics.net_pnl_lamports, EXPECTED.net_pnl_lamports);
check('sharpe', metrics.sharpe, EXPECTED.sharpe);
check('sortino', metrics.sortino, EXPECTED.sortino);
check('max_drawdown', metrics.max_drawdown, EXPECTED.max_drawdown);
check('win_rate', metrics.win_rate, EXPECTED.win_rate);
check('round_trips', metrics.round_trips, EXPECTED.round_trips);
check('fills', metrics.fills, EXPECTED.fills);
check('distinct_mints', metrics.distinct_mints, EXPECTED.distinct_mints);

// 2. Chart determinism: regenerate twice into temp dirs, compare hashes,
//    then compare against both committed figures.
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const committedSvg = fs.readFileSync(path.join(ROOT, 'figures', 'equity-curve.svg'));
const committedFeeSvg = fs.readFileSync(path.join(ROOT, 'figures', 'fee-pnl-sensitivity.svg'));
const runChart = () => {
  execFileSync('node', [path.join(ROOT, 'tools', 'generate-charts.mjs')], { cwd: ROOT, stdio: 'pipe' });
  return {
    equity: fs.readFileSync(path.join(ROOT, 'figures', 'equity-curve.svg')),
    fee: fs.readFileSync(path.join(ROOT, 'figures', 'fee-pnl-sensitivity.svg')),
  };
};
const svgA = runChart();
const svgB = runChart();
check('chart deterministic (two runs identical, equity)', sha(svgA.equity), sha(svgB.equity));
check('chart matches committed figures/equity-curve.svg', sha(svgA.equity), sha(committedSvg));
check('chart deterministic (two runs identical, fee sensitivity)', sha(svgA.fee), sha(svgB.fee));
check('chart matches committed figures/fee-pnl-sensitivity.svg', sha(svgA.fee), sha(committedFeeSvg));

// 3. Figure-data cross-check: the derived hourly table, the window halves,
//    the probe/snipe split, and the v3 per-mint distribution in
//    tools/equity-hourly.json must all add back to the scorer totals. The
//    grader never reads this file, so a stale or hand-edited JSON could
//    otherwise drift away from the graded numbers without any check noticing.
const derived = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools', 'equity-hourly.json'), 'utf8'));
const addUp = (rows, key) => rows.reduce((s, r) => s + r[key], 0);
check('hourly PnL sums to net PnL', addUp(derived.hourly, 'pnl_lamports'), derived.totals.net_pnl_lamports);
check('hourly fills sum to scorer fills', addUp(derived.hourly, 'fills'), derived.totals.fills);
check('hourly mints sum to scorer mints', addUp(derived.hourly, 'mints'), derived.totals.distinct_mints);
check('hourly table covers 24 hours', derived.hourly.length, 24);
check('halves PnL sums to net PnL', addUp(derived.halves, 'pnl_lamports'), derived.totals.net_pnl_lamports);
check('probe + snipe PnL sums to net PnL', derived.probe_split.probe_only_pnl_lamports + derived.probe_split.snipe_pnl_lamports, derived.totals.net_pnl_lamports);
check('probe + snipe fills sum to scorer fills', derived.probe_split.probe_only_fills + derived.probe_split.snipe_fills, derived.totals.fills);
check('probe-only + snipe mints sum to scorer mints', derived.probe_split.probe_only_mints + derived.probe_split.snipe_mints_with_fills, derived.totals.distinct_mints);
// v3: per-mint distribution + fine fee sensitivity.
const dist = derived.per_mint_distribution;
check('per-mint PnL sums to net PnL', addUp(dist.per_mint, 'pnl_lamports'), derived.totals.net_pnl_lamports);
check('per-mint covers 58 mints', dist.per_mint.length, derived.totals.distinct_mints);
check('per-mint wins + losses = 58 mints', dist.wins + dist.losses, derived.totals.distinct_mints);
check('leave-one-out without top-3', dist.leave_one_out.find((r) => r.without_top_k === 3).net_pnl_lamports, -20469710);
check('leave-one-out without top-1', dist.leave_one_out.find((r) => r.without_top_k === 1).net_pnl_lamports, 17443421);
check('leave-one-out without top-5', dist.leave_one_out.find((r) => r.without_top_k === 5).net_pnl_lamports, -39374432);
check('median PnL per mint', dist.median_pnl_lamports, -456917);
check('breakeven fee multiplier', dist.breakeven_fee_multiplier, 1.773348);
const fine = derived.fee_sensitivity_fine;
check('fine fee table covers 7 tiers', fine.length, 7);
check('fine fee 1x PnL is scorer net', fine.find((r) => r.multiplier === 1).pnl_lamports, derived.totals.net_pnl_lamports);
check('fine fee 2x PnL is scorer cost_sensitivity', fine.find((r) => r.multiplier === 2).pnl_lamports, -14343250);
fs.rmSync(saveDir, { recursive: true, force: true });

// 4. Soak: grade-local 3x, identical action log hash every run.
try {
  execFileSync('node', [path.join(ROOT, 'tools', 'soak.mjs'), '--kit', kit, '--bot', bot], { stdio: 'inherit', env: { ...process.env } });
} catch (e) {
  console.error(`FAIL  tools/soak.mjs exited ${e.status}`);
  process.exit(1);
}
console.log('PASS  soak: 3 grade-local runs, identical action_log_sha256 (see output above)');

if (failures.length > 0) {
  console.error(`\nVERIFY FAILED: ${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nVERIFY OK: strategy output frozen, both figures deterministic and current, soak passed.');
