import type { Metadata } from "next";
import { Suspense } from "react";
import { LoopScreen } from "@/components/loop/LoopScreen";

export const metadata: Metadata = { title: "Loop | Confluere" };

export default function Page() {
  return (
    <Suspense>
      <LoopScreen />
    </Suspense>
  );
}
