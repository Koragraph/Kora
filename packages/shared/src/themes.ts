const BUILT_IN_THEME_IDS = ["kora-chat", "grove", "ocean", "ember", "iris"] as const;

/** The mobile app's own hand-tuned palette, which is not part of the built-in library. */
const MOBILE_DEFAULT_THEME_ID = "kora-code";

/**
 * Every palette the mobile app can render. Declared here so host-side tooling
 * (the app-store screenshot harness) can validate a requested theme without
 * importing React Native application code.
 */
const MOBILE_THEME_IDS = [MOBILE_DEFAULT_THEME_ID, ...BUILT_IN_THEME_IDS] as const;

/**
 * Ids a theme may not take: the appearance keywords a stored preference uses,
 * every built-in, and the legacy aliases older saves still carry. Taking one
 * would either be shadowed by the built-in or capture clients that never chose
 * it, so the client library and the publish path both consult this set.
 */

/**
 * Additionally closed to a machine publishing a theme: the mobile default is
 * not a web or desktop built-in, so a saved theme may legitimately carry that
 * id, but no client that follows published themes can resolve it -- publishing
 * it would report success and change nothing.
 */

export type ThemeAppearance = "light" | "dark";
export type MobileThemeId = (typeof MOBILE_THEME_IDS)[number];
export type BuiltInThemeId = (typeof BUILT_IN_THEME_IDS)[number];

/** Product roles shared by web CSS, React Native tokens, and native surfaces. */
const BASE_ROLES = ["canvas", "chrome", "toolbar"] as const;
const TOOLBAR_ROLES = ["toolbarForeground", "toolbarBorder", "toolbarControl"] as const;
const TOOLBAR_CONTROL_ROLES = ["toolbarControlForeground", "toolbarControlHover"] as const;
const SURFACE_ROLES = ["surface", "surfaceRaised", "surfaceOverlay"] as const;
const TEXT_ROLES = ["text", "textMuted", "border", "input", "focus", "accent"] as const;
const SECONDARY_ROLES = ["accentForeground", "secondary", "secondaryForeground"] as const;
const MUTED_ROLES = ["muted", "mutedForeground", "placeholder"] as const;
const LABEL_ROLES = ["secondaryLabel", "iconMuted"] as const;
const STATUS_ROLES = [
  ...(["error", "errorForeground", "errorSurface"] as const),
  ...(["warning", "warningForeground", "warningSurface"] as const),
  ...(["update", "updateForeground", "updateSurface"] as const),
] as const;
const MESSAGE_ROLES = ["accentSurface", "accentSurfaceForeground", "messageSurface"] as const;
const MESSAGE_ACTION_ROLES = ["messageForeground", "messageAction"] as const;
const CODE_ROLES = ["messageActionForeground", "messageActionHover", "codeBackground"] as const;
const SIDEBAR_ROLES = ["codeForeground", "sidebar", "sidebarForeground"] as const;
const SIDEBAR_STATE_ROLES = ["sidebarMutedForeground", "sidebarControlSurface"] as const;
const SIDEBAR_ROW_ROLES = ["sidebarRowHover", "sidebarRowActive", "sidebarRowSelected"] as const;
const TERMINAL_ROLES = ["sidebarBorder", "terminalBackground", "terminalForeground"] as const;
const TERMINAL_CURSOR_ROLES = ["terminalCursor", "terminalSelection"] as const;
const TERMINAL_SCROLL_ROLES = ["terminalScrollbar", "terminalScrollbarHover"] as const;

const THEME_COLOR_ROLES = [
  ...BASE_ROLES,
  ...TOOLBAR_ROLES,
  ...TOOLBAR_CONTROL_ROLES,
  ...SURFACE_ROLES,
  ...TEXT_ROLES,
  ...SECONDARY_ROLES,
  ...MUTED_ROLES,
  ...LABEL_ROLES,
  ...STATUS_ROLES,
  ...MESSAGE_ROLES,
  ...MESSAGE_ACTION_ROLES,
  ...CODE_ROLES,
  ...SIDEBAR_ROLES,
  ...SIDEBAR_STATE_ROLES,
  ...SIDEBAR_ROW_ROLES,
  ...TERMINAL_ROLES,
  ...TERMINAL_CURSOR_ROLES,
  ...TERMINAL_SCROLL_ROLES,
] as const;

export type ThemeColors = Readonly<Record<ThemeColorRole, string>>;
export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];
export type ThemeVariants = Readonly<{ [Mode in ThemeAppearance]?: ThemeColors }>;

/** One theme in the library: its own colours plus optional per-appearance variants. */
interface ThemeDefinitionFields {
  label: string;
  colors: ThemeColors;
  id: string;
  variants?: ThemeVariants;
  appearance: ThemeAppearance;
  /** Groups related imported variants into one library card. */
  collection?: Readonly<{ label: string; id: string }>;
  /** Generated from the guided editor's canvas and accent roles. */
  managed?: boolean;
  /** Allows reviewed built-ins to render product artwork over their sidebar. */
  sidebarArtwork?: boolean;
}

export type ThemeDefinition = Readonly<ThemeDefinitionFields>;
