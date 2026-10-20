import { createElement } from "react";
import { createRouter, RouterHistory } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";
import { Spinner } from "./components/ui/spinner";
import { RouteNotFoundView } from "./components/RouteNotFoundView";

export function getRouter(history: RouterHistory) {
  return createRouter({
    // Any address no route owns (a deeper unknown path like /a/b/c included) gets Kora's own page, not the bare default.
    defaultNotFoundComponent: RouteNotFoundView,
    defaultPendingMs: 400,
    // The `/` landing jumps straight into a draft whose (large) route chunk may still be loading — slow disk, or the
    // Vite dev server compiling it on first visit (~6 s). Show a quiet spinner instead of an empty main pane.
    defaultPendingComponent: RoutePending,
    // Route components are split chunks (autoCodeSplitting in vite.config);
    // fetching them on hover/focus intent hides the load from the first
    // settings or pull-request navigation.
    defaultPreload: "intent",
    context: {},
    history,
    routeTree,
  });
}

export type AppRouter = ReturnType<typeof getRouter>;

declare module "@tanstack/react-router" {
  interface Register {
    router: AppRouter;
  }
}

function RoutePending() {
  return createElement(
    "div",
    {
      className: "flex min-h-0 flex-1 items-center justify-center bg-background",
      "aria-busy": true,
    },
    createElement(Spinner, { className: "size-4 text-muted-foreground" }),
  );
}
