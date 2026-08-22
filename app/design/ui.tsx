import Link from "next/link";
import type { ButtonHTMLAttributes, CSSProperties, HTMLAttributes, ReactNode } from "react";

/**
 * Shared primitives for the .lp marketing system (landing + about).
 *
 * Convention: layout-only concerns use Tailwind utilities at the call
 * site; anything carrying the system's signature styling (clip cuts,
 * two-layer borders, type roles, state matrices) keeps its lp-* class
 * from landing.css — utilities can't express those cleanly.
 */

export function cx(...parts: Array<string | false | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function Eyebrow({
  children,
  className,
  ...rest
}: { children: ReactNode; className?: string } & HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cx("lp-eyebrow", className)} {...rest}>
      {children}
    </span>
  );
}

type LpVariant = "sun" | "forest" | "outline" | "ghost";
type LpSize = "sm" | "md" | "lg";

function btnClass(variant: LpVariant, size: LpSize, className?: string) {
  return cx("lp-btn", `lp-btn--${variant}`, size !== "md" && `lp-btn--${size}`, className);
}

type LpButtonProps = {
  href: string;
  variant?: LpVariant;
  size?: LpSize;
  className?: string;
  children: ReactNode;
};

/** The system's one CTA element. Internal hrefs get client navigation. */
export function LpButton({
  href,
  variant = "sun",
  size = "md",
  className,
  children,
}: LpButtonProps) {
  const cls = btnClass(variant, size, className);
  if (href.startsWith("/") && !href.startsWith("//")) {
    return (
      <Link href={href} className={cls}>
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className={cls}>
      {children}
    </a>
  );
}

/** Button-element sibling of LpButton for in-app actions (onClick,
 *  disabled, submit). Same variants, same state matrix. */
export function LpActionButton({
  variant = "sun",
  size = "md",
  className,
  children,
  type = "button",
  ...rest
}: {
  variant?: LpVariant;
  size?: LpSize;
  className?: string;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type={type} className={btnClass(variant, size, className)} {...rest}>
      {children}
    </button>
  );
}

/** Two-column section head: eyebrow + title left, lead paragraph right. */
export function SectionHead({
  eyebrow,
  title,
  lead,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  lead: ReactNode;
}) {
  return (
    <div className="lp-sechead" data-reveal>
      <div>
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2>{title}</h2>
      </div>
      <p className="lp-lead">{lead}</p>
    </div>
  );
}

/** Offset outline frame — the system's depth device. Wrap a clipped
 *  card in it; the wrapper stays unclipped so the outline can overhang. */
export function Frame({
  corner,
  color,
  className,
  children,
}: {
  corner?: "tr" | "br";
  color?: "sun" | "lime" | "coral";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "lp-frame",
        corner && `lp-frame--${corner}`,
        color && `lp-frame--${color}`,
        className,
      )}
    >
      {children}
    </div>
  );
}

/** One monospace request/response row. */
export function MonoRow({
  label,
  value,
  tone,
}: {
  label: ReactNode;
  value?: ReactNode;
  tone?: "ok" | "bad";
}) {
  return (
    <div className="lp-mrow">
      <span>{label}</span>
      {value !== undefined && <b className={tone}>{value}</b>}
    </div>
  );
}

export function MonoRows({ children }: { children: ReactNode }) {
  return <div className="lp-mrows">{children}</div>;
}

/** Asset pill with the little cut-square token mark. */
export function TokenPill({ label, usdc }: { label: ReactNode; usdc?: boolean }) {
  return (
    <span className={cx("lp-token", usdc && "lp-token--usdc")}>
      <i></i>
      {label}
    </span>
  );
}

/** Chip row; `on` chips read as active. */
export function Chips({ items }: { items: Array<{ label: string; on?: boolean }> }) {
  return (
    <div className="lp-chips">
      {items.map((c) => (
        <b key={c.label} className={c.on ? "on" : undefined}>
          {c.label}
        </b>
      ))}
    </div>
  );
}

/** Labelled amount well used inside product mocks (div flavour — the
 *  span flavour lives inline in everyday.tsx where button content rules
 *  forbid divs). */
export function Field({
  label,
  amount,
  amountStyle,
  token,
  sub,
}: {
  label: ReactNode;
  amount: ReactNode;
  amountStyle?: CSSProperties;
  token?: ReactNode;
  sub?: ReactNode;
}) {
  return (
    <div className="lp-field">
      <div className="lbl">{label}</div>
      <div className="row">
        <span className="amt" style={amountStyle}>
          {amount}
        </span>
        {token}
      </div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
