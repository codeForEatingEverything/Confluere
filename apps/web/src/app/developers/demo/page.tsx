import type { Metadata } from "next";
import { EnterDemo } from "@/components/demo/EnterDemo";

export const metadata: Metadata = { title: "Demo | Confluere" };

/** More → Demo: turns on demo mode (the same app on sample data) and opens the home page in it. */
export default function Page() {
  return <EnterDemo />;
}
