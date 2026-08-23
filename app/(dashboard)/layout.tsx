import type { ReactNode } from "react";
import { DashboardShell } from "../dashboard-shell";
import { WalletProvider } from "@/lib/wallet-context";

// Wraps every dashboard route in the shared sidebar shell — a route group
// layout so the sidebar markup lives in exactly one place instead of being
// duplicated per page. WalletProvider sits OUTSIDE DashboardShell (not
// inside it, and not per-page) so wallet state survives every in-app
// navigation between sibling routes — this layout stays mounted across
// those navigations even though each page component itself unmounts, which
// is exactly why wallet state needed to live here rather than in any one
// page. See lib/wallet-context.tsx's own module doc comment for the full
// reasoning (this used to live independently, and out of sync, in both
// app/(dashboard)/page.tsx and app/(dashboard)/catalog/page.tsx).
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <WalletProvider>
      <DashboardShell>{children}</DashboardShell>
    </WalletProvider>
  );
}
