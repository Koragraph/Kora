// Platform wording: macOS keeps the exact sentences Kora always printed; Windows gets its own (docs/windows/AUDIT.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import { appStateDir, claudeInstallFix, folderAccessHint, gitInstallFix, inTerminal, opencodeInstallFallback, removeAppHint, thisComputer } from './platform-copy';

test('macOS: the original text, byte for byte', () => {
  assert.equal(thisComputer('darwin'), 'this Mac');
  assert.equal(inTerminal(false, 'darwin'), 'in Terminal');
  assert.equal(inTerminal(true, 'darwin'), 'In Terminal');
  assert.equal(claudeInstallFix('darwin'), 'In Terminal, run `curl -fsSL https://claude.ai/install.sh | bash` (installs Claude Code, https://claude.com/claude-code), then run `claude` once and log in.');
  assert.equal(gitInstallFix('darwin'), 'In Terminal, run `xcode-select --install` (Apple\'s free command line tools, a short download), then come back to Kora.');
  assert.equal(opencodeInstallFallback('darwin'), 'brew install opencode');
  assert.equal(`${folderAccessHint('darwin')}, or open another folder.`, 'Give your user access to it (Finder → Get Info → Sharing & Permissions; for Desktop, Documents or Downloads: System Settings → Privacy & Security → Files and Folders), or open another folder.');
  assert.equal(removeAppHint('darwin'), 'Kora.app itself: quit it, then drag it from Applications to the Trash.');
  assert.equal(appStateDir('darwin'), '~/Library/Application Support/kora');
});

test('Windows: no Mac words, Windows install commands', () => {
  const all = [thisComputer('win32'), inTerminal(true, 'win32'), claudeInstallFix('win32'), gitInstallFix('win32'), opencodeInstallFallback('win32'), folderAccessHint('win32'), removeAppHint('win32'), appStateDir('win32')].join('\n');
  assert.doesNotMatch(all, /\bMac\b|Terminal\b|Finder|System Settings|xcode-select|brew|curl|\| bash|Trash|Library\//);
  assert.equal(thisComputer('win32'), 'this computer');
  assert.equal(inTerminal(false, 'win32'), 'in a terminal');
  assert.match(claudeInstallFix('win32'), /irm https:\/\/claude\.ai\/install\.ps1 \| iex/);
  assert.match(gitInstallFix('win32'), /winget install --id Git\.Git -e/);
  assert.equal(opencodeInstallFallback('win32'), 'npm i -g opencode-ai');
  assert.match(folderAccessHint('win32'), /Properties → Security/);
  assert.equal(appStateDir('win32'), '%APPDATA%\\kora');
});

test('Linux: neutral words', () => {
  assert.equal(thisComputer('linux'), 'this computer');
  assert.match(gitInstallFix('linux'), /package manager/);
  assert.equal(appStateDir('linux'), '~/.config/kora');
});
