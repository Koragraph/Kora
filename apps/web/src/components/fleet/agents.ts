// The worker agents the fleet panel can label: id / label / color. The daemon owns the real adapter
// (detection, hooks, launch); this is presentation only.
export interface FleetAgent {
  id: string;
  label: string;
  color: string;
}

const AGENTS: FleetAgent[] = [
  { id: "claude", label: "Claude Code", color: "#d97757" },
  { id: "codex", label: "Codex", color: "#e6e6e6" },
  { id: "antigravity", label: "Antigravity", color: "#6b8afd" },
  { id: "shell", label: "Terminal", color: "#8a8a93" },
  { id: "cursor", label: "Cursor Agent", color: "#8ab4ff" },
  { id: "opencode", label: "OpenCode", color: "#7fd88f" },
  // Kora's own worker agent: Stone, no accent (the mark carries it).
  { id: "koragent", label: "Koragent", color: "#d6d3d1" },
  { id: "grok", label: "Grok", color: "#c9c9d0" },
  { id: "gemini", label: "Gemini", color: "#6b8afd" },
];

export const AGENTS_BY_ID: Record<string, FleetAgent> = Object.fromEntries(
  AGENTS.map((a) => [a.id, a]),
);
