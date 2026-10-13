import type { Metadata } from "next";
import { Suspense } from "react";
import { HomeScreen } from "@/components/home/HomeScreen";

export const metadata: Metadata = { title: "Confluere | Borrow and repay" };

export default function Page() {
  return (
    <Suspense>
      <HomeScreen />
    </Suspense>
  );
}
