import type { Metadata } from "next";
import "./globals.css";
import "./design/landing.css";

// metadataBase anchors every relative URL below (canonical, and the
// OG/Twitter images Next auto-attaches from app/opengraph-image.tsx) to an
// absolute one — required for link-preview unfurlers (Slack, iMessage,
// Discord, X), which generally won't resolve a bare relative path. The
// real custom domain this app is actually shared under — was previously
// hardcoded to the vercel.app deployment URL, which is wrong for anyone
// sharing playground.vellar.xyz (the URL that actually appears in the
// address bar and gets copied/shared).
const SITE_URL = "https://playground.vellar.xyz";
const SITE_DESCRIPTION = "Try the Vellar x402 payment facilitator, live, on Stellar testnet.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Vellar Playground",
  description: SITE_DESCRIPTION,
  // openGraph/twitter are the actual mechanism link-share unfurlers read —
  // the plain `description` above only fills the HTML <meta
  // name="description"> tag, which most chat apps/social previews ignore
  // in favor of these. Deliberately NOT setting `images` here: Next's
  // file-based app/opengraph-image.tsx convention auto-generates a real
  // composed 1200x630 card and wires it into both openGraph.images and
  // twitter.images on its own — setting a static `images` array here would
  // override that with the old flat wordmark PNG (2000x989, no page copy,
  // a poor preview asset on its own) instead of letting it through.
  openGraph: {
    title: "Vellar Playground",
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    siteName: "Vellar Playground",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Vellar Playground",
    description: SITE_DESCRIPTION,
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://api.fontshare.com/v2/css?f[]=clash-display@700,600,500,400&f[]=cabinet-grotesk@800,700,500&display=swap"
        />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@1,500;1,600;1,700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap&family=Space+Mono:wght@400;700&display=swap"
        />
      </head>
      <body className="lp">{children}</body>
    </html>
  );
}
