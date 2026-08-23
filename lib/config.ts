/**
 * Central place to read env-configured target URLs. Import these instead of
 * scattering `process.env.FACILITATOR_URL` reads across route handlers.
 *
 * Defaults point at the hosted testnet demo so the playground works out of
 * the box without any env setup beyond SESSION_SECRET.
 */

export const FACILITATOR_URL =
  process.env.FACILITATOR_URL ?? "https://vellar-facilitator.onrender.com";

export const SELLER_URL = process.env.SELLER_URL ?? "https://vellar-seller-demo.onrender.com";

/**
 * Canonical testnet USDC — Circle's testnet issuer (home_domain centre.io).
 * Same asset the demo seller (`SELLER_URL`/quote) charges in. See
 * vellar-facilitator/examples/provision-testnet.mjs's USE_USDC block for why
 * USDC specifically: auth_required=false (permissionless trustlines) and a
 * live testnet DEX market, so a session wallet can acquire it with no faucet
 * and no human step.
 */
export const USDC_ISSUER =
  process.env.USDC_ISSUER ?? "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/**
 * The demo seller's own default price (examples/seller.mjs's PRICE_ATOMIC
 * default) times 5 — used only as a fallback funding target when the live
 * catalog lookup fails or hasn't cataloged the demo resource yet. See
 * lib/stellar.ts's `provisionUsdc` for where this is used.
 */
export const FALLBACK_USDC_TARGET_ATOMIC = "5000000"; // 0.5 USDC (7 decimals)

/**
 * Bond escrow contract — deployed on Stellar testnet from original source
 * (`contracts/bond-escrow/` in vellar-facilitator), documented in that
 * repo's `docs/bond-escrow-deployment.md`. `/bond` (this app) is a
 * read-only explainer page: it never writes to this contract or holds any
 * key for it, it only links to/reads public state. Kept here (rather than
 * a separate `lib/bond-info.ts`) because it's exactly the same shape as
 * the constants above it — a handful of literal strings, no logic — so a
 * new file would just be an extra hop for no separation benefit.
 */
export const BOND_ESCROW_CONTRACT_ID =
  "CAWQ2FJDPWHOFLYQIPKBU4M6IE4GUROKUKVVZERWQVD2DHP7S2CULTI4";

/** sha256 of the deployed wasm — see docs/bond-escrow-deployment.md's
 *  "Verify the build yourself" section for the three independent ways
 *  this was cross-checked before being treated as trustworthy. */
export const BOND_ESCROW_WASM_HASH =
  "21e4a128423f8d4246951812a4fd6cb3811ba30b100c73e912b4febc7ffd949c";

export const STELLAR_EXPERT_TESTNET_CONTRACT_URL = `https://stellar.expert/explorer/testnet/contract/${BOND_ESCROW_CONTRACT_ID}`;

export function stellarExpertTestnetTxUrl(hash: string): string {
  return `https://stellar.expert/explorer/testnet/tx/${hash}`;
}

/**
 * The proven entry-point sequence from the bond-escrow deployment record —
 * every hash here is Horizon-confirmed `successful: true` (re-checked live
 * against Horizon while building this page; see the task report for which
 * ones and what they returned). `finalize`'s response window on this
 * testnet deployment is 5 minutes (`PLACEHOLDER_RESPONSE_WINDOW_SECONDS`,
 * contracts/bond-escrow/src/lib.rs:235) — an explicit placeholder for
 * exercising the full lifecycle in real ledger minutes, not the ~24h this
 * design argues a real deployment should use before pubnet.
 */
export const BOND_SEQUENCE = [
  {
    step: 1,
    entryPoint: "initialize",
    txHash: "9d5959c6f3a9c8ace42c5c8bf2868c77a5a7e11e926eab20c80bb225e8ab6674",
    ledger: 4264791,
    summary: "Admin set",
  },
  {
    step: 2,
    entryPoint: "deposit",
    txHash: "8384117524622650103263b70eefdea24e16c24ca81a53cfdf37523da8b17a6f",
    ledger: 4264793,
    summary: "400,000 atomic USDC (0.04 USDC) bonded",
  },
  {
    step: 3,
    entryPoint: "set_delivery_key",
    txHash: "325ee05c349b55f7a98623a8cd57cd2046547107dfff1439834ac37178bf9c72",
    ledger: 4264795,
    summary: "Seller's delivery-signing pubkey registered",
  },
  {
    step: 4,
    entryPoint: "register_settlement",
    txHash: "972d1379aca6b461efa7004cdeeb6aaef6ee4debbd9fd919c46ff61b3790ed8a",
    ledger: 4264797,
    summary: "250,000 atomic (0.025 USDC) settlement registered",
  },
  {
    step: 5,
    entryPoint: "file_dispute",
    txHash: "ecf12e792d8eee7b65cdeb656ba1dac27087a4ebb5602c53866b9eb0fcc54749",
    ledger: 4264799,
    summary: "Dispute opened",
  },
  {
    step: 6,
    entryPoint: "finalize",
    txHash: "f6b516bd0cc7cfcf208e7d25676797aa43d651db81abdeb24ee0b84c7317cfae",
    ledger: 4264867,
    summary: "Slash executed after the response window elapsed (real ~5m30s wait, no receipt posted)",
  },
] as const;
