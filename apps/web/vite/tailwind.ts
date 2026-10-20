import tailwindcss from "@tailwindcss/vite";

/** Adapts Tailwind's dev hooks to Vite's experimental bundled mode. */
export function tailwindPlugins(bundledDev: boolean) {
  const pluginList = tailwindcss();
  if (bundledDev) {
    pluginList.forEach((entry) => {
      // This hook expects Vite ModuleNodes and a server, which Rolldown does
      // not provide in bundled mode; Tailwind's own watcher already invalidates
      // and rebuilds CSS when those files change without this hook.
      delete entry.hotUpdate;
    });
  }
  return pluginList;
}
