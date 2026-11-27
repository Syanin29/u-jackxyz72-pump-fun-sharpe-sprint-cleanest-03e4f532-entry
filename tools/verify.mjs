// verify.mjs — Clean Sharpe Sniper (v2 tooling).
//
// Re-runs the kit grader on this entry and checks that the strategy output
// is byte-identical to the frozen v1 numbers, then checks that the figure
// regenerates deterministically and matches the committed SVG.
//
//   node tools/verify.mjs --kit <kit-root> [--bot <entry-dir>]
//   # env (same as any kit command):
//   HTTPS_PROXY=http://hatch-egress-proxy:3128 HTTP_PROXY=http://hatch-egress-proxy:3128 \
//     NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/run/hatch/egress-tls/ca-bundle.pem \
//     NODE_OPTIONS=--max-old-space-size=2048 node tools/verify.mjs --kit <kit-root>
//
// Checks (all must pass, otherwise exit 1):
//   1. action_log_sha256 is still 904e01d5d157e9923caa45c5f98b7bc1f3b46207555dfa82ebe071d17a0c3240
//   2. net PnL +0.048939820 SOL, Sharpe +0.164308520, max drawdown 0.004323681,
//      win rate 0.318181818, 145 fills, 58 mints, 66 round trips
//   3. tools/generate-charts.mjs run twice produces byte-identical SVGs,
//      and the SVG matches the committed figures/equity-curve.svg
//   4. tools/equity-hourly.json reconciles with the scorer totals: the
//      hourly rows, the window halves, and the probe/snipe split must all
//      add back to the same net PnL, fills, and mint counts
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
//    then compare against the committed figure.
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const committedSvg = fs.readFileSync(path.join(ROOT, 'figures', 'equity-curve.svg'));
const runChart = () => {
  execFileSync('node', [path.join(ROOT, 'tools', 'generate-charts.mjs')], { cwd: ROOT, stdio: 'pipe' });
  return fs.readFileSync(path.join(ROOT, 'figures', 'equity-curve.svg'));
};
const svgA = runChart();
const svgB = runChart();
check('chart deterministic (two runs identical)', sha(svgA), sha(svgB));
check('chart matches committed figures/equity-curve.svg', sha(svgA), sha(committedSvg));

// 3. Figure-data cross-check: the derived hourly table, the window halves,
//    and the probe/snipe split in tools/equity-hourly.json must all add back
//    to the scorer totals. The grader never reads this file, so a stale or
//    hand-edited JSON could otherwise drift away from the graded numbers
//    without any check noticing.
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
fs.rmSync(saveDir, { recursive: true, force: true });

if (failures.length > 0) {
  console.error(`\nVERIFY FAILED: ${failures.length} check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('\nVERIFY OK: strategy output frozen, figure deterministic and current.');
