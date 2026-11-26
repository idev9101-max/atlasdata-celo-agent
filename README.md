# AtlasData Celo Agent

AtlasData Celo Agent is a production x402 seller on Celo mainnet. It sells machine readable security and data endpoints payable per call in Celo USDC, USDT, or USAT. The production service is live at [x402atlas.xyz](https://x402atlas.xyz).

This repository is the hackathon reference implementation and operational evidence for the Celo Agents Open for Business program. The production mono repo is [idev9101-max/atlasdata](https://github.com/idev9101-max/atlasdata); this repository isolates the Celo integration so it is easy to review, run, and audit.

## Live production endpoints

Primary catalog entry:

```text
GET https://x402atlas.xyz/api/security/prompt-injection?text=hello
```

An unpaid request returns HTTP 402. In x402 v2 the machine readable payment requirements are in the base64 encoded `PAYMENT-REQUIRED` response header, not in the small JSON error body.

Validated with:

```bash
npx --yes @celo/buy@0.8.8 quote 'https://x402atlas.xyz/api/security/prompt-injection?text=hello'
```

Observed offers:

- 0.001 USDC on Celo mainnet, asset `0xcebA9300f2b948710d2653dD7B07f33A8B32118C`
- 0.001 USDT on Celo mainnet, asset `0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`
- 0.001 USAT on Celo mainnet, asset `0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771`

All three pay to `0x2632a66e376090565F84794705970B96E75C5C2A`.

## Discovery and identity

- ERC-8004 registration file: [agent.json](https://x402atlas.xyz/agent.json) and [/.well-known/agent.json](https://x402atlas.xyz/.well-known/agent.json)
- x402 catalog metadata: [/.well-known/x402](https://x402atlas.xyz/.well-known/x402)
- Terms and support: [x402atlas.xyz/terms](https://x402atlas.xyz/terms)
- Buy catalog pull request: [celo-org/buy-skill#89](https://github.com/celo-org/buy-skill/pull/89)
- agent402.tools origin registration submitted for `https://x402atlas.xyz`

The ERC-8004 registration transaction is prepared in `src/register_erc8004.mjs`. It appends the assigned attribution tag `celo_390c43b6bdd3` with `@celo/attribution-tags` and can pay gas through the documented Celo USDC fee adapter. It is not run in this repository because running it spends real chain funds.

## What is implemented here

`src/server.py` is a minimal FastAPI x402 seller implementing the production prompt injection scanner. It uses:

- the official Python x402 SDK
- Celo hosted facilitator `https://api.x402.celo.org`
- x402 v2 payment requirements
- the x402 Bazaar discovery extension
- the x402 builder code extension declaring `celo_390c43b6bdd3`
- Celo USDC, USDT, and USAT asset amount offers

The scanner itself is deterministic heuristic computation operated by AtlasData. It does not resell a third party API.

## Run locally

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
export X402_CELO_API_KEY=your_facilitator_key
export CELO_PAY_TO=0x2632a66e376090565F84794705970B96E75C5C2A
uvicorn src.server:app --host 0.0.0.0 --port 8000
```

Then request:

```bash
curl -i 'http://localhost:8000/api/security/prompt-injection?text=hello'
```

## Walkthrough media

- [Walkthrough video](https://github.com/idev9101-max/atlasdata-celo-agent/blob/main/assets/walkthrough.mp4)
- [Product verification screenshot](https://github.com/idev9101-max/atlasdata-celo-agent/blob/main/assets/product-screenshot.png)
- [Logo](https://github.com/idev9101-max/atlasdata-celo-agent/blob/main/assets/logo.png)

## Hackathon status

Completed:

1. Celo x402 seller integration is live in production.
2. Three stablecoin payment offers validate with `@celo/buy`.
3. Terms, support, catalog metadata, and ERC-8004 registration file are public.
4. Buy catalog listing PR is open.
5. agent402.tools registration is pending background verification.
6. The x402 responses declare the assigned builder code for future facilitator side Schema 2 settlement tags.

Pending because the hackathon faucet backend is currently unfunded:

1. ERC-8004 identity registration transaction.
2. First tagged transaction visible in the Loops checker.
3. Updating `agent.json` with the returned `agentId` and calling `setAgentURI` if needed.

The faucet failure was reported publicly at [priveedores-de-solucione/faucetdrops-backend#1](https://github.com/priveedores-de-solucione/faucetdrops-backend/issues/1). No government identity faucet was used.

## Support

Email: atlasdataeb5a87@fldubai.com

Production operator: AtlasData Agent, transparent software project identity rather than a fake human identity.
