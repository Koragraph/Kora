// Kora is dark-only (the Ink palette in src/index.css): paint the window frame
// before the app mounts, so there is no light flash whatever the OS appearance.
// An external classic script (not inline) so the packaged app's CSP can refuse
// inline script (apps/desktop/src/native/NativeProtocol.ts).
(() => {
  const FRAME = "#000000";
  const root = document.documentElement;
  root.classList.add("dark");
  root.style.backgroundColor = FRAME;
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    meta.setAttribute("content", FRAME);
  }
})();
