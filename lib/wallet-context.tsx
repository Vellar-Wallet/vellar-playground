"use client";

// ---------------------------------------------------------------------------
// Shared wallet context — lifts wallet creation/restore/disconnect state out
// of individual page components (it used to live independently in both
// app/(dashboard)/page.tsx and app/(dashboard)/catalog/page.tsx, each with
// its own createWallet/restore logic, completely out of sync with each
// other) into one provider mounted once at the (dashboard) layout level.
//
// WHY THIS EXISTS: Next.js App Router route groups keep a shared layout
// mounted across sibling navigations, but each PAGE component still
// unmounts/remounts on navigation. Wallet state living in a page component
// meant navigating away and back reset it to "idle" every time, forcing a
// real POST /api/session/create round-trip just to redisplay the SAME
// wallet that was already on screen a moment ago — the exact "why do I have
// to wait for that loading of the wallet data" complaint. Moving it up to
// the layout-level provider means it survives every in-app navigation.
//
// CACHED-FIRST RENDER: vellar.session (localStorage) already holds
// publicKey/balanceXlm/balanceUsdc from the last time a wallet was
// confirmed. On mount, if that cache exists, this provider renders a
// "cached" wallet state IMMEDIATELY (no network wait) while a real
// POST /api/session/create quietly confirms/refreshes it in the background
// — same fast-path the server already had, just not blocking the UI on it
// this time. "cached" is a deliberately distinct status from "ready" (not
// just reusing "ready" with stale data): the UI can show a quiet "syncing"
// cue rather than silently presenting unconfirmed data as confirmed, same
// honesty standard the rest of this app holds itself to elsewhere.
//
// HYDRATION SAFETY: the cached-read must NOT happen in a useState lazy
// initializer (`useState(() => readSession())`) — that runs during the
// component's first render, including the SERVER render, which has no
// localStorage and always sees empty state, producing a real hydration
// mismatch (this exact bug was hit and fixed earlier in this app's own
// history, on /quest and /status). Server-matching empty default via plain
// useState, populated for real in a mount effect (which only ever runs
// client-side, after hydration has already reconciled) — same established
// pattern this app already uses in those two places.
// ---------------------------------------------------------------------------

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { clearAll, readSession, writeSession } from "@/lib/local-storage";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";

export interface WalletState {
  publicKey: string;
  balanceXlm: string;
  usdcProvisioned: boolean;
  balanceUsdc?: string;
}

type StepName = "keypair" | "friendbot" | "trustline" | "usdc_purchase";
type StepStatus = "pending" | "active" | "done" | "error" | "skipped";

export const WALLET_STEP_ORDER: StepName[] = ["keypair", "friendbot", "trustline", "usdc_purchase"];
export const WALLET_STEP_LABELS: Record<StepName, string> = {
  keypair: "Generating your Stellar keypair",
  friendbot: "Funding with testnet XLM",
  trustline: "Opening USDC trustline",
  usdc_purchase: "Buying testnet USDC",
};

export type WalletStepMap = Record<StepName, StepStatus>;

function initialSteps(): WalletStepMap {
  return { keypair: "pending", friendbot: "pending", trustline: "pending", usdc_purchase: "pending" };
}

export type WalletStage =
  | { status: "idle" }
  | { status: "restoring" }
  // Cached display data from a prior session, shown immediately on mount
  // while a real fetch quietly confirms it — see the module doc comment's
  // CACHED-FIRST RENDER section. usdcProvisioned is always assumed true
  // here (the cache has no such field) since a "ready" wallet is virtually
  // always fully provisioned; the background confirm corrects this if not.
  | { status: "cached"; wallet: WalletState }
  | { status: "loading"; startedAt: number; steps: WalletStepMap }
  | { status: "ready"; wallet: WalletState }
  | { status: "error"; message: string; steps?: WalletStepMap };

function parseStreamLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface WalletContextValue {
  wallet: WalletStage;
  /** Seconds elapsed since wallet creation/restore started — 0 when not loading. */
  elapsed: number;
  createWallet: (mode?: "button" | "restore") => Promise<void>;
  /** Full disconnect: destroys the server-side session (DELETE /api/session
   *  — the real source of truth for the secret key, not just hidden from
   *  view) and clears every vellar.* localStorage key. Same operation this
   *  app already called "Start fresh" on Station 1; exposed under both
   *  names here since the header-level button is closer in spirit to a
   *  wallet "Disconnect" control than a full-page reset action. */
  disconnect: () => Promise<void>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet() must be called inside <WalletProvider>");
  return ctx;
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [wallet, setWallet] = useState<WalletStage>({ status: "idle" });
  const elapsed = useElapsedSeconds(wallet.status === "loading" ? wallet.startedAt : null);

  function persistSession(w: WalletState) {
    writeSession({ publicKey: w.publicKey, balanceXlm: w.balanceXlm, balanceUsdc: w.balanceUsdc });
  }

  const createWallet = useCallback(async (mode: "button" | "restore" = "button") => {
    const steps = initialSteps();
    if (mode === "restore") {
      setWallet((prev) => (prev.status === "cached" ? prev : { status: "restoring" }));
    } else {
      setWallet({ status: "loading", startedAt: Date.now(), steps: { ...steps } });
    }

    try {
      const res = await fetch("/api/session/create", { method: "POST" });
      if (!res.ok || !res.body) {
        if (mode === "restore") {
          setWallet((prev) => (prev.status === "cached" ? prev : { status: "idle" }));
          return;
        }
        setWallet({ status: "error", message: "We couldn't set up your wallet. Please try again.", steps: { ...steps } });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let settled = false;

      const applyComplete = (event: Record<string, unknown>) => {
        settled = true;
        const status = event.status as string | undefined;
        if (status === "done" && event.result && typeof event.result === "object") {
          const result = event.result as Partial<WalletState>;
          if (typeof result.publicKey === "string" && typeof result.balanceXlm === "string") {
            const w: WalletState = {
              publicKey: result.publicKey,
              balanceXlm: result.balanceXlm,
              usdcProvisioned: Boolean(result.usdcProvisioned),
              balanceUsdc: result.balanceUsdc,
            };
            persistSession(w);
            setWallet({ status: "ready", wallet: w });
            return;
          }
        }
        const message = typeof event.message === "string" ? event.message : "We couldn't set up your wallet. Please try again.";
        if (mode === "restore") {
          // A restore/background-confirm failing falls back to idle UNLESS
          // we already have cached display data on screen — in that case,
          // keep showing it rather than yanking a wallet the visitor can
          // see out from under them over a transient confirm failure. The
          // cache will simply get re-confirmed on the next navigation.
          setWallet((prev) => (prev.status === "cached" ? prev : { status: "idle" }));
          return;
        }
        setWallet((prev) => ({ status: "error", message, steps: prev.status === "loading" ? prev.steps : steps }));
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const event = parseStreamLine(line);
          if (!event) continue;

          if (event.step === "complete") {
            applyComplete(event);
            continue;
          }

          const step = event.step as string | undefined;
          const status = event.status as string | undefined;
          if (
            WALLET_STEP_ORDER.includes(step as StepName) &&
            (status === "active" || status === "done" || status === "skipped" || status === "error")
          ) {
            setWallet((prev) => {
              if (prev.status !== "loading") return prev;
              return { ...prev, steps: { ...prev.steps, [step as StepName]: status as StepStatus } };
            });
          }
        }
      }

      const trailing = parseStreamLine(buffer);
      if (trailing?.step === "complete") applyComplete(trailing);

      if (!settled) {
        if (mode === "restore") {
          setWallet((prev) => (prev.status === "cached" ? prev : { status: "idle" }));
        } else {
          setWallet((prev) => ({
            status: "error",
            message: "The connection ended before your wallet finished setting up. Please try again.",
            steps: prev.status === "loading" ? prev.steps : steps,
          }));
        }
      }
    } catch {
      if (mode === "restore") {
        setWallet((prev) => (prev.status === "cached" ? prev : { status: "idle" }));
      } else {
        setWallet((prev) => ({
          status: "error",
          message: "We couldn't reach the server. Please check your connection and try again.",
          steps: prev.status === "loading" ? prev.steps : steps,
        }));
      }
    }
  }, []);

  const disconnect = useCallback(async () => {
    try {
      await fetch("/api/session", { method: "DELETE" });
    } catch {
      // Best-effort — see the original Station 1 "Start fresh" doc comment
      // this is carried over from: even if the network call fails, still
      // clear local state so the UI reflects disconnect was requested. A
      // failed DELETE leaves the server cookie in place, but it's simply
      // reused next time (no user-visible harm beyond that).
    }
    clearAll();
    setWallet({ status: "idle" });
  }, []);

  // Cached-first render + background confirm — see the module doc comment.
  // Server-matching idle default above; this effect (mount-once, client-
  // only) reads the cache and either shows it immediately or falls through
  // to the normal restore flow if there's nothing cached.
  const attemptedRestore = useRef(false);
  useEffect(() => {
    if (attemptedRestore.current) return;
    attemptedRestore.current = true;

    function loadFromCache() {
      const cached = readSession();
      if (cached) {
        setWallet({
          status: "cached",
          wallet: { publicKey: cached.publicKey, balanceXlm: cached.balanceXlm, usdcProvisioned: true, balanceUsdc: cached.balanceUsdc },
        });
        // Confirm/refresh in the background — createWallet("restore") is
        // careful (see applyComplete above) never to downgrade a "cached"
        // render back to "idle" on a transient failure, only ever to
        // upgrade it to a confirmed "ready".
        void createWallet("restore");
      } else {
        void createWallet("restore");
      }
    }
    loadFromCache();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <WalletContext.Provider value={{ wallet, elapsed, createWallet, disconnect }}>{children}</WalletContext.Provider>;
}
