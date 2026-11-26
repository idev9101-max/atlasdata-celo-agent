import fs from 'node:fs';
import { createPublicClient, http } from 'viem';
import { celo } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';

const DEFAULT_URL = 'https://landingen24h.com/celo/ar/dolar';
const DEFAULT_RESULT_FILE = '/home/ubuntu/experiment/celo_x402_local_payment_result.json';
const TOKENS = {
  WARS: { address: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D', decimals: 18 },
  WBRL: { address: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', decimals: 18 },
  WMXN: { address: '0x337E7456B420bD3481e7FA61fA9850343d610d34', decimals: 18 },
  WCOP: { address: '0x8a1D45e102e886510e891d2Ec656a708991e2D76', decimals: 18 },
  CNGN: { address: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', decimals: 6 },
  IDRX: { address: '0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22', decimals: 2 },
  USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6 },
  USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6 },
  USAT: { address: '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771', decimals: 6 },
};

function usage() {
  console.log(`Usage:
  node src/x402_local_pay.mjs --url https://landingen24h.com/celo/ar/dolar --token WARS --max-atomic 15000000000000000000 --execute

Default mode is a probe. It fetches the 402 challenge, selects the requested token, creates and validates the x402 payment payload locally, and does not send it.
Options:
  --url URL             paid resource, default Argentina FX data endpoint
  --token SYMBOL        preferred token, default WARS
  --asset ADDRESS       preferred token contract, overrides --token
  --max-atomic N        hard spend cap in atomic units, required for --execute
  --method METHOD       HTTP method, default GET
  --body JSON           optional JSON request body for POST or PUT
  --execute             send the payment and record the paid response
  --result-file PATH    evidence JSON path
  --rpc URL             Celo RPC, default public Ankr RPC
`);
}

function parseArgs(argv) {
  const out = { url: DEFAULT_URL, token: 'WARS', method: 'GET', execute: false, rpc: 'https://rpc.ankr.com/celo', resultFile: DEFAULT_RESULT_FILE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') out.url = next();
    else if (a === '--token') out.token = next();
    else if (a === '--asset') out.asset = next();
    else if (a === '--max-atomic') out.maxAtomic = next();
    else if (a === '--method') out.method = next().toUpperCase();
    else if (a === '--body') out.body = next();
    else if (a === '--execute') out.execute = true;
    else if (a === '--result-file') out.resultFile = next();
    else if (a === '--rpc') out.rpc = next();
    else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function readEnvFile(path) {
  const out = {};
  if (!fs.existsSync(path)) return out;
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

function decodeBase64Json(value) {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
}

function paymentAmount(requirements) {
  return BigInt(requirements.amount ?? requirements.maxAmountRequired ?? '0');
}

function safeRequirements(requirements) {
  return {
    scheme: requirements.scheme,
    network: requirements.network,
    amount: requirements.amount,
    asset: requirements.asset,
    payTo: requirements.payTo,
    maxTimeoutSeconds: requirements.maxTimeoutSeconds,
    assetTransferMethod: requirements.extra?.assetTransferMethod || 'eip3009',
    assetName: requirements.extra?.name,
    assetVersion: requirements.extra?.version,
  };
}

function summarizePayload(paymentPayload) {
  const permit2 = paymentPayload.payload?.permit2Authorization;
  const eip2612 = paymentPayload.extensions?.eip2612GasSponsoring?.info;
  return {
    accepted: safeRequirements(paymentPayload.accepted || {}),
    payloadType: permit2 ? 'permit2' : 'eip3009',
    permit2: permit2 ? {
      from: permit2.from,
      token: permit2.permitted?.token,
      amount: permit2.permitted?.amount,
      spender: permit2.spender,
      witnessTo: permit2.witness?.to,
      validAfter: permit2.witness?.validAfter,
      deadline: permit2.deadline,
    } : null,
    eip2612GasSponsoring: eip2612 ? {
      from: eip2612.from,
      asset: eip2612.asset,
      spender: eip2612.spender,
      amount: eip2612.amount,
      deadline: eip2612.deadline,
    } : null,
    builderCodeInfo: paymentPayload.extensions?.['builder-code']?.info || null,
    extensionKeys: Object.keys(paymentPayload.extensions || {}),
    signatures: 'present but redacted',
  };
}

function writeEvidence(path, evidence) {
  fs.writeFileSync(path, JSON.stringify(evidence, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const token = TOKENS[String(args.token || '').toUpperCase()];
const preferredAsset = (args.asset || token?.address || '').toLowerCase();
if (!/^0x[0-9a-fA-F]{40}$/.test(preferredAsset)) throw new Error('pass a valid --token or --asset');
if (args.execute && !/^\d+$/.test(args.maxAtomic || '')) throw new Error('--max-atomic is required for --execute');
const maxAtomic = args.maxAtomic ? BigInt(args.maxAtomic) : null;

const secrets = readEnvFile('/home/ubuntu/.cdp/celo_hackathon_wallet.env');
let privateKey = process.env.CELO_PRIVATE_KEY || secrets.CELO_HACKATHON_PRIVATE_KEY || secrets.CELO_PRIVATE_KEY || secrets.PRIVATE_KEY;
if (!privateKey) throw new Error('missing Celo private key in environment or protected wallet file');
if (!privateKey.startsWith('0x')) privateKey = `0x${privateKey}`;
const account = privateKeyToAccount(privateKey);
const meta = readEnvFile('/home/ubuntu/.cdp/celo_hackathon.meta.env');
const tagCode = process.env.CELO_ATTRIBUTION_TAG || meta.CELO_ATTRIBUTION_TAG || 'celo_390c43b6bdd3';

const publicClient = createPublicClient({ chain: celo, transport: http(args.rpc) });
const signer = toClientEvmSigner(account, publicClient);

function selectPreferred(x402Version, accepts) {
  const selected = accepts.find((r) => r.network === 'eip155:42220' && r.asset?.toLowerCase() === preferredAsset)
    || accepts.find((r) => r.network === 'eip155:42220')
    || accepts[0];
  if (!selected) throw new Error('no payable x402 offer found');
  if (maxAtomic !== null && paymentAmount(selected) > maxAtomic) {
    throw new Error(`payment amount ${paymentAmount(selected)} exceeds max-atomic ${maxAtomic}`);
  }
  if (!maxAtomic && paymentAmount(selected) > 100000000000000000000n) {
    throw new Error('probe amount is unexpectedly large, pass --max-atomic explicitly');
  }
  return selected;
}

const client = new x402Client(selectPreferred)
  .register('eip155:42220', new ExactEvmScheme(signer, { rpcUrl: args.rpc }))
  .setSpendControls({ allowedAssets: true, maxAmountPerPayment: false });

client.registerExtension({
  key: 'builder-code',
  async enrichPaymentPayload(paymentPayload, paymentRequired) {
    if (!paymentRequired.extensions?.['builder-code']) return paymentPayload;
    const current = paymentPayload.extensions?.['builder-code'] || {};
    const info = { ...(current.info || {}), w: tagCode };
    return {
      ...paymentPayload,
      extensions: {
        ...(paymentPayload.extensions || {}),
        'builder-code': { ...current, info },
      },
    };
  },
});

const init = { method: args.method, headers: {} };
if (args.body !== undefined) {
  init.headers['content-type'] = 'application/json';
  init.body = args.body;
}

const initial = await fetch(args.url, init);
if (initial.status !== 402) {
  const text = await initial.text().catch(() => '');
  throw new Error(`expected 402 challenge, got ${initial.status}: ${text.slice(0, 300)}`);
}
const requiredHeader = initial.headers.get('payment-required');
if (!requiredHeader) throw new Error('402 response did not include PAYMENT-REQUIRED header');
const paymentRequired = decodeBase64Json(requiredHeader);
const matchingOffers = paymentRequired.accepts.filter((r) => r.network === 'eip155:42220' && r.asset?.toLowerCase() === preferredAsset);
if (matchingOffers.length === 0) throw new Error(`resource does not offer preferred asset ${preferredAsset}`);

const evidence = {
  mode: args.execute ? 'execute' : 'probe',
  startedAt: new Date().toISOString(),
  url: args.url,
  payer: account.address,
  preferredAsset,
  tagCode,
  offers: paymentRequired.accepts.map(safeRequirements),
};
writeEvidence(args.resultFile, evidence);

if (!args.execute) {
  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  evidence.probe = summarizePayload(paymentPayload);
  evidence.result = { status: 'probe-complete', paid: false, note: 'payload signed locally but intentionally not sent' };
  writeEvidence(args.resultFile, evidence);
  console.log(JSON.stringify(evidence.result, null, 2));
  console.log(JSON.stringify(evidence.probe, null, 2));
  process.exit(0);
}

const fetchWithPay = wrapFetchWithPayment(fetch, client);
const response = await fetchWithPay(args.url, init);
const bodyText = await response.text();
let body;
try { body = JSON.parse(bodyText); } catch { body = bodyText.slice(0, 10000); }
const settlementHeader = response.headers.get('payment-response');
evidence.response = {
  status: response.status,
  ok: response.ok,
  paymentResponseHeaderPresent: Boolean(settlementHeader),
  settlement: settlementHeader ? decodeBase64Json(settlementHeader) : null,
  body,
};
evidence.result = {
  status: response.ok ? 'paid' : 'payment-failed-or-resource-error',
  paid: response.ok,
  completedAt: new Date().toISOString(),
};
writeEvidence(args.resultFile, evidence);
console.log(JSON.stringify({ status: evidence.result.status, httpStatus: response.status, settlement: evidence.response.settlement }, null, 2));
if (!response.ok) process.exit(1);
