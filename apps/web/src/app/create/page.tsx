import type { Metadata } from "next";
import { Suspense } from "react";
import { CreateMarketCard } from "@/components/more/CreateMarketCard";

export const metadata: Metadata = { title: "Create market | Confluere" };

export default function Page() {
  return (
    <Suspense>
      <CreateMarketCard />
    </Suspense>
  );
}
