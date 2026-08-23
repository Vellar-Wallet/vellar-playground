import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

// ---------------------------------------------------------------------------
// Next's file-based OG-image convention — this file, at this exact path,
// is auto-detected and wired into both metadata.openGraph.images and
// metadata.twitter.images with no manual config in layout.tsx, and (unlike
// a hardcoded SITE_URL string) Next resolves its URL against whatever
// origin actually served the request, so it's correct on every deploy
// (vercel.app preview URLs, playground.vellar.xyz, a future domain) without
// needing to keep a constant in sync.
//
// Built as a real composed card, not a reuse of either raw logo PNG
// directly: public/logo-mark.png and logo-light.png are both just the bare
// transparent "VELLAR" wordmark, no tagline, no ground — a poor link-
// preview asset on its own (many unfurlers composite transparent PNGs
// inconsistently, and it carries no page-identifying text at all). This
// renders the same design system's own tokens (paper ground, forest ink,
// mint accent) with the wordmark plus real page copy, at the 1200x630 size
// virtually every unfurler (Slack/iMessage/Discord/X) expects.
// ---------------------------------------------------------------------------

export const runtime = "nodejs";
export const alt = "Vellar Playground — learn x402 by doing it, for real.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const INK = "#0c3b31";
const PAPER = "#ffffff";
const MINT = "#3ee6ad";
const LINE = "rgba(12, 59, 49, 0.16)";

export default async function OpengraphImage() {
  const logoPath = join(process.cwd(), "public", "logo-mark.png");
  const logoBuffer = await readFile(logoPath);
  const logoSrc = `data:image/png;base64,${logoBuffer.toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: PAPER,
          padding: "72px 84px",
          fontFamily: "sans-serif",
        }}
      >
        {/* next/image is unavailable inside next/og's isolated render — a
            plain <img> with a data: URI is the documented pattern here. */}
        <img src={logoSrc} alt="" width={220} height={109} />

        <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
          <div
            style={{
              display: "flex",
              fontSize: 30,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: MINT,
            }}
          >
            Playground
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 64,
              fontWeight: 700,
              lineHeight: 1.1,
              color: INK,
              maxWidth: 980,
            }}
          >
            Learn x402 by doing it, for real.
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 28,
              color: INK,
              opacity: 0.7,
              maxWidth: 880,
            }}
          >
            Try the Vellar x402 payment facilitator, live, on Stellar testnet.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            paddingTop: 32,
            borderTop: `1px solid ${LINE}`,
            fontSize: 22,
            color: INK,
            opacity: 0.6,
          }}
        >
          playground.vellar.xyz
        </div>
      </div>
    ),
    { ...size },
  );
}
