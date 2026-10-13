import type { Metadata } from "next";
import { Suspense } from "react";
import { DevelopersScreen } from "@/components/more/DevelopersScreen";

export const metadata: Metadata = { title: "Developers | Confluere" };

export default function Page() {
  return (
    <Suspense>
      <DevelopersScreen />
    </Suspense>
  );
}
