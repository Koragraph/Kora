#!/usr/bin/env node
import * as submit from './commands/submit.js';
import * as status from './commands/status.js';
import * as retryInfo from './commands/retry-info.js';
import * as worker from './commands/worker.js';
import { createContext } from './context.js';

const COMMANDS = { submit, status, 'retry-info': retryInfo, worker };
const NUMERIC = new Set(['priority', 'delay', 'attempts']);

// argv (without node and the script) → { command, positional, options }
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const positional = [];
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    const name = token.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`option --${name} needs a value`);
    options[name] = NUMERIC.has(name) ? Number(value) : value;
    i += 1;
  }
  return { command, positional, options };
}

export function usage() {
  return ['usage: taskflow <command>', ...Object.values(COMMANDS).map((c) => '  ' + c.help)].join('\n');
}

export async function main(argv, { out = console.log, ctx = createContext() } = {}) {
  const args = parseArgs(argv);
  const command = COMMANDS[args.command];
  if (!command) {
    out(usage());
    return 2;
  }
  await command.run(args, ctx, out);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
