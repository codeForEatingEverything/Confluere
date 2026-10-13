import Link from "next/link";

export default function NotFound() {
  return (
    <div className="max-w-[60ch] py-10">
      <h1 className="text-amount font-semibold leading-8">This page does not exist</h1>
      <p className="mt-2 text-ink-2">The link may be from an older version of the app.</p>
      <p className="mt-6 flex gap-3">
        <Link href="/" className="btn btn-md btn-primary">
          Borrow
        </Link>
        <Link href="/earn" className="btn btn-md btn-secondary">
          Earn
        </Link>
      </p>
    </div>
  );
}
