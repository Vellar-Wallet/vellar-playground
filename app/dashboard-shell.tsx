"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "./design/ui";

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
// Grouping (restyled to match docs.vellar.xyz's small-caps grouped sidebar):
// - PLAYGROUND — Wallet (/) and Catalog (/catalog): the interactive demo
//   core, where a visitor actually gets a funded wallet and spends from it.
// - TOOLS — Status (/status) and Console (/console): operational utilities
//   for inspecting the facilitator/session rather than driving the demo.
// - LEARN — Quest (/quest) and Bond (/bond): explainer/progression content
//   (the guided quest track and the bond-provider writeup), read more than
//   operated.
// ---------------------------------------------------------------------------

interface NavItem {
  href: string;
  label: string;
}

const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Playground",
    items: [
      { href: "/", label: "Wallet" },
      { href: "/catalog", label: "Catalog" },
    ],
  },
  {
    label: "Tools",
    items: [
      { href: "/status", label: "Status" },
      { href: "/console", label: "Console" },
    ],
  },
  {
    label: "Learn",
    items: [
      { href: "/quest", label: "Quest" },
      { href: "/bond", label: "Bond" },
    ],
  },
];

const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

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
        <Link href="/" className="lp-page-brand" aria-label="Vellar Playground — home">
          <Image src="/logo-mark.png" alt="" width={32} height={32} priority style={{ height: 32, width: "auto" }} />
        </Link>
        <span className="lp-page-brand-label">Vellar Playground</span>
      </header>

      <div className="lp-shell">
        {/* ---- Desktop sidebar (>900px) — nav only, no brand row ---- */}
        <aside className="lp-sidebar" aria-label="Dashboard navigation">
          <nav className="lp-side-nav">
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
