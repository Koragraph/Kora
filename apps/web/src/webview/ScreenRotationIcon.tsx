/**
 * Screen-rotation glyph shared by the in-browser device toolbar and the
 * default-viewport setting, so the orientation control reads the same in both
 * places.
 *
 * @module ScreenRotationIcon
 */
export function ScreenRotationIcon() {
  return (
    <svg
      aria-hidden="true"
      strokeLinejoin="round"
      strokeLinecap="round"
      strokeWidth="2"
      stroke="currentColor"
      fill="none"
      viewBox="0 0 24 24"
    >
      <path d="M3.2 20.5v-4h4" />
      <path d="M11.5 22a10 10 0 0 1-8.4-5.4" />
      <path d="M20.8 3.5v4h-4" />
      <path d="M12.5 2a10 10 0 0 1 8.4 5.4" />
      <rect transform="rotate(-45 12 12)" x="7.25" y="7.25" width="9.5" height="9.5" rx="1.4" />
    </svg>
  );
}
