import type { Metadata } from "next";
import { Suspense } from "react";
import { BorrowMarkets } from "@/components/borrow/BorrowMarkets";

export const metadata: Metadata = { title: "Borrow markets | Confluere" };

export default function Page() {
  return (
    <Suspense>
      <BorrowMarkets />
    </Suspense>
  );
}
