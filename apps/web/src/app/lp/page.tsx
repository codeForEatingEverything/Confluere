import type { Metadata } from "next";
import { Suspense } from "react";
import { LpScreen } from "@/components/lp/LpScreen";

export const metadata: Metadata = { title: "LP | Confluere" };

export default function Page() {
  return (
    <Suspense>
      <LpScreen />
    </Suspense>
  );
}
