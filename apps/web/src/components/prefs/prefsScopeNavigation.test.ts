import * as TanstackRouter from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

const { createMemoryHistory, createRootRoute, createRoute, createRouter, redirect } =
  TanstackRouter;

import { retainPrefsScope, validatePrefsRouteSearch } from "./prefsScopeNavigation";

describe("prefsScopeNavigation", () => {
  describe("validatePrefsRouteSearch", () => {
    it("maps legacy hostId deep-link parameter to machine when no scope is specified", () => {
      const parsed = validatePrefsRouteSearch({ hostId: "build-server-01" });
      expect(parsed).toEqual({ machine: "build-server-01" });
    });

    it("prefers explicit machine over legacy hostId", () => {
      const parsed = validatePrefsRouteSearch({
        hostId: "old-host",
        machine: "current-host",
      });
      expect(parsed).toEqual({ machine: "current-host" });
    });

    it("prefers explicit project over legacy hostId", () => {
      const parsed = validatePrefsRouteSearch({
        hostId: "old-host",
        project: "kora-frontend",
      });
      expect(parsed).toEqual({ project: "kora-frontend" });
    });

    it("filters out empty or whitespace-only scope values", () => {
      const parsed = validatePrefsRouteSearch({
        machine: "   ",
        project: "valid-project",
        checkout: "",
      });
      expect(parsed).toEqual({ project: "valid-project" });
    });
  });

  describe("retainPrefsScope middleware", () => {
    it("carries existing scope keys when destination does not specify new targets", () => {
      const initial = {
        machine: "cluster-node",
        project: "workspace-alpha",
        checkout: "cluster-node:/home/dev/alpha",
      };

      const result = retainPrefsScope({
        search: initial,
        next: () => ({}),
      });

      expect(result).toEqual(initial);
    });

    it("discards prior scope when any target key is explicitly provided", () => {
      const initial = {
        machine: "node-a",
        project: "project-a",
      };

      const result = retainPrefsScope({
        search: initial,
        next: () => ({ machine: "node-b" }),
      });

      expect(result).toEqual({ machine: "node-b" });
      expect(result).not.toHaveProperty("project");
    });

    it("allows explicitly resetting scope keys to undefined", () => {
      const initial = {
        machine: "node-a",
        project: "project-a",
      };

      const result = retainPrefsScope({
        search: initial,
        next: () => ({ machine: undefined, project: undefined }),
      });

      expect(result).toEqual({ machine: undefined, project: undefined });
    });
  });

  describe("router integration with settings routes", () => {
    function setupSettingsRouter(initialPath = "/settings/general") {
      const rootRoute = createRootRoute();

      const settingsRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "settings",
        validateSearch: validatePrefsRouteSearch,
        search: { middlewares: [retainPrefsScope] },
        beforeLoad: (ctx) => {
          if (ctx.location.pathname.endsWith("/settings")) {
            throw redirect({ replace: true, to: "/settings/general" });
          }
        },
      });

      const generalRoute = createRoute({
        getParentRoute: () => settingsRoute,
        path: "general",
      });

      const projectsRoute = createRoute({
        getParentRoute: () => settingsRoute,
        path: "projects",
      });

      const usageRoute = createRoute({
        getParentRoute: () => settingsRoute,
        path: "usage",
      });

      const legacyProjectRedirect = createRoute({
        getParentRoute: () => rootRoute,
        path: "projects/$projectKey",
        beforeLoad: (ctx) => {
          const slug = ctx.params.projectKey;
          throw redirect({
            replace: true,
            to: "/settings/projects",
            search: { machine: undefined, project: slug },
          });
        },
      });

      const history = createMemoryHistory({ initialEntries: [initialPath] });
      return createRouter({
        history,
        routeTree: rootRoute.addChildren([
          settingsRoute.addChildren([generalRoute, projectsRoute, usageRoute]),
          legacyProjectRedirect,
        ]),
      });
    }

    it("forwards query parameters through the index route redirect", async () => {
      const router = setupSettingsRouter("/settings");
      await router.navigate({
        to: "/settings",
        search: { machine: "box-42" },
      });

      if (router.state.redirect) {
        await router.navigate(router.state.redirect.options);
      }

      expect(router.state.location.pathname).toBe("/settings/general");
      expect(router.state.location.search).toEqual({ machine: "box-42" });
    });

    it("maintains current scope across child settings views", async () => {
      const router = setupSettingsRouter();
      const scope = {
        machine: "dev-vm",
        project: "kora-engine",
        checkout: "dev-vm:/opt/kora",
      };

      await router.navigate({ to: "/settings/general", search: scope });
      expect(router.state.location.search).toEqual(scope);

      await router.navigate({ to: "/settings/projects" });
      expect(router.state.location.pathname).toBe("/settings/projects");
      expect(router.state.location.search).toEqual(scope);

      await router.navigate({ to: "/settings/usage" });
      expect(router.state.location.pathname).toBe("/settings/usage");
      expect(router.state.location.search).toEqual(scope);
    });

    it("overwrites active scope when a new target is selected", async () => {
      const router = setupSettingsRouter();
      await router.navigate({
        to: "/settings/general",
        search: { machine: "vm-1", project: "app-1" },
      });

      await router.navigate({
        to: "/settings/projects",
        search: { project: "app-2" },
      });

      expect(router.state.location.search).toEqual({ project: "app-2" });
    });

    it("retains scope when navigating history backward and forward", async () => {
      const router = setupSettingsRouter();
      const firstScope = { machine: "host-alpha" };
      const secondScope = { machine: "host-beta" };

      await router.navigate({ to: "/settings/general", search: firstScope });
      await router.navigate({ to: "/settings/general", search: secondScope });
      expect(router.state.location.search).toEqual(secondScope);

      router.history.back();
      await router.load();
      expect(router.state.location.search).toEqual(firstScope);
    });

    it("clears all active scope parameters when reset keys are supplied", async () => {
      const router = setupSettingsRouter();
      await router.navigate({
        to: "/settings/general",
        search: { machine: "workstation", project: "monorepo" },
      });

      await router.navigate({
        to: "/settings/general",
        search: { machine: undefined, project: undefined, checkout: undefined },
      });

      expect(router.state.location.search).toEqual({});
    });

    it("handles legacy project URL redirects by targeting the project scope", async () => {
      const router = setupSettingsRouter();
      await router.navigate({
        to: "/projects/$projectKey",
        params: { projectKey: "legacy-analytics" },
      });

      if (router.state.redirect) {
        await router.navigate(router.state.redirect.options);
      }

      expect(router.state.location.pathname).toBe("/settings/projects");
      expect(router.state.location.search).toEqual({ project: "legacy-analytics" });
    });
  });
});
