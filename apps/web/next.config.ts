import type { NextConfig } from "next";
import { join } from "node:path";

// All protocol data is read client-side from the chain (wagmi) or this app's /api index, so pages stay static shells.
// Old URLs move to their new place with a 301 (FRONTEND_V3 §5.3, updated for IA v3.1).
const moved = (source: string, destination: string) => ({ source, destination, statusCode: 301 as const });

const nextConfig: NextConfig = {
  // self-hosted in Docker (deploy/): a standalone server bundle; the tracing root is the pnpm workspace
  output: "standalone",
  outputFileTracingRoot: join(__dirname, "../.."),
  transpilePackages: ["@confluere/sdk"],
  async redirects() {
    return [
      // IA v3.1: "/" is the borrow / repay card, /borrow the market list, /loop its own page, /earn vaults only
      { source: "/borrow", has: [{ type: "query", key: "mode", value: "loop" }], destination: "/loop", statusCode: 301 as const },
      // lending into one maturity now happens on the Borrow market page (the query, ?pool=, is carried over)
      { source: "/earn", has: [{ type: "query", key: "pool" }], destination: "/borrow?trade=lend", statusCode: 301 as const },
      moved("/borrow/american", "/borrow"),
      moved("/borrow/european", "/borrow?style=european"),
      moved("/lend", "/borrow"),
      moved("/lend/american", "/borrow"),
      moved("/lend/european", "/borrow?style=european"),
      moved("/vaults", "/earn#vaults"),
      moved("/vaults/:address", "/earn?vault=:address"),
      moved("/markets/american", "/markets"),
      moved("/markets/european", "/markets?style=european"),
      moved("/market/:id", "/markets?market=:id"),
      moved("/pool/:id", "/markets?pool=:id"),
      moved("/seats/:market", "/seats?market=:market"),
      moved("/learn", "/how-it-works"),
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
