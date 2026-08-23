"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import { cx } from "./design/ui";
import { useWallet } from "@/lib/wallet-context";
import { truncateMiddle } from "@/lib/format";

// ---------------------------------------------------------------------------
// Shared dashboard shell: a persistent left sidebar (collapsing to a top bar
// under 900px, see landing.css's .lp-shell/.lp-sidebar/.lp-topbar rules) that
// wraps the six routes (/, /catalog, /status, /console, /quest, /bond).
// Applied once via app/(dashboard)/layout.tsx rather than duplicated per page.
//
// Logo: vela-wallet's apps/web/public/logo-mark.png (the GREEN mark, for
// light surfaces — per that repo's own design.md brand-asset note:
// "logo-light.png (light mark, for dark surfaces), logo-mark.png (green
// mark, for light surfaces)"). This header sits on the paper-white
// background, a light surface, so logo-mark.png is the correct asset —
// logo-light.png was the wrong one for this context (it's a pale mint
// mark meant to sit on dark ink, which is why it read as an almost-
// invisible ghost here).
//
// RESTRUCTURED to match rail402's own playground sidebar pattern (flat
// routes, task-grouped, nothing hidden behind another page or gated on
// wallet-ready state) — adopted the PATTERN, not their literal content:
// their items (Agent buyer, Decoders, Error registry...) are their own
// build, several needing real backend work this app doesn't have yet (see
// this task's own scoping notes). What moved here is OUR existing content,
// regrouped and (for the former single-page "Station 1/2/3" flow) split
// into always-reachable routes for the first time — see /pay, /verify,
// /break/payments, /break/catalog's own module doc comments for what each
// used to be.
// - LEARN THE FLOW — the guided payment lessons, in the order a first-time
//   visitor would naturally work through them.
// - BREAK IT — the adversarial track (was Station 3, now two routes).
// - DISCOVERY — the Bazaar catalog, browsable and payable on its own.
// - LEARN — longer-form explainer/progression content (quest track, bond
//   system writeup) — read more than operated.
// - TOOLS — operational utilities for inspecting the facilitator/session
//   rather than driving the demo.
// ---------------------------------------------------------------------------

interface NavItem {
  href: string;
  label: string;
}

// "Journey map" (/) sits above every group, ungrouped — same top-of-sidebar
// placement rail402's own reference screenshot uses for their landing page.
const JOURNEY_MAP_ITEM: NavItem = { href: "/", label: "Journey map" };

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Learn the flow",
    items: [
      { href: "/pay", label: "First payment" },
      { href: "/verify", label: "Ownership verification" },
    ],
  },
  {
    label: "Break it",
    items: [
      { href: "/break/payments", label: "Break payments" },
      { href: "/break/catalog", label: "Poison catalog" },
    ],
  },
  {
    label: "Discovery",
    items: [{ href: "/catalog", label: "Bazaar catalog" }],
  },
  {
    label: "Learn",
    items: [
      { href: "/quest", label: "Quest" },
      { href: "/bond", label: "Bond system" },
    ],
  },
  {
    label: "Tools",
    items: [
      { href: "/status", label: "Status" },
      { href: "/console", label: "Console" },
    ],
  },
];

