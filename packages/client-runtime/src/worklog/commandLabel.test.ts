import { describe, expect, it } from "vite-plus/test";

import { commandProgramName } from "./commandLabel.ts";

const labelOf = commandProgramName;

/** One test per row: the program a command line is labelled with. */
const programTable = (title: string, rows: ReadonlyArray<readonly [string, string]>) =>
  it.each(rows)(`${title}: %s`, (command, program) => {
    expect(labelOf(command)).toBe(program);
  });

/** One test per command line that must get no label at all. */
const nullTable = (title: string, commands: ReadonlyArray<string>) =>
  it.each(commands)(`${title}: %s`, (command) => {
    expect(labelOf(command)).toBeNull();
  });

describe("commandProgramName", () => {
  programTable("unwraps shell scripts without executing them", [
    ["/bin/zsh -lc 'vp lint run apps/site/src/session-logic.test.ts'", "vp"],
    ["/bin/zsh -lc 'git diff --check'", "git"],
    ['/bin/zsh -lc "npx -y react-doctor@latest apps/site"', "npx"],
    ["/bin/zsh -lc 'rg -n \"registerHooks|worker\" apps/site/src'", "rg"],
    ["/bin/bash --noprofile --norc -l -c 'sed -n 1,270p file.ts'", "sed"],
    ["/bin/bash -o pipefail -lc 'vp lint run'", "vp"],
    ["/bin/bash --rcfile /var/tmp/config -c 'git fetch'", "git"],
    ["sh -ec 'node scripts/lint.js'", "node"],
    ["fish --command 'rg --files'", "rg"],
    ["zsh -lc 'BUILD=1 env -u VERBOSE sudo -u admin vp lint run'", "vp"],
    ["env BUILD=1 /bin/zsh -lc '\"/Applications/My Tools/bin/check\" --quiet'", "check"],
    ["bash -lc \"zsh -c 'git fetch'\"", "git"],
    ['"C:\\Program Files\\Git\\bin\\bash.exe" -lc "git fetch"', "git"],
    ["/bin/zsh -lc 'git fetch\nsed -n '\"'1,20p' apps/site/src/components/DiffPanel.tsx\"", "git"],
  ]);

  programTable("preserves ordinary programs and actual shell launches", [
    ["vp lint run", "vp"],
    ["sudo -u admin pnpm run build", "pnpm"],
    ["env --split-string='BUILD=1 node scripts/lint.js'", "node"],
    ["/usr/local/bin/zsh", "zsh"],
    ['"D:\\Tools\\Node Runtime\\node.exe" app.js', "node.exe"],
    ["/opt/homebrew/bin/bash -l", "bash"],
    ["zsh script.sh -c 'git fetch'", "zsh"],
    ["bash -- -c 'git fetch'", "bash"],
    ["bash --rcfile config.sh", "bash"],
    ["odd-shell -c 'git fetch'", "odd-shell"],
    ["$HOME/.bun/bin/bun run dev", "bun"],
    ['"$ANDROID_HOME/emulator/emulator" -list-avds', "emulator"],
    ["${ROOT}/bin/tool --version", "tool"],
  ]);

  nullTable("falls back for missing or malformed scripts", [
    "",
    "zsh -lc",
    "zsh -lc ''",
    "zsh -lc 'git fetch",
    "zsh -lc 'env'",
    'zsh -lc "git \\\"',
  ]);

  nullTable("falls back for shell syntax and internal control commands", [
    "if test -f tsconfig.json; then vp lint; fi",
    "[ -f tsconfig.json ]",
    "[[ -f tsconfig.json ]]",
    "test -f tsconfig.json",
    'for entry in *; do echo "$entry"; done',
    "while true; do sleep 2; done",
    "until false; do sleep 2; done",
    "case $name in test) vp lint;; esac",
    'select item in red green; do echo "$item"; done',
    "function check() { vp lint; }",
    "check() { vp lint; }",
    "k(){ echo done; }; k",
    "{ vp lint; }",
    "(vp lint)",
    "(( total += 1 ))",
    "! vp lint",
    ":",
    ". ./setup.sh",
    "source ./setup.sh",
    "eval 'vp lint'",
    "cd packages/client-runtime",
    "export APP_ENV=prod",
    "local label=thing",
    "set -e",
    "alias ll='ls -l'",
    "repeat 5 echo done",
    "and vp lint",
    "return 1",
    "break",
    "continue",
    "true",
    "false",
  ]);

  programTable("uses the first executable-looking program", [
    ["printf '%d\\n' 'x|y;z'", "printf"],
    ['grep -E "case|esac|done" lib', "grep"],
    ["python3 -c \"while False: print('x')\"", "python3"],
    ["echo '$(git fetch)'", "echo"],
    ["vp lint && git fetch", "vp"],
    ["vp lint || git fetch", "vp"],
    ["rg pattern lib | head", "rg"],
    ["vp lint; git fetch", "vp"],
    ["vp lint &", "vp"],
    ["vp lint\ngit fetch", "vp"],
    ['echo "$(git fetch)"', "echo"],
    ["echo `git fetch`", "echo"],
    ["cat <(rg pattern lib)", "cat"],
  ]);

  programTable("skips leading cd commands and uses the next useful program", [
    ["cd packages/client-runtime && vp lint run", "vp"],
    ['cd "a path with spaces"; git fetch', "git"],
    ["cd apps/site\npnpm run build", "pnpm"],
    ["cd first && cd second && bun run dev", "bun"],
    ["BUILD=1 cd apps/site && npm run build", "npm"],
    ["PATH+=:/tools npm run build", "npm"],
    ["PATH+=:/tools && npm run build", "npm"],
    ['TMP=$(mktemp -d); cd "$TMP"; npm pack ./package', "npm"],
    ["cd $(find . -type d | head -1) && git fetch", "git"],
    ["cd `find . -type d | head -1` && node script.js", "node"],
    ["cd /var/tmp 2>&1 && npm run build", "npm"],
    ["cd /var/tmp 2<&0 && pnpm run build", "pnpm"],
    ["cd /var/tmp &>/dev/null && bun run dev", "bun"],
    ["cd work |& npm run build", "npm"],
    ["cd /var/tmp && # use the selected workspace\nnpm run build", "npm"],
    ["export BUILD=1; # first note\n# second note\npnpm run build", "pnpm"],
    ["cd&&npm run build", "npm"],
    ["export BUILD=1;pnpm run build", "pnpm"],
    ["cd ${ROOT:-path;with;semicolons} && bun run dev", "bun"],
    ["cd ${ROOT:-path&&fallback} && node server.js", "node"],
    ["cd @(first|second) && npm run build", "npm"],
    ["cd /var/tmp \\\n&& npm run build", "npm"],
    ["/bin/zsh -lc 'cd apps/site && vp lint run'", "vp"],
  ]);

  programTable("skips shell setup commands and uses the next useful program", [
    ["source ~/.nvm/nvm.sh && nvm use", "nvm"],
    [". ./.env && pnpm run build", "pnpm"],
    ["export BUILD=1 && vp lint run", "vp"],
    ["unset VERBOSE; node server.js", "node"],
    ["export BUILD=1 && cd apps/site && pnpm run build", "pnpm"],
    ["/bin/zsh -lc 'source ~/.nvm/nvm.sh && nvm use'", "nvm"],
  ]);

  programTable("skips non-descriptive shell commands before a useful program", [
    ["set -eu; npm run build", "npm"],
    [": && npm run build", "npm"],
    ["true && npm run build", "npm"],
    ["false || npm run build", "npm"],
    ["false; npm run build", "npm"],
    ["sudo -n true && npm run build", "npm"],
    ["sudo -n true; echo checked", "echo"],
    ["test -d vendor || vp i", "vp"],
    ["[ -d vendor ] || vp i", "vp"],
  ]);

  it.each(
    ["cd /var/tmp", "export BUILD=1", "unset VERBOSE", "source vars.sh", ". vars.sh"].flatMap(
      (setup) =>
        ["&&", " || ", ";", "\n", "|", " |& ", " & "].map(
          (operator) => [`${setup}${operator}npm run build`, "npm"] as const,
        ),
    ),
  )("handles shell setup followed by every command separator: %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  programTable("unwraps shell command wrappers", [
    ["command git fetch", "git"],
    ["command -p git fetch", "git"],
    ["command -- git fetch", "git"],
    ["builtin printf ok", "printf"],
    ["builtin -- echo done", "echo"],
    ["command cd /var/tmp && npm run build", "npm"],
    ["builtin cd /var/tmp && pnpm run build", "pnpm"],
    ["exec node server.js", "node"],
    ["exec -cl -a worker node server.js", "node"],
    ["exec env BUILD=1 /opt/tools/check --quiet", "check"],
    ['exec "C:\\Program Files\\nodejs\\node.exe" app.js', "node.exe"],
    ["exec sh -c 'cd /var/tmp && npm run build'", "npm"],
    ["exec sh -c 'cd /var/tmp\nnpm run build'", "npm"],
    ["exec bash -c 'set -e\nnpm run build'", "npm"],
  ]);

  programTable("unwraps process-launch wrappers", [
    ["timeout 10 pnpm run build", "pnpm"],
    ["timeout 10s python3 script.py", "python3"],
    ["gtimeout 1.5 node server.js", "node"],
    ["nohup npx expo start >/var/tmp/metro.log 2>&1 &", "npx"],
    ["nohup -- env BUILD=1 bun run dev", "bun"],
    ["bundle exec rake test", "rake"],
    ["arch -arch x86_64 /usr/local/bin/verify", "verify"],
    ["arch -x86_64 ./out/demo-app", "demo-app"],
    ["timeout 30 nohup env BUILD=1 node server.js", "node"],
    ["timeout 60 script -q /dev/null env BUILD=1 node server.js", "node"],
  ]);

  it("treats a quoted sentence as data and labels the next command", () => {
    expect(commandProgramName('"=== CHECK FILE ==="; Get-Content notes.txt')).toBe("Get-Content");
  });

  programTable("keeps process-launch wrappers when no safe payload is present", [
    ["script session.txt", "script"],
    ["bundle update", "bundle"],
    ["nohup --help", "nohup"],
    ["timeout --version", "timeout"],
    ["arch", "arch"],
    ["/usr/bin/timeout 10 node server.js", "timeout"],
  ]);

  nullTable("does not treat shell lookup and commandless wrapper forms as executions", [
    "exec",
    "command -pv cargo",
    "command -a npm",
    "builtin -p",
    "command -V make",
    "exec 2> errors.txt",
    "command -v node",
    "exec --",
    "exec cd /var/tmp && npm run build",
    "exec env BUILD=1 cd /var/tmp && npm run build",
    "exec BUILD=1 npm run build",
    "env BUILD=1 cd /var/tmp && npm run build",
    "env BUILD=1; npm run build",
    "sudo cd /var/tmp && npm run build",
    "command BUILD=1 npm run build",
    "command false && npm run build",
    "cd /var/tmp <<EOF\nunterminated heredoc",
    "cd /var/tmp && >/var/tmp/log",
    "(xcrun simctl io booted recordVideo /var/tmp/video.mp4 &) ; wait",
    "export BUILD=1 && (bundle exec pod install || pod install)",
    '"md5(file)=$sum"',
    "$PYTHON tools/run.py",
    "& { Get-ChildItem }",
    "!RUNNER! --help",
    "%RUNNER% --help",
    "${RUNNER} --help",
    "& $runner --help",
    "$body = @{ 'k' = 'v' }; Invoke-RestMethod https://api.test",
    "$name = 'kora'",
    "broken{",
    ":: note to self",
    "@echo on",
    "time -- npm run build",
    "time -v npm run build",
    "coproc npm run build",
    "coproc worker { npm run build; }",
    "cd [first|second] && pnpm run build",
    "# just a note",
    "for($n=1; $n -le 3; $n++){ Start-Sleep 2 }",
    "try { Get-Item x } catch { Write-Host $_ }",
    "pnpm) --help",
  ]);

  programTable("does not hide legitimate or case-distinct program names", [
    ["rem another note", "rem"],
    ["process --version", "process"],
    ["hash --version", "hash"],
    ["parallel -j8 echo", "parallel"],
    ["Exec node server.js", "Exec"],
    ["CD /var/tmp && npm run build", "CD"],
  ]);

  programTable("parses shell setup inside an explicitly launched shell", [
    ["env sh -c 'cd /var/tmp && npm run build'", "npm"],
    ["sudo zsh -lc 'export BUILD=1 && pnpm run build'", "pnpm"],
  ]);

  programTable("skips shell precommand modifiers", [
    ["nocorrect pnpm run build", "pnpm"],
    ["noglob bun run dev", "bun"],
    ["time node server.js", "node"],
    ["time -p deno task start", "deno"],
    ["time nocorrect npm run build", "npm"],
  ]);

  it("uses the command after leading shell comments", () => {
    expect(commandProgramName("# first comment\n  # second comment\ngit fetch")).toBe("git");
  });

  programTable("skips comments after commandless shell setup", [
    ["BUILD=1 # note\nnpm run build", "npm"],
    ["BUILD=1 # it's configured\nnpm run build", "npm"],
    ['BUILD=1 # "unterminated quote\nbun run dev', "bun"],
    [">/var/tmp/log # note\npnpm run build", "pnpm"],
    [">/var/tmp/log # it's configured\ndeno task start", "deno"],
  ]);

  programTable("does not treat qualified paths as shell syntax", [
    ["./cd /var/tmp && npm run build", "cd"],
    ["/opt/exec node server.js", "exec"],
    ["/usr/bin/time npm run build", "time"],
    ["/usr/bin/test -f tsconfig.json", "test"],
  ]);

  it("skips a shell array assignment before the command", () => {
    expect(commandProgramName("items=(red green); npm run build")).toBe("npm");
  });

  programTable("resolves literal command aliases from earlier shell segments", [
    ['EMU="/opt/android/emulator"; "$EMU" -list-avds', "emulator"],
    ["AAPT=/opt/android/aapt2\n$AAPT dump badging app.apk", "aapt2"],
    [
      'SSH=(ssh -i /var/tmp/key -o IdentitiesOnly=yes); HOST=user@example; "${SSH[@]}" "$HOST" uptime',
      "ssh",
    ],
    [
      "SCP=(/usr/bin/scp -i /var/tmp/key); if true; then ${SCP[@]} file user@example:/var/tmp; fi",
      "scp",
    ],
    ['TOOL="/Applications/My Tool/bin/check"; "$TOOL" --quiet', "check"],
  ]);

  nullTable("does not evaluate dynamic or non-persistent command aliases", [
    'TOOL=$(choose-tool); "$TOOL" --version',
    'TOOL="git fetch"; "$TOOL"',
    "# TOOL=git\n$TOOL status",
    'TOOL=git true; "$TOOL" status',
    'TOOL=git; TOOL=$(choose-tool); "$TOOL" status',
    'TOOL=git; unset TOOL; "$TOOL" status',
  ]);

  it("does not retain aliases assigned inside control flow", () => {
    expect(commandProgramName('TOOL=git; if false; then\nTOOL=npm\nfi\n"$TOOL" status')).toBe(
      "git",
    );
  });

  programTable("keeps expansions inside assignment words", [
    ["ROOT=${BASE:-path with spaces}; npm run build", "npm"],
    ["ROOT=`printf 'path with spaces'`; pnpm run build", "pnpm"],
  ]);

  programTable("skips redirections before the next command", [
    [">/var/tmp/log && npm run build", "npm"],
    ["2>/var/tmp/error.log; pnpm run build", "pnpm"],
    ["cd /var/tmp && >/var/tmp/log npm run build", "npm"],
    ["cd /var/tmp && > /var/tmp/log pnpm run build", "pnpm"],
    ["cd /var/tmp && 2>&1 bun run dev", "bun"],
    ["cd /var/tmp && 2>& 1 node server.js", "node"],
    ["cd /var/tmp && &>/var/tmp/log git fetch", "git"],
    ["cd /var/tmp && *>>/var/tmp/log vp lint", "vp"],
    ["cd /var/tmp && {output}>/var/tmp/log deno task start", "deno"],
    ["cd /var/tmp && <<<input ruby script.rb", "ruby"],
  ]);

  programTable("skips heredoc bodies before finding the next command", [
    ["cd /var/tmp <<EOF\nnot-a-command\nEOF\nnpm run build", "npm"],
    ["cd /var/tmp <<'EOF'\nnot-a-command\nEOF\npnpm run build", "pnpm"],
    ["cd /var/tmp <<'EOF'\nnot-a-command\\\nEOF\npnpm run build", "pnpm"],
    ["cd /var/tmp <<-EOF\n\tnot-a-command\n\tEOF\nbun run dev", "bun"],
    ["cd /var/tmp <<A <<B\none\nA\ntwo\nB\ngit fetch", "git"],
    ["cd /var/tmp <<EOF; # setup\nnot-a-command\nEOF\nnpm run build", "npm"],
    ["cd /var/tmp <<EOF && pnpm run build\nnot-a-command\nEOF\nbun run dev", "pnpm"],
  ]);

  nullTable("falls back when no useful program follows cd", [
    "cd one && cd two",
    "cd apps/site || exit 1",
    "cd apps/site && [ -f tsconfig.json ]",
  ]);

  nullTable("does not label commands inside multiline shell control flow", [
    "if test -f tsconfig.json\nthen\n  npm run build\nfi",
    "[[ -d first && -d second ]] && npm run build",
    'for entry in *\ndo\n  echo "$entry"\ndone',
    "while true\ndo\n  sleep 2\ndone",
    "cd /var/tmp; build () { npm run build; }",
  ]);

  /** Wraps `inner` in `sh -c '...'` the given number of times, escaping quotes each round. */
  const nestedSh = (inner: string, times: number): string =>
    times === 0 ? inner : nestedSh(`sh -c '${inner.replaceAll("'", "'\\''")}'`, times - 1);
  const setup = (count: number) =>
    Array.from({ length: count }, (_, n) => `export SETTING_${n}=on`);

  it("bounds nested shell unwrapping", () => {
    expect(labelOf(nestedSh("git fetch", 9))).toBeNull();
  });

  it("does not spend the shell nesting budget on setup commands", () => {
    expect(labelOf([...setup(10), "npm run build"].join("\n"))).toBe("npm");
  });

  it("bounds the number of top-level setup segments", () => {
    expect(labelOf([...setup(2_000), "npm run build"].join(";"))).toBeNull();
  });

  it("bounds nested command wrappers", () => {
    expect(labelOf("command ".repeat(9) + "git fetch")).toBeNull();
  });
});
