/**
 * Testnet Stellar helpers: fund a fresh keypair via friendbot, and read a
 * live XLM balance from Horizon. Both talk to the public Stellar testnet
 * infrastructure directly over `fetch` — no SDK server client needed for
 * these two reads.
 *
 * Every function here throws plain `Error`s with a technical message. Route
 * handlers are responsible for catching those, logging the detail with
 * `console.error`, and turning them into human-readable responses — nothing
 * in this file should ever be surfaced verbatim to an HTTP caller.
 */

const FRIENDBOT_URL = "https://friendbot.stellar.org/";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const FRIENDBOT_TIMEOUT_MS = 10_000;

/**
 * Fund `publicKey` via testnet friendbot. Resolves on success; throws on any
 * non-2xx response, network error, or timeout (10s). Callers should treat all
 * three failure modes identically — a fresh, unfunded key with no session
 * written — per the spec.
 */
export async function fundWithFriendbot(publicKey: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`, {
      signal: AbortSignal.timeout(FRIENDBOT_TIMEOUT_MS),
    });
  } catch (err) {
    // Covers both network errors and the AbortSignal.timeout() abort.
    throw new Error(`friendbot request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`friendbot returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Read the current native (XLM) balance for `publicKey` from Horizon.
 * Returns the balance as a string (Horizon's own decimal-string format, e.g.
 * "10000.0000000") to avoid float precision loss — callers that need a
 * number can parse it themselves.
 */
export async function getXlmBalance(publicKey: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(publicKey)}`, {
      signal: AbortSignal.timeout(FRIENDBOT_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`horizon request failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`horizon returned HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const account = (await res.json()) as {
    balances?: Array<{ asset_type: string; balance: string }>;
  };
  const native = account.balances?.find((b) => b.asset_type === "native");
  if (!native) {
    throw new Error("horizon account response had no native balance entry");
  }
  return native.balance;
}
