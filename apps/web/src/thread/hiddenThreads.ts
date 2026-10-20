// A routine's execution thread is hidden: it never shows in a sidebar, thread nav, roster, recent list or search, and stays
// reachable by id (the thread route, "Open run"). The daemon sets `hidden` on its heads; `origin.kind === "routine"` says the
// same for a head from before that field existed.
export function isHiddenThreadShell(shell: {
  readonly hidden?: boolean | undefined;
  readonly origin?: { readonly kind: string } | null | undefined;
}): boolean {
  return shell.hidden === true || shell.origin?.kind === "routine";
}
