"use client";

import "./globals.css";

/** Failure in the root layout itself: no app chrome, same words as error.tsx. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <main className="mx-auto max-w-[60ch] px-4 py-16">
          <h1 className="text-amount font-semibold">Something went wrong</h1>
          <p className="mt-2 text-ink-2">Reloading usually fixes it; nothing was sent from your wallet.</p>
          <button type="button" className="btn btn-md btn-primary mt-6" onClick={reset}>
            Reload
          </button>
        </main>
      </body>
    </html>
  );
}
