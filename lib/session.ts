import type { SessionOptions } from "iron-session";

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

const THIRTY_MINUTES_IN_SECONDS = 1800;

/**
 * iron-session config for the playground session cookie.
 *
 * `secure` is gated on NODE_ENV because `secure: true` cookies are dropped
 * by browsers over plain http, which breaks local dev (http://localhost).
 */
export function getIronSessionOptions(): SessionOptions {
  const password = process.env.SESSION_SECRET;

  if (!password) {
    throw new Error(
      "SESSION_SECRET is not set. Copy .env.example to .env.local and set a random string " +
        "at least 32 characters long (see the comment above SESSION_SECRET in .env.example).",
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
