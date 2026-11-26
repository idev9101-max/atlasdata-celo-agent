import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const DEFAULT_URL = 'https://landingen24h.com/celo/ar/dolar';
const RESULT_FILE = '/home/ubuntu/experiment/celo_corridor_job_result.json';

function usage() {
  console.log(`Usage:
  node src/corridor_job.mjs --execute

Default mode is a full dry run: Textile USDT to wARS preview plus a locally signed, unsent x402 wARS payment payload for Argentine FX data.
Options:
  --sell TOKEN          source token, default USDT
  --buy TOKEN           local corridor token, default WARS
  --amount DECIMAL      conversion amount, default 1
  --url URL             paid x402 resource, default Argentina FX endpoint
  --max-atomic N        hard x402 payment cap, default current ar-data price of 15 wARS
  --execute             perform the real conversion and payment
`);
}

function parseArgs(argv) {
  const out = { sell: 'USDT', buy: 'WARS', amount: '1', url: DEFAULT_URL, maxAtomic: '15000000000000000000', execute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--sell') out.sell = next();
    else if (a === '--buy') out.buy = next();
    else if (a === '--amount') out.amount = next();
    else if (a === '--url') out.url = next();
    else if (a === '--max-atomic') out.maxAtomic = next();
    else if (a === '--execute') out.execute = true;
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function run(label, argv) {
  const startedAt = new Date().toISOString();
  const child = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 240000 });
  const result = { label, argv, startedAt, status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr };
  if (child.error) result.error = String(child.error.message || child.error);
  if (child.status !== 0) {
    const error = new Error(`${label} failed with status ${child.status}`);
    error.details = result;
    throw error;
  }
  return result;
}

function readJson(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

const args = parseArgs(process.argv.slice(2));
const conversionEvidence = '/home/ubuntu/experiment/celo_textile_execution_result.json';
const paymentEvidence = '/home/ubuntu/experiment/celo_x402_local_payment_result.json';
for (const path of [conversionEvidence, paymentEvidence]) {
  try { fs.unlinkSync(path); } catch {}
}

const textileArgs = [
  'src/textile_payout.mjs',
  '--sell', args.sell,
  '--buy', args.buy,
  '--amount', args.amount,
  '--result-file', conversionEvidence,
];
if (args.execute) textileArgs.push('--execute', '--conversion-only');

const paymentArgs = [
  'src/x402_local_pay.mjs',
  '--url', args.url,
  '--token', args.buy,
  '--max-atomic', args.maxAtomic,
  '--result-file', paymentEvidence,
];
if (args.execute) paymentArgs.push('--execute');

const combined = {
  mode: args.execute ? 'execute' : 'dry-run',
  startedAt: new Date().toISOString(),
  job: {
    conversion: `${args.amount} ${args.sell} to ${args.buy}`,
    paidResource: args.url,
    paymentCapAtomic: args.maxAtomic,
  },
  steps: {},
};

try {
  combined.steps.textile = { process: run('textile conversion', textileArgs), evidence: readJson(conversionEvidence) };
  combined.steps.x402Payment = { process: run('x402 local payment', paymentArgs), evidence: readJson(paymentEvidence) };
  const conversionResult = combined.steps.textile.evidence.result || {};
  const paymentResult = combined.steps.x402Payment.evidence.result || {};
  combined.result = {
    status: args.execute ? 'corridor-job-complete' : 'corridor-job-dry-run-complete',
    conversionStatus: conversionResult.status || combined.steps.textile.evidence.preview?.status || null,
    paymentStatus: paymentResult.status,
    conversionTxHash: conversionResult.conversionTxHash || null,
    paymentTxHash: paymentResult.paymentTxHash || paymentResult.txHash || null,
    outsideRecipient: combined.steps.x402Payment.evidence.probe?.accepted?.payTo || combined.steps.x402Payment.evidence.offers?.[0]?.payTo || null,
    completedAt: new Date().toISOString(),
  };
} catch (error) {
  combined.result = { status: 'failed', error: String(error.message || error), details: error.details || null, completedAt: new Date().toISOString() };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(combined, null, 2));
  console.error(JSON.stringify(combined.result, null, 2));
  process.exit(1);
}

fs.writeFileSync(RESULT_FILE, JSON.stringify(combined, null, 2));
console.log(JSON.stringify(combined.result, null, 2));
