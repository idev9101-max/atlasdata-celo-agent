import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  http,
  toHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { toDataSuffix } from '@celo/attribution-tags';

const API = 'https://api.textilecredit.com/v2';
const CHAIN_ID = 42220;
const FEE_ADAPTERS = {
  usdc: '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B',
  usdt: '0x0E2A3e05bc9A16F5292A6170456A710cb89C6f72',
  usat: '0x0357EE22278c922e1D36cFe6b899269b161880C4',
};
const DEFAULT_RESULT_FILE = '/home/ubuntu/experiment/celo_textile_execution_result.json';

const TOKENS = {
  USDC: { address: '0xcebA9300f2b948710d2653dD7B07f33A8B32118C', decimals: 6 },
  USDT: { address: '0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e', decimals: 6 },
  USAT: { address: '0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771', decimals: 6 },
  CNGN: { address: '0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f', decimals: 6 },
  IDRX: { address: '0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22', decimals: 2 },
  WARS: { address: '0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D', decimals: 18 },
  WBRL: { address: '0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0', decimals: 18 },
  WMXN: { address: '0x337E7456B420bD3481e7FA61fA9850343d610d34', decimals: 18 },
  WCOP: { address: '0x8a1D45e102e886510e891d2Ec656a708991e2D76', decimals: 18 },
};

function usage() {
  console.log(`Usage:
  node src/textile_payout.mjs --sell USDT --buy WBRL --amount 1.25 --recipient 0x... --payout-amount 5 --execute

Defaults are a safe dry run. Without --execute this only calls the free RFQ preview.
Options:
  --sell TOKEN             sell token, default USDT
  --buy TOKEN              buy token, default WBRL
  --amount DECIMAL         exact-input sell amount
  --buy-amount DECIMAL     exact-output buy amount, mutually exclusive with --amount
  --recipient ADDRESS      outside recipient for the local stablecoin payout
  --payout-amount DECIMAL  exact local stablecoin amount to pay recipient
  --payout-all             pay the full received buy-token amount
  --execute                request a firm quote and broadcast transactions
  --result-file PATH       execution evidence JSON path
  --rpc URL                Celo RPC, default public Ankr RPC
  --fee-currency celo|usdc|usdt|usat gas currency, default auto
`);
}

function parseArgs(argv) {
  const out = { sell: 'USDT', buy: 'WBRL', execute: false, payoutAll: false, rpc: 'https://rpc.ankr.com/celo', resultFile: DEFAULT_RESULT_FILE };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--sell') out.sell = next();
    else if (a === '--buy') out.buy = next();
    else if (a === '--amount') out.amount = next();
    else if (a === '--buy-amount') out.buyAmount = next();
    else if (a === '--recipient') out.recipient = next();
    else if (a === '--payout-amount') out.payoutAmount = next();
    else if (a === '--payout-all') out.payoutAll = true;
    else if (a === '--execute') out.execute = true;
    else if (a === '--result-file') out.resultFile = next();
    else if (a === '--rpc') out.rpc = next();
    else if (a === '--fee-currency') out.feeCurrency = next();
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

function normalizeSymbol(symbol) {
  return String(symbol || '').toUpperCase().replace('₮', 'T');
}

function decimalToAtomic(value, decimals) {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`invalid positive decimal amount: ${text}`);
  const [whole, frac = ''] = text.split('.');
  if (frac.length > decimals) throw new Error(`too many decimal places for ${decimals}-decimal token`);
  const base = 10n ** BigInt(decimals);
  return (BigInt(whole) * base + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')).toString();
}

function atomicToDecimal(value, decimals) {
  const v = BigInt(value);
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : whole.toString();
}

async function postJson(path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(75_000),
  });
  let json;
  try { json = await res.json(); } catch { json = { raw: await res.text().catch(() => '') }; }
  return { status: res.status, ok: res.ok, json };
}

async function signTakerControl(account, chainId) {
  const nonce = toHex(crypto.randomBytes(32));
  const issuedAt = Date.now();
  const signature = await account.signTypedData({
    domain: { name: 'Textile Taker Control', version: '1', chainId },
    types: {
      TakerControl: [
        { name: 'taker', type: 'address' },
        { name: 'chainId', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'issuedAt', type: 'uint256' },
      ],
    },
    primaryType: 'TakerControl',
    message: {
      taker: account.address,
      chainId: BigInt(chainId),
      nonce,
      issuedAt: BigInt(issuedAt),
    },
  });
  return { nonce, issuedAt, signature };
}

function txValue(value) {
  if (value === undefined || value === null) return 0n;
  return BigInt(value);
}

function writeEvidence(path, evidence) {
  fs.writeFileSync(path, JSON.stringify(evidence, null, 2));
}

