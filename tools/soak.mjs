// soak.mjs — Clean Sharpe Sniper (v3 tooling).
//
// Soak test: run grade-local N times (default 3) into fresh temp dirs and
// assert action_log_sha256 is identical on every run. The action log is
// the frozen behaviour of the entry; result_sha256 is allowed to differ
// across Node versions (the kit says so itself — the local harness runs
// Node v24.22.1, the server runs v26.13.1), so only the action log hash
// is asserted here.
//
//   node tools/soak.mjs --kit <kit-root> [--bot <entry-dir>] [--runs 3]
//   # env (same as any kit command):
//   HTTPS_PROXY=http://hatch-egress-proxy:3128 HTTP_PROXY=http://hatch-egress-proxy:3128 \
//     NODE_USE_ENV_PROXY=1 NODE_EXTRA_CA_CERTS=/run/hatch/egress-tls/ca-bundle.pem \
//     NODE_OPTIONS=--max-old-space-size=2048 node tools/soak.mjs --kit <kit-root>
//
// Exit 0 when every run agrees; exit 1 on any mismatch or grade failure.
// Prints the hash of each run plus the Node version, so the README can
// record the soak result verbatim.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const kitIdx = args.indexOf('--kit');
if (kitIdx === -1 || !args[kitIdx + 1]) {
  console.error('usage: node tools/soak.mjs --kit <kit-root> [--bot <entry-dir>] [--runs 3]');
  process.exit(2);
}
const kit = path.resolve(args[kitIdx + 1]);
const botIdx = args.indexOf('--bot');
const bot = botIdx === -1 ? ROOT : path.resolve(args[botIdx + 1]);
const runsIdx = args.indexOf('--runs');
const runs = runsIdx === -1 ? 3 : Number(args[runsIdx + 1]);
if (!Number.isInteger(runs) || runs < 2) {
  console.error('FAIL: --runs must be an integer >= 2');
  process.exit(2);
}
if (!fs.existsSync(path.join(kit, 'cli', 'makefun.mjs'))) {
  console.error(`FAIL: no kit at ${kit} (expected cli/makefun.mjs inside it)`);
  process.exit(2);
}

console.log(`soak: ${runs} grade-local runs of ${bot} with kit ${kit}`);
console.log(`soak: node ${process.version}`);
const hashes = [];
for (let i = 1; i <= runs; i++) {
  const saveDir = fs.mkdtempSync(path.join(os.tmpdir(), `sharpe-soak-${i}-`));
  try {
    execFileSync(
      'node',
      ['cli/makefun.mjs', 'grade-local', '--kit', kit, '--bot', bot, '--driver', 'process', '--worktree', '--save', saveDir, '--json'],
      { cwd: kit, stdio: 'pipe', env: { ...process.env } },
    );
  } catch (e) {
    console.error(`FAIL  soak run ${i}: grade-local exited ${e.status}`);
    fs.rmSync(saveDir, { recursive: true, force: true });
    process.exit(1);
  }
  const result = JSON.parse(fs.readFileSync(path.join(saveDir, 'result.json'), 'utf8'));
  hashes.push(result.action_log_sha256);
  const l1 = result.l1 ? `, l1.reproduced ${result.l1.reproduced}` : '';
  console.log(`soak run ${i}/${runs}: action_log_sha256 ${result.action_log_sha256} (net PnL ${result.performance.metrics.net_pnl_lamports} lamports${l1})`);
  fs.rmSync(saveDir, { recursive: true, force: true });
}
const allSame = hashes.every((h) => h === hashes[0]);
if (!allSame) {
  console.error(`SOAK FAILED: action_log_sha256 differs across runs: ${[...new Set(hashes)].join(', ')}`);
  process.exit(1);
}
console.log(`\nSOAK OK: action_log_sha256 identical across ${runs} runs: ${hashes[0]} (node ${process.version})`);
