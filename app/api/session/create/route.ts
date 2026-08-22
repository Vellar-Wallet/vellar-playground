import { Keypair } from "@stellar/stellar-sdk";
import { getClientIp } from "@/lib/ip";
import {
  clearActiveSessionForIp,
  getActiveSessionForIp,
  setActiveSessionForIp,
  walletCreationLimiter,
} from "@/lib/rate-limit";
import { getSession, THIRTY_MINUTES_IN_MS } from "@/lib/session";
import { fundWithFriendbot, getUsdcBalance, getXlmBalance } from "@/lib/stellar";
import { buyUsdc, determineUsdcFundingTarget, openUsdcTrustline } from "@/lib/usdc";

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------
//
// This route now always streams, whichever of the three server-side cases it
// hits (existing valid session cookie / IP-tracked session reuse / genuine
// new-wallet provisioning) — one response shape for every case, rather than
// branching between a single JSON body and a stream depending on which case
// fired. The two fast-path cases just emit a single immediate "complete"
// event instead of the 4-step sequence a fresh wallet goes through; this
// keeps the client parsing exactly one contract regardless of path.
//
// Format: newline-delimited JSON (NDJSON), one event object per line,
// `Content-Type: application/x-ndjson`. NDJSON was chosen over full SSE
// (`data: ...\n\n` framing + `text/event-stream`) because there's no need
// here for SSE's reconnect/event-id/multi-field machinery — this is a single
// one-shot POST, read to completion by a normal `fetch().body` reader, not a
// long-lived `EventSource` subscription. Plain newline-delimited JSON is the
// simplest thing that is still trivially streamable and parseable line by
// line client-side.
//
// Every event is one of:
//   {"step": "keypair" | "friendbot" | "trustline" | "usdc_purchase",
//    "status": "active" | "done" | "error" | "skipped",
//    "message"?: string}
//   {"step": "complete", "status": "done",
//    "result": {publicKey, balanceXlm, usdcProvisioned, balanceUsdc?}}
//   {"step": "complete", "status": "error", "error": string, "message": string}
//
// "skipped" is used (not "error") for the two steps that degrade gracefully
// (trustline/usdc_purchase) when the *wallet itself* still succeeds — this
// mirrors the existing `usdcProvisioned: false` field, just expressed as a
// step status instead of a boolean on the final payload. A hard, stream-
// ending failure (bad body, rate limit, friendbot failure) is instead a
// "complete" event with status "error", so the client only ever needs to
// watch for one terminal event type ("complete") to know the stream is done,
// successfully or not.
//
// JUDGMENT CALL — why "keypair" and "friendbot" aren't emitted *live*:
// HTTP response headers (including Set-Cookie) must be sent atomically
// before the body starts streaming; they cannot be appended mid-stream. This
// route only knows whether to write a session cookie once friendbot funding
// has actually succeeded (per the existing, deliberate "no cookie for an
// unfunded wallet" rule — see the friendbot failure branch below). So
// keypair generation and the friendbot call are `await`ed up front, still
// inside this same POST handler, *before* the ReadableStream/Response is
// constructed — their "active"/"done" events are captured into a small
// buffer and replayed as the very first bytes of the stream. Every step
// AFTER that point (USDC trustline, USDC purchase) involves no further
// cookie writes, so those genuinely stream live, one real Horizon round trip
// at a time, exactly as they resolve. In short: keypair+friendbot happen
// fast (friendbot is typically sub-second to a few seconds) and are
// buffer-then-flushed for correctness; trustline+purchase (the slower,
// multi-second classic-Horizon submissions) are genuinely live. The
// dev-server curl evidence in this step's report demonstrates the real gaps
// between the trustline/usdc_purchase events landing over time.
//
// SECURITY: the secret key is generated, used to sign USDC operations, and
// saved into the (encrypted) session cookie — it is never placed into any
// event object at any point. See session.secret-leak.test.ts, which reads
// the full stream and asserts this across every emitted line, not just the
// final one.
// ---------------------------------------------------------------------------

type StepName = "keypair" | "friendbot" | "trustline" | "usdc_purchase";
type StepStatus = "active" | "done" | "error" | "skipped";

