export function projectGroupTitleNeedsUpdate(
  titlesOfMembers: ReadonlyArray<string>,
  proposedTitle: string,
  edited: boolean,
): boolean {
  if (!edited) return false;
  return titlesOfMembers.some((title) => title !== proposedTitle);
}
