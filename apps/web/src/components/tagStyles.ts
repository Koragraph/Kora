/**
 * Class lists for the inline tags that stand for a file, skill, terminal excerpt or citation.
 *
 * Two looks. In the composer a tag is a removable object, so it is a bordered pill. In a sent message it is a
 * reference inside a sentence, so it is a borderless highlighter mark. Both are sized in em: they follow the text
 * they sit in (the composer's font-size preference), and the message variant pins 12px.
 *
 * Monochrome: every kind is tinted from one ink, `--tag-ink` (the muted foreground), and is told apart by its icon
 * and label. Every class is written out in full so Tailwind's scanner sees it.
 */

export const tagFocusRing =
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--contrast-foreground)]";

/** The composer's pill. `pill.tint` goes on top of `pill.base`. */
export const pill = {
  base: "inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-full px-[0.6em] align-middle font-medium leading-none select-none border border-border/70 bg-accent/40 text-[0.86em] text-foreground",
  tint: "[--tag-ink:var(--muted-foreground)] border-[color-mix(in_oklab,var(--tag-ink)_34%,var(--contrast-border))] bg-[color-mix(in_oklab,var(--tag-ink)_11%,transparent)] text-[color-mix(in_oklab,var(--tag-ink)_22%,var(--contrast-foreground))]",
  hover: `transition-colors motion-reduce:transition-none hover:border-[color-mix(in_oklab,var(--tag-ink)_48%,var(--contrast-border))] hover:bg-[color-mix(in_oklab,var(--tag-ink)_17%,transparent)] ${tagFocusRing}`,
  label: "block select-none self-center truncate leading-tight",
  icon: "block size-[1.17em] shrink-0 self-center [&>svg]:block",
  dismiss:
    "ml-[0.17em] inline-flex size-[1.17em] shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/72 transition-colors hover:bg-foreground/6 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
} as const;

/** A skill pill in the editor, which renders outside React and so carries its whole look in one list. */
export const skillPill = `inline-flex h-[1.41em] max-w-full items-center gap-[0.33em] rounded-full px-[0.6em] align-middle font-medium leading-none select-none border text-[0.86em] ${pill.tint}`;

/** The highlighter mark used in sent messages. No outline, so the fill is a little stronger than the pill's. */
export const mark = {
  base: "inline-flex max-w-full items-center gap-[0.3em] rounded-[0.2em] px-[0.22em] py-[0.03em] align-baseline text-[12px] font-medium",
  tint: "[--tag-ink:var(--muted-foreground)] border-0 bg-[color-mix(in_oklab,var(--tag-ink)_26%,transparent)] text-[color-mix(in_oklab,var(--tag-ink)_42%,var(--contrast-foreground))]",
  hover: `transition-colors motion-reduce:transition-none hover:bg-[color-mix(in_oklab,var(--tag-ink)_36%,transparent)] ${tagFocusRing}`,
  label: "truncate leading-tight",
} as const;

/** Hover fill for a citation's own text, in the tag ink. */
export const markTextHover = "hover:bg-[color-mix(in_oklab,var(--tag-ink)_17%,transparent)]";

/**
 * The editor's decorator host. While a tag sits inside the selection, highlight.ts sets `data-prompt-chip-selected`
 * and an overlay tints it with the focus ring colour.
 */
export const tagHost =
  "relative inline-flex items-center align-middle leading-none data-[prompt-chip-selected]:after:absolute data-[prompt-chip-selected]:after:inset-0 data-[prompt-chip-selected]:after:pointer-events-none data-[prompt-chip-selected]:after:content-[''] data-[prompt-chip-selected]:after:rounded-[6px] data-[prompt-chip-selected]:after:bg-(--ring) data-[prompt-chip-selected]:after:opacity-30";

/** Lucide's "package" glyph, as markup for the skill pill the editor builds by hand. */
export const SKILL_GLYPH_SVG = `<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>`;
