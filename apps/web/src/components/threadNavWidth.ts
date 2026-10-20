export const THREAD_NAV_WIDTH_STORAGE_KEY = "kora:nav-width";
const THREAD_NAV_DEFAULT_WIDTH = 17 * 16;
// No narrower than the default: the titlebar's sidebar toggle + Kora | Code switcher (after the macOS traffic lights)
// must end inside the sidebar, or they cover the main panel's title.
export const THREAD_NAV_MIN_WIDTH = 17 * 16;
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16;

export function resolveThreadNavMaximumWidth(viewportWidth: number): number {
  return Math.max(THREAD_NAV_MIN_WIDTH, Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH);
}

export function resolveInitialThreadNavWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number {
  const ceiling = resolveThreadNavMaximumWidth(viewportWidth);
  if (storedWidth === null) {
    return Math.min(THREAD_NAV_DEFAULT_WIDTH, ceiling);
  }
  return Math.min(Math.max(THREAD_NAV_MIN_WIDTH, storedWidth), ceiling);
}
