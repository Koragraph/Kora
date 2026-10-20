const ELLIPSIS = "...";

export function truncate(text: string, maxLength = 50): string {
  const clean = text.trim();
  return clean.length > maxLength ? clean.slice(0, maxLength) + ELLIPSIS : clean;
}
