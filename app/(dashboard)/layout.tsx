import type { ReactNode } from "react";
import { DashboardShell } from "../dashboard-shell";

// Wraps all four dashboard routes (/, /catalog, /status, /console) in the
// shared sidebar shell — a route group layout so the sidebar markup lives in
// exactly one place instead of being duplicated per page.
export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
