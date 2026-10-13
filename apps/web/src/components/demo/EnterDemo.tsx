"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { DEMO_PARAM, enterDemo } from "@/lib/demo/mode";
import { chainMeta } from "@/lib/chains";
import { getChainChoice } from "@/lib/activeChain";

/** Turns demo mode on and lands on the home page, on the network the person was looking at. */
export function EnterDemo() {
  const router = useRouter();
  useEffect(() => {
    enterDemo();
    router.replace(`/?chain=${chainMeta(getChainChoice()).slug}&${DEMO_PARAM}=1`);
  }, [router]);
  return <div className="skeleton mx-auto h-[420px] max-w-[480px]" aria-busy aria-label="Opening the demo" />;
}