const args = parseArgs(process.argv.slice(2));
const sellKey = normalizeSymbol(args.sell);
const buyKey = normalizeSymbol(args.buy);
const sell = TOKENS[sellKey];
const buy = TOKENS[buyKey];
if (!sell || !buy) throw new Error(`unsupported token, use one of ${Object.keys(TOKENS).join(', ')}`);
if (sell.address.toLowerCase() === buy.address.toLowerCase()) throw new Error('sell and buy token must differ');
if (args.amount && args.buyAmount) throw new Error('send either --amount or --buy-amount, not both');
if (!args.amount && !args.buyAmount) args.amount = '1';

const secrets = readEnvFile('/home/ubuntu/.cdp/celo_hackathon_wallet.env');
const privateKey = process.env.CELO_PRIVATE_KEY || secrets.PRIVATE_KEY || secrets.CELO_PRIVATE_KEY || secrets.CELO_HACKATHON_PRIVATE_KEY || secrets.KEY;
if (!privateKey) throw new Error('missing Celo private key in environment or protected wallet file');
const account = privateKeyToAccount(privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`);
const meta = readEnvFile('/home/ubuntu/.cdp/celo_hackathon.meta.env');
const tagCode = process.env.CELO_ATTRIBUTION_TAG || meta.CELO_ATTRIBUTION_TAG || 'celo_390c43b6bdd3';
const dataSuffix = toDataSuffix(tagCode);

const transport = http(args.rpc);
const publicClient = createPublicClient({ chain: celo, transport });
const walletClient = createWalletClient({ account, chain: celo, transport });

const request = { chainId: CHAIN_ID, sellToken: sell.address, buyToken: buy.address };
if (args.amount) request.sellAmount = decimalToAtomic(args.amount, sell.decimals);
else request.buyAmount = decimalToAtomic(args.buyAmount, buy.decimals);

const preview = await postJson('/rfq/preview', request);
if (!preview.ok) throw new Error(`preview failed ${preview.status}: ${JSON.stringify(preview.json).slice(0, 500)}`);
const previewData = preview.json.data || preview.json;
const dryOutput = {
  mode: 'dry-run',
  account: account.address,
  corridor: `${sellKey}/${buyKey}`,
  request,
  preview: previewData,
  executeHint: 'add --execute, --recipient, and --payout-amount or --payout-all',
};
if (!args.execute) {
  console.log(JSON.stringify(dryOutput, null, 2));
  process.exit(0);
}

if (!/^0x[0-9a-fA-F]{40}$/.test(args.recipient || '')) throw new Error('--recipient must be a checksummed or lowercase EVM address outside the team');
if (!args.payoutAll && !args.payoutAmount) throw new Error('set --payout-amount or --payout-all for execution');
if (args.recipient.toLowerCase() === account.address.toLowerCase()) throw new Error('recipient must be outside the team, not the agent wallet');

const firmRequest = { ...request, taker: account.address };
let firm = await postJson('/rfq/request', firmRequest);
if (firm.status === 401) {
  const reason = firm.json?.error?.details?.reason || firm.json?.details?.reason;
  if (reason !== 'proof_of_control_required') throw new Error(`firm quote unauthorized: ${JSON.stringify(firm.json).slice(0, 500)}`);
  firm = await postJson('/rfq/request', { ...firmRequest, takerProof: await signTakerControl(account, CHAIN_ID) });
}
if (!firm.ok) throw new Error(`firm quote failed ${firm.status}: ${JSON.stringify(firm.json).slice(0, 700)}`);
const rfq = firm.json.data || firm.json;
if (rfq.status !== 'quoted') throw new Error(`RFQ is not quoted: ${rfq.status || 'unknown'} ${rfq.noQuoteReason || ''}`);
if (!rfq.claimToken || !rfq.rfqId || !rfq.transactions?.swap) throw new Error('firm quote response missing rfqId, claimToken, or transactions.swap');

const quote = rfq.quote || {};
const expiresAtMs = Date.parse(quote.expiresAt || '');
if (expiresAtMs && Date.now() > expiresAtMs - 3000) throw new Error('quote is expired or too close to expiry to execute safely');

const nativeBalance = await publicClient.getBalance({ address: account.address });
const stableBalances = {};
for (const symbol of ['USDC', 'USDT', 'USAT']) {
  stableBalances[symbol] = await publicClient.readContract({
    address: TOKENS[symbol].address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [account.address],
  });
}
const requestedFee = (args.feeCurrency || '').toLowerCase();
let feeToken = null;
if (requestedFee && requestedFee !== 'celo') {
  if (!FEE_ADAPTERS[requestedFee]) throw new Error(`unsupported fee currency ${requestedFee}`);
  feeToken = requestedFee.toUpperCase();
} else if (!requestedFee && nativeBalance === 0n) {
  feeToken = ['USDC', 'USDT', 'USAT'].find((symbol) => stableBalances[symbol] > 0n) || null;
}
const feeFields = feeToken ? { feeCurrency: FEE_ADAPTERS[feeToken.toLowerCase()] } : {};

const evidence = {
  mode: 'execute',
  startedAt: new Date().toISOString(),
  account: account.address,
  recipient: args.recipient,
  corridor: `${sellKey}/${buyKey}`,
  request,
  rfqId: rfq.rfqId,
  claimToken: rfq.claimToken,
  status: rfq.status,
  quote,
  tagCode,
  feeCurrency: feeToken ? FEE_ADAPTERS[feeToken.toLowerCase()] : 'CELO',
  transactions: {},
};
writeEvidence(args.resultFile, evidence);

async function sendAndWait(tx, label, tagged = false) {
  const data = tx.data && tagged ? concat([tx.data, dataSuffix]) : tx.data;
  const hash = await walletClient.sendTransaction({
    account,
    to: tx.to,
    data,
    value: txValue(tx.value),
    ...feeFields,
  });
  evidence.transactions[label] = { hash, tagged, broadcastAt: new Date().toISOString() };
  writeEvidence(args.resultFile, evidence);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  evidence.transactions[label].receiptStatus = receipt.status;
  evidence.transactions[label].blockNumber = receipt.blockNumber.toString();
  writeEvidence(args.resultFile, evidence);
  if (receipt.status !== 'success') throw new Error(`${label} transaction reverted: ${hash}`);
  return { hash, receipt };
}

const sellBefore = await publicClient.readContract({ address: sell.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
const buyBefore = await publicClient.readContract({ address: buy.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
evidence.balancesBefore = {
  sellToken: sellBefore.toString(),
  buyToken: buyBefore.toString(),
  native: nativeBalance.toString(),
  usdc: stableBalances.USDC.toString(),
  usdt: stableBalances.USDT.toString(),
  usat: stableBalances.USAT.toString(),
};
writeEvidence(args.resultFile, evidence);

const reactor = quote.reactor || rfq.transactions?.approval?.to;
const takerPays = BigInt(quote.takerPays || request.sellAmount || '0');
if (!reactor || !takerPays) throw new Error('quote missing reactor or takerPays');
const allowance = await publicClient.readContract({
  address: sell.address,
  abi: erc20Abi,
  functionName: 'allowance',
  args: [account.address, reactor],
});
if (allowance < takerPays) {
  if (!rfq.transactions.approval) throw new Error('approval needed but quote did not provide transactions.approval');
  await sendAndWait(rfq.transactions.approval, 'approval', false);
} else {
  evidence.transactions.approval = { skipped: true, allowance: allowance.toString(), takerPays: takerPays.toString() };
}

await sendAndWait(rfq.transactions.swap, 'textileSwap', true);

const submit = await postJson(`/rfq/${rfq.rfqId}/submit`, { txHash: evidence.transactions.textileSwap.hash }, { 'X-Rfq-Claim': rfq.claimToken });
evidence.submit = { status: submit.status, body: submit.json };
writeEvidence(args.resultFile, evidence);

const sellAfter = await publicClient.readContract({ address: sell.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
const buyAfter = await publicClient.readContract({ address: buy.address, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
const received = buyAfter > buyBefore ? buyAfter - buyBefore : 0n;
evidence.balancesAfterSwap = { sellToken: sellAfter.toString(), buyToken: buyAfter.toString(), receivedBuyToken: received.toString(), receivedBuyTokenDecimal: atomicToDecimal(received, buy.decimals) };
if (received <= 0n) throw new Error('swap completed but no buy-token balance increase detected');

let payoutAtomic;
if (args.payoutAll) payoutAtomic = received;
else payoutAtomic = BigInt(decimalToAtomic(args.payoutAmount, buy.decimals));
if (payoutAtomic <= 0n || payoutAtomic > received) throw new Error(`payout amount ${payoutAtomic} is not within received amount ${received}`);

const transferData = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [args.recipient, payoutAtomic] });
await sendAndWait({ to: buy.address, data: transferData, value: '0' }, 'localStablecoinPayout', true);

evidence.result = {
  status: 'complete',
  completedAt: new Date().toISOString(),
  conversionTxHash: evidence.transactions.textileSwap.hash,
  payoutTxHash: evidence.transactions.localStablecoinPayout.hash,
  payoutAmount: payoutAtomic.toString(),
  payoutAmountDecimal: atomicToDecimal(payoutAtomic, buy.decimals),
  payoutToken: buyKey,
  recipient: args.recipient,
};
writeEvidence(args.resultFile, evidence);
console.log(JSON.stringify(evidence.result, null, 2));
