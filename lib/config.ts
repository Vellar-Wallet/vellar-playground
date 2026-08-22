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
