import { getIronSession, type IronSession, type SessionOptions } from "iron-session";

/**
 * Shape of the playground's server-side session.
 *
 * IMPORTANT: `secretKey` must NEVER be sent to the client. It exists only
 * so a route handler can sign a testnet transaction on the user's behalf
 * within a single request; it is read and written exclusively inside
 * server-side route handlers (iron-session cookies are encrypted, but the
 * discipline of "server-only" still matters — never echo this field back
 * in an API response body, and never pass it to a client component).
 */
export interface SessionData {
  publicKey?: string;
  secretKey?: string;
  /** Unix ms timestamp of when this session's keypair was created. */
  createdAt?: number;
  /** Literal for now — mainnet support is a later, separate decision. */
  network: "testnet";
}

export const THIRTY_MINUTES_IN_SECONDS = 1800;
export const THIRTY_MINUTES_IN_MS = THIRTY_MINUTES_IN_SECONDS * 1000;

/**
 * iron-session config for the playground session cookie.
 *
 * `secure` is gated on NODE_ENV because `secure: true` cookies are dropped
 * by browsers over plain http, which breaks local dev (http://localhost).
 */
const MIN_SESSION_SECRET_LENGTH = 32;

export function getIronSessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET;

  if (!password) {
    throw new Error(
      "SESSION_SECRET is not set. Copy .env.example to .env.local and set a random string " +
        "at least 32 characters long (see the comment above SESSION_SECRET in .env.example).",
    );
  }

  // iron-session itself enforces this minimum, but only inside session.save()/
  // destroy() deep in a request handler — a confusing place to first discover
  // a misconfigured secret. Checking it here, once, centrally, means a bad
  // SESSION_SECRET fails loudly the first time any route touches the session
  // (effectively at startup for most deployments) instead of intermittently
  // at request time.
  if (password.length < MIN_SESSION_SECRET_LENGTH) {
    throw new Error(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters long (got ${password.length}). ` +
        "Generate one with: openssl rand -base64 32",
    );
  }

  return {
    cookieName: "vellar_playground_session",
    password,
    cookieOptions: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: THIRTY_MINUTES_IN_SECONDS,
    },
  };
}

/**
 * Load the session for a given (request, response) pair.
 *
 * We use iron-session's `(req, res)` overload rather than `next/headers`'s
 * `cookies()` on purpose: `cookies()` only works when Next.js's own router
 * invokes the route handler, because it relies on Next's internal request
 * context (AsyncLocalStorage). That makes route handlers impossible to unit
 * test by direct invocation — the approach these routes are tested with
 * (constructing a `Request`/`Response` and calling the exported handler
 * function directly, per this repo's testing convention). iron-session's
 * `(req, res)` overload instead reads/writes cookies via the plain Web
 * `Request.headers` / `Response.headers` API, which works identically
 * whether Next.js's router calls the handler or a test does.
 *
 * Callers pass a scratch `Response` whose `Set-Cookie` header(s) they will
 * copy onto the real response they end up returning, so that
 * `session.save()` / `session.destroy()` end up setting `Set-Cookie` on the
 * response the caller actually sends.
 */
export async function getSession(req: Request, res: Response): Promise<IronSession<SessionData>> {
  return getIronSession<SessionData>(req, res, getIronSessionOptions());
}
