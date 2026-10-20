export type ResponsiveSidebarState = "expanded" | "collapsed";

export function resolveSidebarState(input: { open: boolean }): ResponsiveSidebarState {
  return input.open ? "expanded" : "collapsed";
}
