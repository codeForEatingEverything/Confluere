/** The site is dark only: every preference resolves to dark; the type stays for callers. */
export type ThemePref = "system" | "light" | "dark";

export const THEME_KEY = "confluere.theme";

/** Runs in <head> before first paint so the page never flashes the wrong theme. */
export const THEME_SCRIPT = `document.documentElement.setAttribute("data-theme","dark");`;

export function readThemePref(): ThemePref {
  return "dark";
}

export function resolveTheme(_pref: ThemePref): "light" | "dark" {
  return "dark";
}

type ThemeListener = (mode: "light" | "dark") => void;
const listeners = new Set<ThemeListener>();

/** Called with the resolved mode whenever the theme is applied (the wallet modal follows the site's theme). */
export function onThemeApplied(fn: ThemeListener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function applyTheme(pref: ThemePref) {
  const mode = resolveTheme(pref);
  document.documentElement.setAttribute("data-theme", mode);
  for (const fn of listeners) fn(mode);
}

export function setThemePref(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {}
  applyTheme(pref);
}
