"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Ellipsis } from "lucide-react";
import { Drawer, Menu } from "../ui/Overlay";
import { MORE, MORE_PHONE } from "./nav";
import { useDemo } from "@/lib/demo/mode";
import { useExitDemo } from "../demo/DemoBits";

const DEMO_HREF = "/developers/demo";

/**
 * More (IA v3.1): only the rarely used tools, Demo and Developers (the site is dark only, no theme switch). Desktop: a
 * dropdown from the top bar. Phones: the fifth tab, a bottom sheet that also carries Loop and Markets (no tab of their own).
 */
export function MoreMenu({ active, tab }: { active?: boolean; tab?: boolean }) {
  const path = usePathname() ?? "/";
  const [sheet, setSheet] = useState(false);
  const demo = useDemo();
  const exit = useExitDemo();
  if (tab)
    return (
      <>
        <button type="button" onClick={() => setSheet(true)} aria-current={active ? "page" : undefined} className={`flex flex-col items-center justify-center gap-1 text-label font-medium ${active ? "text-brand" : "text-ink-2"}`} data-testid="more-tab">
          <Ellipsis size={22} strokeWidth={1.75} aria-hidden />
          More
        </button>
        <Drawer open={sheet} onClose={() => setSheet(false)} title="More">
          <ul className="-mx-2">
            {MORE_PHONE.map((m) => (
              <li key={m.href}>
                {demo && m.href === DEMO_HREF ? (
                  <button
                    type="button"
                    className="menu-item text-body"
                    onClick={() => {
                      setSheet(false);
                      exit();
                    }}
                  >
                    Exit demo
                  </button>
                ) : (
                <Link href={m.href} onClick={() => setSheet(false)} aria-current={path.startsWith(m.href) ? "page" : undefined} className={`menu-item text-body ${path.startsWith(m.href) ? "bg-surface-2 font-medium" : ""}`}>
                  {m.label}
                </Link>
                )}
              </li>
            ))}
          </ul>
        </Drawer>
      </>
    );
  return (
    <Menu
      label="More"
      trigger={({ open, toggle, id }) => (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={id}
          aria-haspopup="menu"
          aria-label="More"
          aria-current={active ? "page" : undefined}
          className={`btn btn-icon ${active ? "bg-surface-2 text-ink" : ""}`}
          data-testid="more-menu"
        >
          <Ellipsis size={20} strokeWidth={1.75} aria-hidden />
        </button>
      )}
    >
      {(close) => (
        <div className="w-[240px]">
          {MORE.map((m) =>
            demo && m.href === DEMO_HREF ? (
              <button
                key={m.href}
                type="button"
                role="menuitem"
                className="menu-item w-full font-medium text-brand-ink"
                onClick={() => {
                  close();
                  exit();
                }}
                data-testid="more-exit-demo"
              >
                Exit demo
              </button>
            ) : (
            <Link key={m.href} href={m.href} role="menuitem" className={`menu-item ${path.startsWith(m.href) ? "font-medium text-brand-ink" : ""}`} onClick={close}>
              {m.label}
            </Link>
            ),
          )}
        </div>
      )}
    </Menu>
  );
}
