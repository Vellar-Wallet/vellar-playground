"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "./design/ui";

// ---------------------------------------------------------------------------
// Shared dashboard shell: a persistent left sidebar (collapsing to a top bar
// under 900px, see landing.css's .lp-shell/.lp-sidebar/.lp-topbar rules) that
// wraps the four routes (/, /catalog, /status, /console). Applied once via
// app/(dashboard)/layout.tsx rather than duplicated per page.
//
// Logo: vela-wallet's apps/web/public/logo-light.png, copied into this app's
// public/ directory — see the task report for why this asset was chosen over
// a text-only wordmark (it was readily portable, so no need to fall back).
// ---------------------------------------------------------------------------

const NAV_ITEMS = [
  { href: "/", label: "Wallet" },
  { href: "/catalog", label: "Catalog" },
  { href: "/status", label: "Status" },
  { href: "/console", label: "Console" },
  { href: "/quest", label: "Quest" },
] as const;

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="lp-shell">
      {/* ---- Desktop sidebar (>900px) ---- */}
      <aside className="lp-sidebar" aria-label="Dashboard navigation">
        <Link href="/" className="lp-side-brand">
          <Image src="/logo-light.png" alt="" width={28} height={28} priority style={{ height: 28, width: "auto" }} />
          <span>Vellar Playground</span>
        </Link>
        <nav className="lp-side-nav">
          {NAV_ITEMS.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cx("lp-side-link", active && "active")}
                aria-current={active ? "page" : undefined}
              >
                <i aria-hidden />
                {item.label}
              </Link>
            );
          })}
        </nav>
        <div className="lp-side-foot">
          Stellar testnet demo · <a href="https://stellar.expert/explorer/testnet" target="_blank" rel="noreferrer">Explorer ↗</a>
        </div>
      </aside>

      {/* ---- Mobile/narrow top bar (<=900px) ---- */}
      <div className="lp-topbar">
        <Link href="/" className="lp-topbar-brand">
          <Image src="/logo-light.png" alt="" width={24} height={24} style={{ height: 24, width: "auto" }} />
          <span>Vellar</span>
        </Link>
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
  );
}