interface StepEvent {
  step: StepName;
  status: StepStatus;
  message?: string;
}

interface CompleteResult {
  publicKey: string;
  balanceXlm: string;
  usdcProvisioned: boolean;
  balanceUsdc?: string;
}

interface CompleteDoneEvent {
  step: "complete";
  status: "done";
  result: CompleteResult;
}

interface CompleteErrorEvent {
  step: "complete";
  status: "error";
  error: string;
  message: string;
}

type StreamEvent = StepEvent | CompleteDoneEvent | CompleteErrorEvent;

// POST /api/session/create takes no meaningful body. Reject anything over a
// small cap fast, before any other work (keypair generation, friendbot call,
// etc.) — this is cheap insurance against someone pointing a large-body
// request at this route to waste server time/bandwidth.
const MAX_BODY_BYTES = 1024;

function isSessionExpired(createdAt: number | undefined, now: number): boolean {
  if (!createdAt) return true;
  return now - createdAt > THIRTY_MINUTES_IN_MS;
}

/**
 * Reads the request body defensively: rejects anything over MAX_BODY_BYTES,
 * and — if a body IS present — requires it to be either empty or a trivial
 * JSON object (`{}` or absent), so a malformed/oversized payload never
 * reaches keypair generation or a friendbot call. Returns `null` when the
 * body is acceptable, or an { error, message, status } triple to fail fast
 * with (before the stream even opens) when it is not.
 */
async function rejectBadBody(
  req: Request,
): Promise<{ status: number; error: string; message: string } | null> {
  const contentLength = req.headers.get("content-length");
  if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
    return {
      status: 413,
      error: "payload_too_large",
      message: "That request looks too large for this endpoint. Please try again without a request body.",
    };
  }

  // Content-Length can be absent or wrong (chunked transfer, a lying client),
  // so also bound what we actually read regardless of the header.
  const text = await req.text().catch(() => null);
  if (text === null) {
    return { status: 400, error: "bad_request", message: "We couldn't read your request. Please try again." };
  }
  if (text.length > MAX_BODY_BYTES) {
    return {
      status: 413,
      error: "payload_too_large",
      message: "That request looks too large for this endpoint. Please try again without a request body.",
    };
  }
  if (text.trim().length === 0) {
    return null; // no body — the expected case
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      status: 400,
      error: "invalid_body",
      message: "Your request body isn't valid JSON. This endpoint doesn't need a request body — try sending none.",
    };
  }
  const isTrivialObject =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  if (!isTrivialObject) {
    return {
      status: 400,
      error: "invalid_body",
      message: "This endpoint doesn't expect a request body. Please try again without one.",
    };
  }
  return null;
}

/**
 * Read the wallet's current live USDC state from Horizon for the response.
 * Used on both fast-path cases (existing session, IP-tracked session reuse)
 * so the client always sees real on-chain truth rather than a cached "did
 * provisioning succeed at creation time" flag — USDC balance isn't persisted
 * anywhere in the session/tracker, deliberately: re-querying Horizon is the
 * same pattern balanceXlm already uses, and it stays correct even if the
 * wallet's USDC balance changes after a payment.
 */
async function usdcResponseFields(publicKey: string): Promise<{ usdcProvisioned: boolean; balanceUsdc?: string }> {
  try {
    const balance = await getUsdcBalance(publicKey);
    return balance !== null ? { usdcProvisioned: true, balanceUsdc: balance } : { usdcProvisioned: false };
  } catch (err) {
    console.error("usdcResponseFields: USDC balance lookup failed:", err);
    return { usdcProvisioned: false };
  }
}

