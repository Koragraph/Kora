// How a blob's engine reads to a person: "Claude · sonnet", "Codex · gpt-5.5", "Big Pickle · free" (never the raw id).
import type { BlobEngine } from "@kora/contracts";

const BRAND: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  grok: "Grok",
  cursor: "Cursor",
  kimi: "Kimi",
  qwen: "Qwen",
  droid: "Droid",
};

/** `claude-work` -> "Work" (the named Claude account a blob or thread runs on); null for the default login and every other engine. */
export function claudeAccountOf(instanceId: string): string | null {
  const m = /^claude-([a-z0-9][a-z0-9-]*)$/.exec(instanceId);
  return m ? titleWords(m[1] ?? "") : null;
}

function titleWords(base: string): string {
  return base
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

/** A model the composer's picker knows: its name there is the name everywhere ("Sonnet 5.5", "GPT-5.5"). */
export interface CatalogModel {
  readonly slug: string;
  readonly name: string;
}
export type EngineCatalog = (instanceId: string) => ReadonlyArray<CatalogModel> | undefined;

export function engineLabel(
  engine: Pick<BlobEngine, "instanceId" | "model">,
  catalog?: EngineCatalog,
): string {
  const provider =
    claudeAccountOf(engine.instanceId) !== null
      ? "claude"
      : (engine.instanceId.split(":")[0] ?? engine.instanceId);
  const known = catalog?.(engine.instanceId)?.find((m) => m.slug === engine.model)?.name;
  if (known && provider !== "opencode") return known;
  // No catalog (or an unlisted slug): never "Claude · default" / "Claude · sonnet". Say the model the way the picker does.
  if (provider === "claude") {
    const m = engine.model.toLowerCase();
    return m === "default" || m === "" ? "Claude" : `Claude ${titleWords(m)}`;
  }
  if (provider === "opencode") {
    const base = engine.model.replace(/^[^/]+\//, "").replace(/:free$/i, "");
    return `${titleWords(base) || engine.model} · free`;
  }
  // Phase 7 engines: `api-groq` reads "Groq", `acp-hermes` reads "Hermes"; their placeholder model "default" is not worth saying.
  const brand = BRAND[provider] ?? titleWords(provider.replace(/^(api|acp)-/, ""));
  return engine.model === "default" ? brand : `${brand} · ${engine.model}`;
}
