// `pnpm start` for a built checkout: runs the compiled desktop main process under the Kora-branded Electron.
import { spawn } from "node:child_process";

import { desktopDir, electronLaunchCommand } from "./mac-launcher.mjs";

const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env;
const { electronPath, args } = electronLaunchCommand(["dist-electron/main.cjs"]);

const child = spawn(electronPath, args, { cwd: desktopDir, env: cleanEnv, stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