const NAV_ITEMS: NavItem[] = [JOURNEY_MAP_ITEM, ...NAV_GROUPS.flatMap((group) => group.items)];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <>
      {/* ---- Page-level header (all widths) — logo only, sits ABOVE the
          sidebar+content shell, matching docs.vellar.xyz's reference: the
          sidebar card itself has no brand row inside it, the wordmark is a
          separate header above everything. Desktop shows the mark alone
          (no "Vellar Playground" text — moved out of the sidebar entirely,
          per the reference); the narrow/mobile variant keeps a short label
          next to it since there's no sidebar wordmark to rely on there. ---- */}
      <header className="lp-page-header">
        <div className="lp-page-brand-group">
          <Link href="/" className="lp-page-brand" aria-label="Vellar Playground — home">
            {/* logo-mark.png's real source is 2000x989 (~2.02:1), not square.
                width/height here MUST match that real ratio at the size we
                actually render (height:32 -> width~=65) -- next/image uses
                these props to decide how large a source raster to generate
                for each DPR variant. The old width={32} height={32} lied
                about the source being square, so Next generated a needlessly
                tiny 32x16 raster (correctly aspect-corrected, just far
                smaller than the ~65x32 it was then stretched to via the CSS
                override below) -- a small image upscaled ~2x by the browser,
                which is what actually produced the blur, not a bad source
                asset. Confirmed by fetching the compiled /_next/image output
                directly before this fix: it was 32x16, not 65x32. */}
            <Image src="/logo-mark.png" alt="" width={65} height={32} priority style={{ height: 32, width: "auto" }} />
          </Link>
          <span className="lp-page-brand-label">Vellar Playground</span>
        </div>
        {/* Wallet status pill — always visible in the header regardless of
            which page is active, matching rail402's reference layout
            (screenshot: "no wallet, made on first pay ▾" top-right). Moved
            the logo+label lockup from a centered layout (a 3-column grid
            with a matching empty spacer column) to a plain left-aligned
            group so this pill has real room on the right without fighting
            that centering — same header-pattern rail402 itself uses. */}
        <WalletStatusPill />
      </header>

      <div className="lp-shell">
        {/* ---- Desktop sidebar (>900px) — nav only, no brand row ---- */}
        <aside className="lp-sidebar" aria-label="Dashboard navigation">
          <nav className="lp-side-nav">
            <div className="lp-side-journey">
              <Link
                href={JOURNEY_MAP_ITEM.href}
                className={cx("lp-side-link", isActive(pathname, JOURNEY_MAP_ITEM.href) && "active")}
                aria-current={isActive(pathname, JOURNEY_MAP_ITEM.href) ? "page" : undefined}
              >
                {JOURNEY_MAP_ITEM.label}
              </Link>
            </div>
            {NAV_GROUPS.map((group) => (
              <div key={group.label}>
                <div className="lp-side-group">{group.label}</div>
                {group.items.map((item) => {
                  const active = isActive(pathname, item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={cx("lp-side-link", active && "active")}
                      aria-current={active ? "page" : undefined}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </div>
            ))}
          </nav>
          <div className="lp-side-foot">
            Stellar testnet demo · <a href="https://stellar.expert/explorer/testnet" target="_blank" rel="noreferrer">Explorer ↗</a>
          </div>
        </aside>

        {/* ---- Mobile/narrow top bar (<=900px) ---- */}
        <div className="lp-topbar">
          <nav className="lp-topbar-links" aria-label="Dashboard navigation">
            {NAV_ITEMS.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={active ? "active" : undefined}
                  aria-current={active ? "page" : undefined}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>

        <div className="lp-content">{children}</div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Wallet status pill — header-level, always visible regardless of which page
// is active (see lib/wallet-context.tsx for why wallet state itself lives at
// the layout level now). <details>/<summary> for the dropdown rather than a
// custom click-outside-to-close implementation: this app already uses that
// disclosure pattern everywhere else it needs exactly this "click to reveal
// a small panel, click outside/away to dismiss" behavior (e.g.
// .lp-fitem--raw's raw-wire-bytes panels), and native <details> gets
// click-outside-closes-it behavior for free — no custom JS listener needed.
// ---------------------------------------------------------------------------

function WalletStatusPill() {
  const { wallet, disconnect } = useWallet();
  const [disconnecting, setDisconnecting] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  if (wallet.status === "idle" || wallet.status === "restoring") {
    return (
      <span className="lp-wallet-pill lp-wallet-pill--empty">
        {wallet.status === "restoring" ? "restoring session…" : "no wallet · made on first pay"}
      </span>
    );
  }

  if (wallet.status === "loading") {
    return <span className="lp-wallet-pill lp-wallet-pill--empty">setting up wallet…</span>;
  }

  if (wallet.status === "error") {
    return <span className="lp-wallet-pill lp-wallet-pill--empty">wallet setup failed</span>;
  }

  // "cached" or "ready" — both have a real WalletState to show. "cached" gets
  // a quiet dot cue (not a blocking spinner, not an error) since it's real
  // data from a prior session being re-confirmed in the background, not yet
  // independently verified this page load — same honesty standard the rest
  // of this app already holds label-vs-state to elsewhere.
  const { publicKey, balanceUsdc } = wallet.wallet;

  async function handleDisconnect() {
    setDisconnecting(true);
    await disconnect();
    setDisconnecting(false);
    detailsRef.current?.removeAttribute("open");
  }

  return (
    <details ref={detailsRef} className="lp-wallet-pill lp-wallet-pill--details">
      <summary>
        {wallet.status === "cached" && <span className="lp-wallet-pill-dot" aria-hidden title="Confirming…" />}
        <span className="lp-wallet-pill-key">{truncateMiddle(publicKey, 5, 4)}</span>
        {balanceUsdc && <span className="lp-wallet-pill-balance">{balanceUsdc} USDC</span>}
      </summary>
      <div className="lp-wallet-pill-menu">
        <a
          href={`https://stellar.expert/explorer/testnet/account/${publicKey}`}
          target="_blank"
          rel="noreferrer"
          className="lp-wallet-pill-menu-item"
        >
          View on Stellar Expert ↗
        </a>
        <button type="button" className="lp-wallet-pill-menu-item lp-wallet-pill-disconnect" onClick={handleDisconnect} disabled={disconnecting}>
          {disconnecting ? "Disconnecting…" : "Disconnect"}
        </button>
      </div>
    </details>
  );
}