const NDJSON_HEADERS: HeadersInit = {
  "content-type": "application/x-ndjson; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

function jsonError(status: number, error: string, message: string, extraHeaders?: HeadersInit) {
  return Response.json({ error, message }, { status, headers: extraHeaders });
}

/** Serializes one event exactly as it appears on the wire (see the module doc comment). */
function encodeEvent(event: StreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

export async function POST(req: Request): Promise<Response> {
  const badBody = await rejectBadBody(req);
  if (badBody) return jsonError(badBody.status, badBody.error, badBody.message);

  const ip = getClientIp(req);
  const now = Date.now();

  // Scratch response purely to give getSession/session.save() somewhere to
  // write Set-Cookie; its headers get copied onto the streamed Response
  // headers below, once we know their final value (see the module doc
  // comment on why keypair+friendbot are awaited up front rather than
  // streamed live).
  const scratch = new Response(null);
  const session = await getSession(req, scratch);

  const encoder = new TextEncoder();
  // Events already known/emitted before the stream opens — replayed as the
  // first bytes so the client sees the identical event sequence it would
  // see if these steps really had been streamed live.
  const preamble: StreamEvent[] = [];

  // ---------------------------------------------------------------------
  // Case 1: the requester already has a valid, non-expired session cookie
  // themselves. That cookie already IS their session — hand back its data
  // rather than minting a second wallet. No cookie write, no multi-step
  // provisioning — a single immediate complete event is the whole stream.
  // ---------------------------------------------------------------------
  if (session.publicKey && session.secretKey && !isSessionExpired(session.createdAt, now)) {
    const balanceXlm = await getXlmBalance(session.publicKey).catch(() => null);
    const usdc = await usdcResponseFields(session.publicKey);
    const body = encodeEvent({
      step: "complete",
      status: "done",
      result: { publicKey: session.publicKey, balanceXlm: balanceXlm ?? "0", ...usdc },
    });
    return new Response(encoder.encode(body), { status: 200, headers: new Headers(NDJSON_HEADERS) });
  }

  // ---------------------------------------------------------------------
  // Case 2: no valid cookie, but this IP already has another active,
  // non-expired session tracked server-side (different browser/incognito
  // tab/cleared cookies). Re-issue a cookie for that existing wallet
  // instead of minting a new one.
  // ---------------------------------------------------------------------
  const tracked = getActiveSessionForIp(ip);
  if (tracked && !isSessionExpired(tracked.createdAt, now)) {
    session.publicKey = tracked.publicKey;
    session.secretKey = tracked.secretKey;
    session.createdAt = tracked.createdAt;
    session.network = "testnet";
    await session.save();

    const balanceXlm = await getXlmBalance(tracked.publicKey).catch(() => null);
    const usdc = await usdcResponseFields(tracked.publicKey);
    const body = encodeEvent({
      step: "complete",
      status: "done",
      result: { publicKey: tracked.publicKey, balanceXlm: balanceXlm ?? "0", ...usdc },
    });
    const headers = new Headers(NDJSON_HEADERS);
    for (const cookie of scratch.headers.getSetCookie()) headers.append("set-cookie", cookie);
    return new Response(encoder.encode(body), { status: 200, headers });
  }
  if (tracked) {
    // Was tracked but expired — stop tracking it so it doesn't linger.
    clearActiveSessionForIp(ip);
  }

  // ---------------------------------------------------------------------
  // Case 3: genuinely minting a new wallet for this IP. Only now does the
  // 5-per-hour creation limit apply.
  // ---------------------------------------------------------------------
  const limit = walletCreationLimiter.check(ip);
  if (!limit.allowed) {
    const body = encodeEvent({
      step: "complete",
      status: "error",
      error: "rate_limited",
      message: "You've made a lot of requests recently. Please wait a few minutes and try again.",
    });
    return new Response(encoder.encode(body), {
      status: 200,
      headers: new Headers({ ...NDJSON_HEADERS, "Retry-After": String(limit.retryAfterSeconds) }),
    });
  }

  // Step 1: keypair generation (synchronous, instant — still buffered for a
  // consistent event sequence).
  preamble.push({ step: "keypair", status: "active" });
  const keypair = Keypair.random();
  const publicKey = keypair.publicKey();
  const secretKey = keypair.secret();
  preamble.push({ step: "keypair", status: "done" });

  // Step 2: friendbot funding, awaited here (not streamed live) because the
  // session cookie can only be written once this succeeds — see the module
  // doc comment. A failure here ends the whole request with an error and, as
  // before, writes NO session cookie for an unfunded wallet.
  preamble.push({ step: "friendbot", status: "active" });
  try {
    await fundWithFriendbot(publicKey);
  } catch (err) {
    console.error("friendbot funding failed:", err);
    preamble.push({ step: "friendbot", status: "error", message: "Funding failed." });
    preamble.push({
      step: "complete",
      status: "error",
      error: "funding_failed",
      message: "We couldn't fund a new testnet wallet right now. Please try again in a moment.",
    });
    const body = preamble.map(encodeEvent).join("");
    return new Response(encoder.encode(body), { status: 200, headers: new Headers(NDJSON_HEADERS) });
  }
  preamble.push({ step: "friendbot", status: "done" });

  let balanceXlm: string;
  try {
    balanceXlm = await getXlmBalance(publicKey);
  } catch (err) {
    // The wallet WAS funded (friendbot succeeded) — this is just the
    // read-back failing. Still don't block the user on it; fall back to a
    // sensible default rather than failing an otherwise-successful create.
    console.error("horizon balance lookup failed after funding:", err);
    balanceXlm = "10000.0000000";
  }

  session.publicKey = publicKey;
  session.secretKey = secretKey;
  session.createdAt = now;
  session.network = "testnet";
  await session.save();

  setActiveSessionForIp(ip, { publicKey, secretKey, createdAt: now });

  const headers = new Headers(NDJSON_HEADERS);
  for (const cookie of scratch.headers.getSetCookie()) headers.append("set-cookie", cookie);

  // From here on, headers are already finalized (the cookie is set) — the
  // remaining two steps (USDC trustline, USDC purchase) genuinely stream
  // live, one real Horizon round trip at a time, since no further cookie
  // writes are needed.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      function emit(event: StreamEvent) {
        controller.enqueue(encoder.encode(encodeEvent(event)));
      }

      // Replay the buffered pre-stream events first.
      for (const event of preamble) emit(event);

      try {
        // Steps 3 & 4: USDC provisioning (trustline, then DEX purchase) —
        // secondary steps on top of an already-successful wallet creation.
        // The XLM funding above is this endpoint's core promise, and a USDC
        // hiccup at either step must not undo it or fail the whole stream:
        // both degrade to a "skipped" step status and the stream still ends
        // in a successful "complete" event, same as the prior
        // `usdcProvisioned: false` JSON field.
        emit({ step: "trustline", status: "active" });
        const target = await determineUsdcFundingTarget();
        const trustline = await openUsdcTrustline(keypair);
        if (!trustline.ok) {
          console.error(`USDC trustline did not complete for ${publicKey}: ${trustline.reason}`);
          emit({ step: "trustline", status: "skipped", message: trustline.reason });
          emit({ step: "usdc_purchase", status: "skipped", message: "No trustline to buy against." });
          emit({
            step: "complete",
            status: "done",
            result: { publicKey, balanceXlm, usdcProvisioned: false },
          });
          controller.close();
          return;
        }
        emit({ step: "trustline", status: "done" });

        emit({ step: "usdc_purchase", status: "active" });
        const purchase = await buyUsdc(keypair, target);
        if (!purchase.ok) {
          console.error(`USDC purchase did not complete for ${publicKey}: ${purchase.reason}`);
          emit({ step: "usdc_purchase", status: "skipped", message: purchase.reason });
          emit({
            step: "complete",
            status: "done",
            result: { publicKey, balanceXlm, usdcProvisioned: false },
          });
          controller.close();
          return;
        }
        emit({ step: "usdc_purchase", status: "done" });

        emit({
          step: "complete",
          status: "done",
          result: { publicKey, balanceXlm, usdcProvisioned: true, balanceUsdc: purchase.balanceUsdc },
        });
        controller.close();
      } catch (err) {
        console.error("POST /api/session/create stream failed:", err);
        try {
          emit({
            step: "complete",
            status: "error",
            error: "internal_error",
            message: "Something went wrong, please try again in a moment.",
          });
        } catch {
          // controller may already be closed/errored — nothing more to do.
        }
        controller.close();
      }
    },
  });

  return new Response(stream, { status: 200, headers });
}
