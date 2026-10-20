// Agent marks for the fleet panel. Agents with a supplied logo render that PNG; the rest fall back
// to a small inline SVG glyph tinted by the badge's `currentColor` (the caller sets color from
// AGENTS_BY_ID[id].color).

import { GeminiIcon, KoragentIcon, OpenCodeIcon } from "~/components/BrandIcons";
import grokLogo from "~/assets/agent-grok.png";
import cursorLogo from "~/assets/agent-cursor.png";
import codexLogo from "~/assets/agent-codex.png";
import claudeLogo from "~/assets/agent-claude.png";
import antigravityLogo from "~/assets/agent-antigravity.png";

const LOGOS: Record<string, string> = {
  claude: claudeLogo,
  codex: codexLogo,
  cursor: cursorLogo,
  grok: grokLogo,
  antigravity: antigravityLogo,
};

export function AgentIcon({ id, size = 15 }: { id: string; size?: number }) {
  const logo = LOGOS[id];
  if (logo) {
    return (
      <img
        src={logo}
        alt=""
        width={size}
        height={size}
        draggable={false}
        style={{ objectFit: "contain", borderRadius: 3, display: "block" }}
      />
    );
  }

  const svg = { width: size, height: size, viewBox: "0 0 24 24", fill: "none" } as const;
  switch (id) {
    // OpenCode / Gemini — the product marks from Icons.tsx (the ones the model picker shows)
    case "opencode":
      return <OpenCodeIcon width={size} height={size} />;
    case "gemini":
      return <GeminiIcon width={size} height={size} />;
    // Koragent — a hexagon (the Swarm mark) around a K
    case "koragent":
      return <KoragentIcon width={size} height={size} />;
    // Terminal — a shell prompt
    case "shell":
      return (
        <svg {...svg}>
          <path
            strokeLinejoin="round"
            strokeLinecap="round"
            stroke="currentColor"
            d="M6 8 L10 12 L6 16"
            strokeWidth="2"
          />
          <line
            strokeLinecap="round"
            stroke="currentColor"
            strokeWidth="2"
            y2="16"
            y1="16"
            x2="17"
            x1="12"
          />
        </svg>
      );
    // fog agents (droid/kimi/…) — a simple node tinted by the badge's currentColor
    default:
      return (
        <svg {...svg}>
          <circle cx="12" cy="12" r="4.5" fill="currentColor" />
        </svg>
      );
  }
}
