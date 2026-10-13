import type { Metadata } from "next";
import { Suspense } from "react";
import { PortfolioScreen } from "@/components/portfolio/PortfolioScreen";

export const metadata: Metadata = { title: "Portfolio | Confluere" };

export default function Page() {
  return (
    <Suspense>
      <PortfolioScreen />
    </Suspense>
  );
}
