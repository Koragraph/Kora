/** "My Server!" -> "my-server" (an endpoint / agent id: lowercase letters, numbers, dashes, up to 30). */

// Settings > Engines: pure helpers (slugs, wording, grouping). The page is EnginesSettings.tsx.
import type { EngineAccountView, EngineApiView, EnginesView, EngineRow } from "@kora/contracts";

export function slugify(label: string): string {
  const dashed = label.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const trimmed = dashed.replace(/^-+|-+$/g, "");
  return trimmed.slice(0, 30).replace(/-+$/, "");
}

/** An id not used by `taken`: base, base-2, base-3 ... */
export function freeSlug(base: string, taken: ReadonlyArray<string>): string {
  const root = slugify(base) || "endpoint";
  if (!taken.includes(root)) return root;
  for (let n = 2; n < 100; n++) {
    const next = `${root.slice(0, 27)}-${n}`;
    if (!taken.includes(next)) return next;
  }
  return `${root.slice(0, 24)}-${Date.now().toString(36).slice(-4)}`;
}

/** The sentence under an engine row: version-free, plain. */
export function statusLine(s: EngineRow): string {
  if (s.available) return s.explicitPath ? "Ready · using the path you set" : "Ready";
  // OpenCode is not something a person installs: Kora downloads it when Swarm is set up.
  if (s.id === "opencode" && /was not found/i.test(s.reason ?? "")) {
    return "OpenCode is not set up yet. It is only needed for Swarm; Kora downloads it for you when you turn Swarm on.";
  }
  // This text is shown ON Settings > Engines: "set its path in Settings > Engines" would point at the page you are on.
  return (s.reason ?? "Not available.").replace(/ (?:in|from) Settings > Engines(?=[.\s]|$)/g, "");
}

export type Dot = "ok" | "warn" | "off";
export function statusDot(s: EngineRow): Dot {
  if (s.available) return "ok";
  return s.needsKey ? "warn" : "off";
}

/** "Connected. 12 models available." / the daemon's own sentence for a failure. */
export function testLine(t: { ok: boolean; message: string; modelCount?: number }): string {
  if (!t.ok) return t.message;
  if (typeof t.modelCount === "number")
    return `Connected. ${t.modelCount} ${t.modelCount === 1 ? "model" : "models"} available.`;
  return t.message || "Connected.";
}

/** Presets not yet added as an endpoint. */
export function remainingPresets(view: EnginesView): EnginesView["presets"] {
  const have = new Set(view.endpoints.map((e) => e.id));
  return view.presets.filter((p) => !have.has(p.id));
}

export function accountDot(a: EngineAccountView): Dot {
  return a.signIn === "signed-in" ? "ok" : a.signIn === "signed-out" ? "warn" : "off";
}
export function accountWord(a: EngineAccountView): string {
  return a.signIn === "signed-in"
    ? a.email
      ? `Signed in as ${a.email}`
      : "Signed in"
    : a.signIn === "signed-out"
      ? "Not signed in yet"
      : "Not checked";
}

export function endpointNeedsKey(e: EngineApiView): boolean {
  return e.requiresKey && !e.hasKey;
}

/** Args typed in one line -> argv (split on spaces; quotes group). */
export function parseArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}
export function joinArgs(args: ReadonlyArray<string>): string {
  return args.map((a) => (/\s/.test(a) || a === "" ? JSON.stringify(a) : a)).join(" ");
}

/** KEY=value lines -> env. Lines without = are ignored. */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) env[m[1]!] = m[2]!.trim();
  }
  return env;
}
