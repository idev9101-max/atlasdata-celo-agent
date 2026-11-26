import fs from 'node:fs';
import { createPublicClient, createWalletClient, http, encodeFunctionData, concat, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { celo } from 'viem/chains';
import { toDataSuffix } from '@celo/attribution-tags';

function readEnvFile(path) {
  const out = {};
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return out;
}

const secrets = readEnvFile('/home/ubuntu/.cdp/celo_hackathon_wallet.env');
const meta = readEnvFile('/home/ubuntu/.cdp/celo_hackathon.meta.env');
const key = secrets.PRIVATE_KEY || secrets.CELO_PRIVATE_KEY || secrets.KEY;
if (!key) throw new Error('missing private key env name');
const tagCode = meta.CELO_ATTRIBUTION_TAG || 'celo_390c43b6bdd3';
const agentURI = process.env.AGENT_URI || 'https://x402atlas.xyz/agent.json';
const identityRegistry = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const abi = [
  { type: 'function', name: 'register', stateMutability: 'nonpayable', inputs: [{ name: 'agentURI', type: 'string' }], outputs: [{ name: 'agentId', type: 'uint256' }] },
  { type: 'event', name: 'Registered', inputs: [
    { name: 'agentId', type: 'uint256', indexed: true },
    { name: 'agentURI', type: 'string' },
    { name: 'owner', type: 'address', indexed: true },
  ] },
];

const account = privateKeyToAccount(key.startsWith('0x') ? key : '0x' + key);
const transport = http('https://forno.celo.org');
const publicClient = createPublicClient({ chain: celo, transport });
const walletClient = createWalletClient({ account, chain: celo, transport });
const callData = encodeFunctionData({ abi, functionName: 'register', args: [agentURI] });
const suffix = toDataSuffix(tagCode);
const data = concat([callData, suffix]);
const tx = {
  account,
  to: identityRegistry,
  data,
};
if ((process.env.FEE_CURRENCY || 'usdc').toLowerCase() !== 'celo') {
  tx.feeCurrency = '0x2F25deB3848C207fc8E0c34035B3Ba7fC157602B';
}
console.log(JSON.stringify({ account: account.address, agentURI, tagCode, feeCurrency: tx.feeCurrency || 'CELO' }));
const hash = await walletClient.sendTransaction(tx);
console.log(JSON.stringify({ hash }));
const receipt = await publicClient.waitForTransactionReceipt({ hash });
const events = parseEventLogs({ abi, eventName: 'Registered', logs: receipt.logs });
const agentId = events[0]?.args?.agentId?.toString();
console.log(JSON.stringify({ status: receipt.status, hash, agentId, blockNumber: receipt.blockNumber.toString() }));
if (agentId) fs.writeFileSync('/home/ubuntu/experiment/celo8004/registration_result.json', JSON.stringify({ hash, agentId, agentURI, blockNumber: receipt.blockNumber.toString() }, null, 2));
