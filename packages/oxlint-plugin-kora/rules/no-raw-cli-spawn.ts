import * as Option from "effect/Option";
import { defineRule } from "@oxlint/plugins";

import { calleeName, staticString } from "../utils.ts";

// Node's process launchers, plus the promisified spellings (`execFileAsync`, `execFileP`).
const LAUNCHER = /^(?:spawn|spawnSync|execFile|execFileSync|exec|execSync)(?:Async|P|Promise)?$/u;
const SHELL_LINE_LAUNCHER = /^(?:exec|execSync)(?:Async|P|Promise)?$/u;

// CLIs that npm, pnpm, scoop or Volta install as `.cmd` shims on Windows. `git`, `node` and `bun` are real .exe files
// and spawn fine as they are.
const SHIMMED_CLIS: ReadonlySet<string> = new Set([
  "claude",
  "codex",
  "opencode",
  "agy",
  "gemini",
  "cursor-agent",
  "code",
  "cursor",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "tsx",
  "vp",
]);

const SCRIPT_FILE = /\.(?:sh|cmd|bat)$/iu;

const offender = (command: string, shellLine: boolean): string | undefined => {
  const program = shellLine ? (command.trim().split(/\s+/u)[0] ?? "") : command;
  if (SHIMMED_CLIS.has(program)) return program;
  if (SCRIPT_FILE.test(program)) return program;
  return undefined;
};

const messageFor = (program: string) =>
  `Spawning '${program}' directly fails on Windows (npm installs it as a .cmd shim: Node does not try PATHEXT and refuses to spawn .cmd/.bat; .sh needs bash). Go through winCommand() (runtime util/win-exec.ts, ui-server winSpawn.ts): const t = winCommand(cmd, args); spawn(t.command, t.args, { windowsVerbatimArguments: t.windowsVerbatimArguments }). For sh scripts use shellCommand().`;

export default defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow spawning npm-shimmed CLIs (claude, codex, opencode, agy, npm, …) or .sh/.cmd scripts by literal name; route them through winCommand.",
    },
  },
  create(context) {
    return {
      CallExpression(node) {
        const name = Option.getOrUndefined(calleeName(node.callee));
        if (name === undefined || !LAUNCHER.test(name)) return;
        const command = Option.getOrUndefined(staticString(node.arguments[0]));
        if (command === undefined) return;
        const program = offender(command, SHELL_LINE_LAUNCHER.test(name));
        if (program !== undefined) context.report({ node, message: messageFor(program) });
      },
    };
  },
});
