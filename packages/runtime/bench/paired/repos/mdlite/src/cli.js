#!/usr/bin/env node
import fs from 'node:fs';
import { render, renderText } from './index.js';
import { anchorPlugin } from './plugins/anchors.js';
import { tocPlugin } from './plugins/toc.js';

export function run(argv, read = (f) => fs.readFileSync(f, 'utf8')) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const files = argv.filter((a) => !a.startsWith('--'));
  if (files.length !== 1) throw new Error('usage: mdlite [--text] [--toc] [--anchors] <file.md>');
  const source = read(files[0]);
  if (flags.has('--text')) return renderText(source);
  const plugins = [];
  if (flags.has('--anchors')) plugins.push(anchorPlugin);
  if (flags.has('--toc')) plugins.push(tocPlugin());
  return render(source, { plugins });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    process.stdout.write(run(process.argv.slice(2)));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
}
