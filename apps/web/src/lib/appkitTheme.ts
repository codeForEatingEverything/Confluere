/**
 * AppKit (Reown) theming: the modal and <appkit-button> take the site's own font, accent and radius, and follow the
 * site's light / dark choice. Setting a font family also stops AppKit from preloading its fonts from fonts.reown.com
 * (appkit-ui ThemeUtil.initializeTheming). The modal still fetches wallet logos from Reown's API.
 */
export const APPKIT_THEME_VARIABLES = {
  "--w3m-font-family": "var(--font-geist), ui-sans-serif, system-ui, sans-serif",
  "--w3m-accent": "var(--brand)",
  "--w3m-border-radius-master": "4px",
  "--w3m-color-mix": "var(--canvas)",
  "--w3m-color-mix-strength": 20,
} as const;

export function appKitThemeOptions(mode: "light" | "dark") {
  return { themeMode: mode, themeVariables: { ...APPKIT_THEME_VARIABLES } };
}
