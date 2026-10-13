"use client";

import Link from "next/link";

/** Render-time failure inside a page: the app chrome stays, one sentence, Reload. Nothing was sent from the wallet. */
export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="max-w-[60ch] py-10">
      <h1 className="text-amount font-semibold">Something went wrong</h1>
      <p className="mt-2 text-ink-2">Reloading usually fixes it; nothing was sent from your wallet.</p>
      <p className="mt-6 flex gap-3">
        <button type="button" className="btn btn-md btn-primary" onClick={reset}>
          Reload
        </button>
        <Link href="/" className="btn btn-md btn-secondary">
          Go to Borrow
        </Link>
      </p>
    </div>
  );
}
