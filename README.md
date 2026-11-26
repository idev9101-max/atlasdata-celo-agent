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

Stablecoin corridor endpoints added during the hackathon:

```text
GET https://x402atlas.xyz/api/fx/textile-quote?sell_token=USDT&buy_token=cNGN&amount=1
GET https://x402atlas.xyz/api/fx/corridors
```

These endpoints are designed for the Stablecoin Corridors track. The quote endpoint converts agent friendly token symbols and decimal amounts into Textile FX v2 RFQ preview input on Celo mainnet, then returns normalized indicative pricing, fee, available sell liquidity, supported token metadata, and corridor metadata. It is paid per call through the same x402 offers and is registered in x402scan. Textile FX is clearly attributed as the upstream source. The preview is indicative, not a firm executable quote.

The corridor directory exposes the Celo mainnet token map for settlement assets USDC, USDT, and USAT plus local stablecoins cNGN, IDRX, wARS, wBRL, wMXN, and wCOP. It documents exact-input and exact-output parameter rules for agents. It is live as a 0.001 USDC, USDT, or USAT x402 resource. The corridor endpoints also advertise approximate local-currency x402 offers in wARS, wBRL, wMXN, and wCOP through the Celo facilitator Permit2 rail, with EIP-2612 gas sponsorship declared.

Direct upstream preview probes on 2026-11-26 returned `preview` for USDT to cNGN, IDRX, wARS, wBRL, and wCOP, and for cNGN to USDT. USDT to wMXN returned `no_quote` at probe time. Liquidity is dynamic, so agents should query the live endpoint rather than treating that matrix as a guarantee.

Validation examples:

```bash
npx --yes @celo/buy@0.8.8 quote 'https://x402atlas.xyz/api/fx/textile-quote?sell_token=USDT&buy_token=cNGN&amount=1'
npx --yes @celo/buy@0.8.8 quote 'https://x402atlas.xyz/api/fx/corridors'
```

All three Celo payment assets pay to `0x2632a66e376090565F84794705970B96E75C5C2A`.

## Discovery and identity

- ERC-8004 registration file: [agent.json](https://x402atlas.xyz/agent.json) and [/.well-known/agent.json](https://x402atlas.xyz/.well-known/agent.json)
- x402 catalog metadata: [/.well-known/x402](https://x402atlas.xyz/.well-known/x402)
- Terms and support: [x402atlas.xyz/terms](https://x402atlas.xyz/terms)
- Buy catalog pull request: [celo-org/buy-skill#89](https://github.com/celo-org/buy-skill/pull/89)
- agent402.tools origin registration submitted for `https://x402atlas.xyz`

The ERC-8004 registration transaction is prepared in `src/register_erc8004.mjs`. It appends the assigned attribution tag `celo_390c43b6bdd3` with `@celo/attribution-tags` and can pay gas through the documented Celo USDC fee adapter. It is not run in this repository because running it spends real chain funds.

## Textile execution and payout script

`src/textile_payout.mjs` is the operational conversion and local-stablecoin payout path. It implements the Textile RFQ v2 flow rather than only quoting it:

1. Reads the protected Celo agent key locally without printing it.
2. Calls the free RFQ preview in dry-run mode.
3. On explicit `--execute`, sends a firm RFQ request and signs the documented EIP-712 `Textile Taker Control` proof only if the venue asks for it.
4. Stores the one-time claim token in the local evidence file, broadcasts `transactions.swap` rather than the unsafe top-level single-order fields, and appends the Celo attribution suffix to the conversion transaction.
5. Reports the swap hash to Textile with `X-Rfq-Claim`.
6. Pays a configurable outside recipient in the received local stablecoin with a second tagged transfer.

The script was validated in two safe modes on 2026-11-26. Dry-run preview for 1 USDT to wBRL returned status `preview` and normalized buy amount metadata. A firm request test signed the EIP-712 proof successfully and progressed to Textile's explicit `insufficient_funds` response because the new agent wallet still holds zero USDT. No transaction was broadcast. Execution remains intentionally blocked until first wallet funding.

Dry run:

```bash
npm install
npm run textile:payout -- --sell USDT --buy WBRL --amount 1
```

Execution shape, only after funding and with a real outside recipient:

```bash
npm run textile:payout -- --sell USDT --buy WBRL --amount 1 --recipient 0xRecipientOutsideTeam --payout-amount 1 --execute
```

## What is implemented here

`src/server.py` is a minimal FastAPI x402 seller implementing the production prompt injection scanner. It uses:

- the official Python x402 SDK
- Celo hosted facilitator `https://api.x402.celo.org`
- x402 v2 payment requirements
- the x402 Bazaar discovery extension
- the x402 builder code extension declaring `celo_390c43b6bdd3`
- Celo USDC, USDT, and USAT asset amount offers
- Permit2 local-currency offers in wARS, wBRL, wMXN, and wCOP on corridor routes

The scanner itself is deterministic heuristic computation operated by AtlasData. It does not resell a third party API. The production service also exposes the corridor quote adapter described above, which clearly identifies Textile FX as its upstream data source and adds machine friendly normalization for agents.

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
7. A Celo stablecoin corridor quote endpoint is live and registered on x402scan.
8. A low-cost corridor directory endpoint is live and validated with `@celo/buy`.

Pending because the hackathon faucet backend is currently unfunded:

1. ERC-8004 identity registration transaction.
2. First tagged transaction visible in the Loops checker. The conversion/payout execution script is implemented and proof-of-control validated, but it cannot broadcast until the wallet is funded.
3. Updating `agent.json` with the returned `agentId` and calling `setAgentURI` if needed.

The faucet failure was reported publicly at [priveedores-de-solucione/faucetdrops-backend#1](https://github.com/priveedores-de-solucione/faucetdrops-backend/issues/1). No government identity faucet was used.

## Support

Email: atlasdataeb5a87@fldubai.com

Production operator: AtlasData Agent, transparent software project identity rather than a fake human identity.
