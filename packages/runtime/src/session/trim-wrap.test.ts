import { test } from 'node:test';
import assert from 'node:assert';
import { splitAndAnd, isRunnerWords, segmentWords, wrapRunnerCommand, unwrapRunnerCommand, alreadyTrimmed, type WrapSpec } from './trim-wrap';

const W: WrapSpec = { node: '/opt/n ode/bin/node', kora: '/k/bin/kora.js', home: "/h/it's", thread: 'T1' };
const wrap = (c: string) => wrapRunnerCommand(c, W);
const words = (c: string) => segmentWords(c).map((w) => w.text);

test('recognised test / build runners are wrapped; everything else is left alone', () => {
  for (const c of ['npm test', 'pnpm test', 'pnpm -r test', 'pnpm --filter @kora/runtime test', 'pnpm run build', 'npm run test:unit -- --reporter=dot', 'yarn build', 'bun test', 'npx tsc -p tsconfig.json', 'pnpm exec vitest run', 'vitest run src/a.test.ts', 'pytest -x tests/', 'python -m pytest', 'python3 -m unittest discover', 'cargo test', 'cargo build --release', 'go test ./...', 'go build ./...', 'make test', 'make', './gradlew test', 'mvn test', 'dotnet test', 'node --test dist/a.test.js', 'tsc --noEmit', 'npx eslint .', 'vp test', 'next build', 'vite build', 'bundle exec rspec', 'CI=1 npm test', 'NODE_ENV=test pnpm run test', 'pnpm typecheck', 'pnpm run lint:win']) {
    assert.ok(wrap(c), `wrapped: ${c}`);
  }
  for (const c of ['ls -la', 'git status', 'cat README.md', 'echo hi', 'npm install', 'pnpm install', 'pnpm add left-pad', 'node server.js', 'python script.py', 'cargo run', 'go run main.go', 'npm run dev', 'pnpm run start', 'vite', 'vite dev', 'next dev', 'vitest --watch', 'tsc -w', 'tsc --watch', 'jest --watchAll', 'npm test -- --watch', 'rg test src', 'sed -n 1,5p x', 'docker build .', 'kora graph explore x', 'npx create-react-app x', 'pnpm exec prettier-plugin-foo']) {
    assert.equal(wrap(c), null, `left alone: ${c}`);
  }
});

test('only the program word gets the wrapper: env assignments, cd, args and quoting stay the model\'s own text', () => {
  const w = wrap("cd packages/runtime && FOO='a b' pnpm test -- --grep \"x y\" 2>&1")!;
  assert.ok(w.startsWith('cd packages/runtime && '), 'cd untouched and still in the outer shell');
  assert.match(w, /FOO='a b' '\/opt\/n ode\/bin\/node' '\/k\/bin\/kora.js' trim-run --home '\/h\/it'\\''s' --thread 'T1' -- pnpm test -- --grep "x y" 2>&1$/);
  assert.equal(unwrapRunnerCommand(w), "cd packages/runtime && FOO='a b' pnpm test -- --grep \"x y\" 2>&1", 'the model\'s own command comes back out');
  assert.equal(unwrapRunnerCommand('echo hi'), 'echo hi');
});

test('every runner segment of an && chain is wrapped, the rest is not', () => {
  const w = wrap('cd pkg && npx tsc -p tsconfig.json && node --test dist/a.test.js && echo done')!;
  assert.equal((w.match(/trim-run --home/g) ?? []).length, 2);
  assert.ok(w.endsWith('&& echo done'));
  assert.equal(unwrapRunnerCommand(w), 'cd pkg && npx tsc -p tsconfig.json && node --test dist/a.test.js && echo done');
});

test('shapes the rewrite could change the meaning of are refused whole', () => {
  for (const c of ['npm test | tail -50', 'npm test > out.txt', 'npm test >> out.txt', 'npm test 2> err.txt', 'npm test; echo $?', 'npm test || true', 'npm test &', '(cd x && npm test)', 'echo $(npm test)', 'echo `npm test`', 'npm test <<EOF\nx\nEOF', 'npm test\nnpm run build', 'npm test # comment', 'npm test < in.txt', 'npm test "unclosed', "npm test 'unclosed", '! npm test', '{ npm test; }', 'cd x; npm test', 'npm test &> log', 'a=$(echo 1) npm test']) {
    assert.equal(wrap(c), null, `refused: ${JSON.stringify(c)}`);
  }
  assert.ok(wrap('npm test 2>&1'), '2>&1 is allowed');
  assert.ok(wrap('npm test "a|b;c" \'d>e\''), 'metacharacters inside quotes are data');
  assert.equal(wrap(''), null);
  assert.equal(wrap('x'.repeat(5000)), null);
});

test('splitAndAnd keeps whitespace so the chain re-joins to the same text; segmentWords unquotes', () => {
  assert.deepEqual(splitAndAnd('a  &&  b && c'), ['a  ', '  b ', ' c']);
  assert.deepEqual(words(`FOO="a b" 'c d' e\\ f`), ['FOO=a b', 'c d', 'e f']);
  assert.equal(isRunnerWords(['npm', 'test']), true);
  assert.equal(isRunnerWords([]), false);
});

test('alreadyTrimmed spots the wrapper\'s footer, not the PostToolUse one', () => {
  assert.ok(alreadyTrimmed('x\n[Kora compressed this output (test-node): dropped 3; ...]'));
  assert.ok(!alreadyTrimmed('x\n[Kora compressed this stdout (test-node): dropped 3; ...]'));
});
