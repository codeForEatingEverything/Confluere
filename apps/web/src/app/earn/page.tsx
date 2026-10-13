import type { Metadata } from "next";
import { Suspense } from "react";
import { EarnScreen } from "@/components/earn/EarnScreen";

export const metadata: Metadata = { title: "Earn | Confluere" };

export default function Page() {
  return (
    <Suspense>
      <EarnScreen />
    </Suspense>
  );
}
