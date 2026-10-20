// User-facing words that differ by OS. On macOS every function returns exactly the text the callers always had;
// on Windows (and Linux) the same sentence names that OS's machine, terminal, file manager and install commands.
// The web client has its own copy of the wording helpers (apps/web/src/util/utils.ts: thisComputer & co).

const mac = (platform: NodeJS.Platform) => platform === 'darwin';

/** "this Mac" on macOS, "this computer" elsewhere. */
export function thisComputer(platform: NodeJS.Platform = process.platform): string {
  return mac(platform) ? 'this Mac' : 'this computer';
}

/** "in Terminal" / "in a terminal" (`cap`: "In Terminal" / "In a terminal"). */
export function inTerminal(cap = false, platform: NodeJS.Platform = process.platform): string {
  const s = mac(platform) ? 'in Terminal' : 'in a terminal';
  return cap ? s[0]!.toUpperCase() + s.slice(1) : s;
}

/** How to install Claude Code. */
export function claudeInstallFix(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'In PowerShell, run `irm https://claude.ai/install.ps1 | iex` (installs Claude Code, https://claude.com/claude-code; it needs Git for Windows), then run `claude` once and log in.';
  return 'In Terminal, run `curl -fsSL https://claude.ai/install.sh | bash` (installs Claude Code, https://claude.com/claude-code), then run `claude` once and log in.';
}

/** How to get a working git. */
export function gitInstallFix(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'In a terminal, run `winget install --id Git.Git -e` (Git for Windows; Claude Code needs it too), then restart Kora.';
  if (platform !== 'darwin') return 'Install git with your package manager (for example `sudo apt install git`), then come back to Kora.';
  return 'In Terminal, run `xcode-select --install` (Apple\'s free command line tools, a short download), then come back to Kora.';
}

/** The package-manager fallback for OpenCode after Kora's own install failed. */
export function opencodeInstallFallback(platform: NodeJS.Platform = process.platform): string {
  return mac(platform) ? 'brew install opencode' : 'npm i -g opencode-ai';
}

/** What to do when Kora may not read a folder (permission denied); the caller finishes the sentence. */
export function folderAccessHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'Give your user access to it (File Explorer: right-click the folder → Properties → Security)';
  if (platform !== 'darwin') return 'Give your user read access to it';
  return 'Give your user access to it (Finder → Get Info → Sharing & Permissions; for Desktop, Documents or Downloads: System Settings → Privacy & Security → Files and Folders)';
}

/** How to remove the app itself, as `kora uninstall --help` ends. */
export function removeAppHint(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return 'Kora itself: quit it, then uninstall it from Settings → Apps → Installed apps.';
  return 'Kora.app itself: quit it, then drag it from Applications to the Trash.';
}

/** Where the desktop app keeps its window state, as `kora uninstall --help` names it. */
export function appStateDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return '%APPDATA%\\kora';
  if (platform !== 'darwin') return '~/.config/kora';
  return '~/Library/Application Support/kora';
}
