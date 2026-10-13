import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Press_Start_2P } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { AppShell } from "@/components/layout/AppShell";
import { THEME_SCRIPT } from "@/lib/theme";

// Geist for everything a person reads (amounts use its tabular figures); Geist Mono only for addresses, hashes, code.
const sans = Geist({ subsets: ["latin", "latin-ext"], variable: "--font-geist", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
// The pixel face is only for the 11 px CONFLUERE wordmark in the top bar.
const pixel = Press_Start_2P({ weight: "400", subsets: ["latin"], variable: "--font-pixel-src", display: "swap" });

export const metadata: Metadata = {
  title: "Confluere",
  description: "Borrow against your tokens and repay by a date, or lend for a fixed return. No price feed, no liquidation.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" className={`${sans.variable} ${mono.variable} ${pixel.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <Providers>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
