"use client";

import { useEffect, useState } from "react";

/** Live-updating "(Ns)" elapsed-time counter, ticking every second.
 *
 *  `Date.now()` is read only from inside the `setInterval` callback — an
 *  event-like async callback, not the effect body itself or the render body
 *  — which satisfies both React 19 purity rules: no impure call during
 *  render, and no synchronous `setState` in the effect body (the effect only
 *  *subscribes*; the interval callback is what calls `setState`, exactly the
 *  "calling setState in a callback function when external state changes"
 *  pattern the lint rule asks for). The first tick's value lags by up to 1s
 *  (visible only as "(0s)" for a moment) — an acceptable tradeoff for a
 *  loading-state counter, not worth a synchronous effect setState to avoid.
 *
 *  Shared across `app/page.tsx` (wallet/catalog/pay loading states) and
 *  `/status` (cold-start detection on the initial facilitator fetch) —
 *  extracted here once a second page needed the identical hook rather than
 *  a copy-pasted duplicate.
 */
export function useElapsedSeconds(startedAt: number | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (startedAt === null) return;
    const id = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt === null ? 0 : elapsed;
}
