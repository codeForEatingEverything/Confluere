import type { Metadata } from "next";
import { Suspense } from "react";
import { SpecialsScreen } from "@/components/specials/SpecialsScreen";

export const metadata: Metadata = { title: "Specials | Confluere" };

export default function Page() {
  return (
    <Suspense>
      <SpecialsScreen />
    </Suspense>
  );
}
