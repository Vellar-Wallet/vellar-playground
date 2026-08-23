import type { Metadata } from "next";
import "./globals.css";
import "./design/landing.css";

// metadataBase anchors every relative URL below (openGraph/twitter images,
// canonical) to an absolute one — required for link-preview unfurlers
// (Slack, iMessage, Discord, X), which generally won't resolve a bare
// relative path. This is the real deployed Vercel URL for this app.
const SITE_URL = "https://vellar-playground.vercel.app";
const SITE_DESCRIPTION = "Try the Vellar x402 payment facilitator, live, on Stellar testnet.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: "Vellar Playground",
  description: SITE_DESCRIPTION,
  // openGraph/twitter are the actual mechanism link-share unfurlers read —
  // the plain `description` above only fills the HTML <meta
  // name="description"> tag, which most chat apps/social previews ignore
  // in favor of these. logo-mark.png as the preview image is a lightweight
  // fallback rather than shipping a dedicated 1200x630 OG asset — better
  // than the broken-image box an unfurler shows when no image is given at
  // all.
  openGraph: {
    title: "Vellar Playground",
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    siteName: "Vellar Playground",
    images: [{ url: "/logo-mark.png", width: 2000, height: 989, alt: "Vellar" }],
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Vellar Playground",
    description: SITE_DESCRIPTION,
    images: ["/logo-mark.png"],
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
