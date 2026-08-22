/**
 * Provision a session wallet with testnet USDC: open a trustline, then buy
 * `targetAmountAtomic`'s worth on the testnet DEX, paying in the wallet's
 * own XLM (friendbot-funded by the caller before this runs).
 *
 * Ported from vellar-facilitator/examples/provision-testnet.mjs's USE_USDC
 * path (see that file's `acquireOnDex` + `submit`), with two deliberate
 * departures documented inline below: classic Horizon instead of Soroban RPC
 * (required — see CRITICAL note on `submitClassic`), and a proportionally
 * scaled `sendMax` + a tighter timeout ceiling sized for a single HTTP
 * request rather than a long-running CLI script.
 *
 * Every failure mode here is EXPECTED and non-exceptional (no DEX path, a
 * submit failure, a timeout) — this module never throws. It always resolves
 * to a discriminated result so the caller (POST /api/session/create) can
 * degrade gracefully: the wallet's XLM funding already succeeded and must
 * not be undone by a secondary provisioning step failing.
 */

import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { FALLBACK_USDC_TARGET_ATOMIC, SELLER_URL, USDC_ISSUER } from "@/lib/config";
import { fetchCatalog, findResourcePrice, CatalogFetchError } from "@/lib/catalog";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = Networks.TESTNET;

// Bounded ceiling per classic operation (trustline open, DEX purchase).
//
// The reference script (provision-testnet.mjs) talks to SOROBAN RPC, whose
// `sendTransaction` is fire-and-forget — the caller must poll
// `getTransaction` separately, up to 45x at 1.5s (~67s) per op. Classic
// HORIZON is different: `Horizon.Server#submitTransaction` blocks until the
// transaction is included (or rejected) in one call, so no separate poll
// loop is needed here. The bound that matters for classic submission is the
// transaction envelope's own `.setTimeout()` — how long Horizon will keep
// retrying inclusion before giving up and returning an expired-envelope
// error. 35s per operation (~70s worst case across the trustline + purchase
// pair) is tighter than the reference script's ~67s *per op* ceiling, sized
// for two sequential operations inside one HTTP request rather than a
// long-running CLI script.
const SUBMIT_TIMEOUT_SECONDS = 35; // tx envelope's own `.setTimeout()`, in seconds
const HORIZON_FETCH_TIMEOUT_MS = 15_000;

/**
 * XLM cap per unit of USDC bought, in the `pathPaymentStrictReceive`'s
 * `sendMax`. The reference script observed ~0.559 XLM per USDC on the live
 * testnet DEX (2026-08-12) and capped at a flat 5000 XLM for a 100-USDC
 * target (50 XLM/unit, ~90x the observed price). This wallet's target is far
 * smaller (~0.5-5 USDC, see lib/config.ts's FALLBACK_USDC_TARGET_ATOMIC and
 * the 5x-catalog-price rule in session/create), so a flat 5000 XLM cap would
 * be absurdly loose relative to the target and could in the worst case eat
 * half the ~10,000 XLM friendbot grant on a single runaway fill.
 *
 * Instead we scale the cap with the target: 250 XLM per USDC unit (~450x the
 * observed price — generous headroom against a thin order book) times the
 * number of USDC units being bought. For the documented target range
 * (0.5-5 USDC) that's 125-1250 XLM, comfortably inside the 10,000 XLM grant
 * with plenty left over, while still failing the op outright rather than
 * draining the wallet if the market is genuinely broken.
 */
const XLM_PER_USDC_UNIT_CAP = 250;

const USDC_DECIMALS = 7;
// BigInt(10) ** BigInt(n), not a `10n` literal — this repo's tsconfig target
// (ES2017, Next.js's create-next-app default) predates BigInt literal syntax
// even though BigInt itself is fully supported at runtime by every Node
// version this app targets. Scoped to this file rather than bumping the
// whole app's compilation target for one module's convenience.
const ATOMIC_SCALE = BigInt(10) ** BigInt(USDC_DECIMALS);

export type ProvisionUsdcResult =
  | { ok: true; balanceUsdc: string }
  | { ok: false; reason: string };

/** Format an atomic (7-decimal) amount as the decimal string the Stellar SDK
 *  expects for `Operation.pathPaymentStrictReceive`'s `destAmount`/`amount`
 *  fields (e.g. "0.5000000" -> destAmount "0.5"). */
