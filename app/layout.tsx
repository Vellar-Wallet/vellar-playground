import type { Metadata } from "next";
import "./globals.css";
import "./design/landing.css";

export const metadata: Metadata = {
  title: "Vellar Playground",
  description: "Try the Vellar x402 payment facilitator, live, on Stellar testnet.",
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
