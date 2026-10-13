import type { Metadata } from "next";
import { Suspense } from "react";
import { HowItWorks } from "@/components/more/HowItWorks";

export const metadata: Metadata = { title: "How it works | Confluere" };

export default function Page() {
  return (
    <Suspense>
      <HowItWorks />
    </Suspense>
  );
}
