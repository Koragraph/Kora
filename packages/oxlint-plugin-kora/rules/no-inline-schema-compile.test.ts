import { expect } from "vite-plus/test";

import { lintRule } from "../test/utils.ts";

const rule = lintRule("kora/no-inline-schema-compile");
const header = `import * as Schema from "effect/Schema";\n`;

rule.allows(
  "a decoder compiled once at module scope",
  `${header}const decode = Schema.decodeUnknownSync(User);\nexport const f = (x: unknown) => decode(x);`,
);
rule.allows(
  "a compiled function kept in a local",
  `${header}export const f = (x: unknown) => { const decode = Schema.decodeUnknownSync(User); return decode(x); };`,
);
rule.allows(
  "a compiler applied to a local schema value",
  `${header}export const f = (s: Schema.Top, x: unknown) => Schema.decodeUnknownSync(s)(x);`,
);
rule.allows(
  "a schema built (not compiled) in a function",
  `${header}export const f = () => Schema.Struct({ a: Schema.String });`,
);

rule.reports(
  "decoding with a module schema inside a function",
  `${header}export const f = (x: unknown) => Schema.decodeUnknownSync(User)(x);`,
  (output) => expect(output).toContain("the compiled function is rebuilt on every call"),
);
rule.reports(
  "decoding with a schema built on the spot",
  `${header}export function f(x: unknown) { return Schema.decodeUnknownExit(Schema.Struct({ a: Schema.Number }))(x); }`,
  (output) => expect(output).toContain("both the inline schema literal and the compiled function"),
);
rule.reports(
  "an is() guard with a namespaced schema",
  `${header}export const ok = (x: unknown) => Schema.is(Models.User)(x);`,
);
rule.reports(
  "JSON decoding of a static schema",
  `${header}export const read = (t: string) => Schema.decodeSync(Schema.fromJsonString(User))(t);`,
);
