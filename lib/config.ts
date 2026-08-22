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
