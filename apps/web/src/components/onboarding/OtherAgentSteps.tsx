import { Segments } from "./SetupCheck";

const OTHER_AGENT_STEPS = [
  {
    name: "Codex",
    how: "Run `npm install -g @openai/codex`, then `codex login` in a terminal.",
  },
  {
    name: "OpenCode",
    how: "Install it from Settings › Swarm (or `kora swarm install`), then run `opencode auth login`.",
  },
  {
    name: "Antigravity",
    how: "Install it (the `agy` command) and sign in; Settings › Agents has Re-check.",
  },
] as const;

/** How to get Codex, OpenCode or Antigravity working: Kora needs any one agent, not Claude in particular. */
export function OtherAgentSteps({ className }: { readonly className?: string }) {
  return (
    <ul data-other-agent-steps className={className}>
      {OTHER_AGENT_STEPS.map((agent) => (
        <li key={agent.name} className="mt-1 text-muted-foreground text-xs leading-5">
          <span className="text-foreground">{agent.name}</span>
          {": "}
          <Segments text={agent.how} />
        </li>
      ))}
    </ul>
  );
}
