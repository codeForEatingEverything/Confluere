import type { Metadata } from "next";
import { Suspense } from "react";
import { MarketsScreen } from "@/components/markets/MarketsScreen";

export const metadata: Metadata = { title: "Markets | Confluere" };

export default function Page() {
  return (
    <Suspense>
      <MarketsScreen />
    </Suspense>
  );
}