function atomicToDecimalString(atomic: bigint): string {
  const whole = atomic / ATOMIC_SCALE;
  const frac = atomic % ATOMIC_SCALE;
  if (frac === BigInt(0)) return whole.toString();
  const fracStr = frac.toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${whole.toString()}.${fracStr}`;
}

/** Ceiling-round `atomic` up to the nearest whole USDC unit, as an integer
 *  (used only to size the XLM sendMax cap — rounding up here is the safe
 *  direction, since it only makes the cap more generous, never tighter). */
function atomicToWholeUnitsCeil(atomic: bigint): bigint {
  return (atomic + ATOMIC_SCALE - BigInt(1)) / ATOMIC_SCALE;
}

/**
 * Build, sign, and submit a classic (non-Soroban) transaction via Horizon,
 * then poll until it's confirmed.
 *
 * CRITICAL: this deliberately uses classic `Horizon.Server` +
 * `TransactionBuilder`, NOT this repo's usual Soroban-RPC surface
 * (`server.prepareTransaction`) — Soroban RPC's `prepareTransaction` rejects
 * classic operations like `changeTrust` and `pathPaymentStrictReceive`
 * outright ("unsupported operation type"). See
 * vellar-facilitator/examples/provision-testnet.mjs's `submit()` comment.
 */
async function submitClassic(
  horizon: Horizon.Server,
  kp: Keypair,
  ops: ReturnType<typeof Operation.changeTrust | typeof Operation.pathPaymentStrictReceive>[],
  label: string,
): Promise<{ ok: true; hash: string } | { ok: false; reason: string }> {
  try {
    const account = await horizon.loadAccount(kp.publicKey());
    let txBuilder = new TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase: PASSPHRASE,
    });
    for (const op of ops) txBuilder = txBuilder.addOperation(op);
    const tx = txBuilder.setTimeout(SUBMIT_TIMEOUT_SECONDS).build();
    tx.sign(kp);

    const sent = await horizon.submitTransaction(tx);
    if (!sent.successful) {
      console.error(`provisionUsdc: ${label} submit was not successful:`, JSON.stringify(sent));
      return { ok: false, reason: `${label} did not settle` };
    }
    return { ok: true, hash: sent.hash };
  } catch (err) {
    console.error(`provisionUsdc: ${label} failed:`, err);
    return { ok: false, reason: `${label} failed` };
  }
}

const DEMO_RESOURCE_URL = `${SELLER_URL.replace(/\/+$/, "")}/quote`;
const FUNDING_MULTIPLE = BigInt(5);

/**
 * Decide how much USDC (atomic, 7 decimals) to provision a fresh session
 * wallet with: 5x the demo seller's current live price, read from the
 * facilitator's own catalog, so a user can try paying a few times. Falls
 * back to `FALLBACK_USDC_TARGET_ATOMIC` (also a 5x multiple, of the seller's
 * documented default price) if the catalog fetch fails, times out, or hasn't
 * cataloged the demo resource yet — a hiccup in this lookup must not block
 * wallet creation entirely. Never throws.
 */
export async function determineUsdcFundingTarget(): Promise<string> {
  try {
    const catalog = await fetchCatalog();
    const price = findResourcePrice(catalog, DEMO_RESOURCE_URL);
    if (price && /^\d+$/.test(price.amountAtomic)) {
      const target = (BigInt(price.amountAtomic) * FUNDING_MULTIPLE).toString();
      console.log(`determineUsdcFundingTarget: using live catalog price — target ${target} atomic`);
      return target;
    }
    console.log(
      "determineUsdcFundingTarget: demo resource not found in catalog (or unusable price) — using fallback target",
    );
  } catch (err) {
    const reason =
      err instanceof CatalogFetchError ? `${err.code}${err.timedOut ? " (timeout)" : ""}` : String(err);
    console.log(`determineUsdcFundingTarget: catalog lookup failed (${reason}) — using fallback target`);
  }
  return FALLBACK_USDC_TARGET_ATOMIC;
}

/**
 * Provision `keypair`'s account with USDC: open a trustline to Circle's
 * testnet USDC issuer, then buy `targetAmountAtomic` (a base-10 atomic
 * string, 7 decimals) worth of it via a strict-receive path payment funded
 * by the wallet's own XLM.
 *
 * Never throws. Returns `{ ok: false, reason }` (a short, client-safe
 * string — never a raw SDK error) for any expected failure: bad trustline,
 * no DEX path, failed purchase, or a bound-exceeding delay. Full detail is
 * always logged server-side via console.error first.
 *
 * On success, re-reads the account's real USDC balance from Horizon rather
 * than assuming the requested `destAmount` landed exactly — strict-receive
 * fills should match the requested amount exactly by construction, but we
 * verify against live chain state regardless rather than trusting the
 * request parameters.
 */
export async function provisionUsdc(
  keypair: Keypair,
  targetAmountAtomic: string,
): Promise<ProvisionUsdcResult> {
  if (!/^\d+$/.test(targetAmountAtomic) || BigInt(targetAmountAtomic) <= BigInt(0)) {
    console.error(`provisionUsdc: invalid targetAmountAtomic "${targetAmountAtomic}"`);
    return { ok: false, reason: "invalid funding target" };
  }

  const horizon = new Horizon.Server(HORIZON_URL);
  const asset = new Asset("USDC", USDC_ISSUER);
  const targetAtomic = BigInt(targetAmountAtomic);
  const destAmount = atomicToDecimalString(targetAtomic);

  // 1. Open the trustline.
  const trustlineResult = await submitClassic(
    horizon,
    keypair,
    [Operation.changeTrust({ asset })],
    "USDC trustline",
  );
  if (!trustlineResult.ok) {
    return { ok: false, reason: "couldn't open a USDC trustline" };
  }

  // 2. Find a route and buy destAmount of USDC, paying in XLM.
  //
  // @stellar/stellar-sdk@16.2.0 type bug: `Horizon.Server#strictReceivePaths`
  // is declared to return `PathCallBuilder` (the builder behind the
  // deprecated `.paths()` / destination-account-based search), but at
  // runtime it actually constructs and returns `StrictReceivePathCallBuilder`
  // (source-assets-array based) — see that class's own JSDoc: "Do not create
  // this object directly, use Horizon.Server.strictReceivePaths." Both
  // classes extend the same `CallBuilder<CollectionPage<PaymentPathRecord>>`,
  // so `.call()`'s resolved value has the correct real shape (`.records`
  // exists) regardless — only the intermediate builder's declared type name
  // is wrong, and `StrictReceivePathCallBuilder` itself isn't cleanly
  // re-exported from the package root to cast through. Type the awaited
  // `.call()` result directly against the shape both builders actually share
  // (`ServerApi.CollectionPage<ServerApi.PaymentPathRecord>`) instead.
  let path: Asset[];
  try {
    const paths = (await horizon
      .strictReceivePaths([Asset.native()], asset, destAmount)
      .call()) as unknown as Horizon.ServerApi.CollectionPage<Horizon.ServerApi.PaymentPathRecord>;
    if (!paths.records.length) {
      console.error(`provisionUsdc: no XLM->USDC DEX path for destAmount=${destAmount}`);
      return { ok: false, reason: "no USDC market route available on testnet right now" };
    }
    path = paths.records[0].path.map((p) =>
      p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code!, p.asset_issuer!),
    );
  } catch (err) {
    console.error("provisionUsdc: strictReceivePaths lookup failed:", err);
    return { ok: false, reason: "couldn't look up a USDC purchase route" };
  }

  const wholeUnitsCap = atomicToWholeUnitsCeil(targetAtomic);
  const sendMax = String(Number(wholeUnitsCap) * XLM_PER_USDC_UNIT_CAP);

  const purchaseResult = await submitClassic(
    horizon,
    keypair,
    [
      Operation.pathPaymentStrictReceive({
        sendAsset: Asset.native(),
        sendMax,
        destination: keypair.publicKey(),
        destAsset: asset,
        destAmount,
        path,
      }),
    ],
    "USDC purchase",
  );
  if (!purchaseResult.ok) {
    return { ok: false, reason: "couldn't buy USDC on the testnet market" };
  }

  // 3. Re-read the real balance from Horizon rather than assuming destAmount
  //    landed exactly.
  try {
    const account = await fetchAccountWithTimeout(keypair.publicKey());
    const line = account.balances?.find(
      (b) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER,
    );
    if (!line) {
      console.error("provisionUsdc: purchase submitted successfully but no USDC balance line found afterward");
      return { ok: false, reason: "USDC purchase didn't complete as expected" };
    }
    return { ok: true, balanceUsdc: line.balance };
  } catch (err) {
    console.error("provisionUsdc: post-purchase balance read failed:", err);
    return { ok: false, reason: "USDC purchase may have succeeded, but we couldn't confirm the balance" };
  }
}

async function fetchAccountWithTimeout(
  publicKey: string,
): Promise<{ balances?: Array<{ asset_code?: string; asset_issuer?: string; balance: string }> }> {
  const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(publicKey)}`, {
    signal: AbortSignal.timeout(HORIZON_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`horizon returned HTTP ${res.status}`);
  }
  return res.json();
}
