import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SchemaGetter from "effect/SchemaGetter";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";

// Schema's default formatter includes actual values. These diagnostics cross
// process and UI boundaries, so retain only issue kinds and bounded paths.

/**
 * A `Getter` that parses a lenient JSON string (tolerating trailing commas
 * and JS-style comments) into an unknown value.
 *
 * Mirrors `SchemaGetter.parseJson()` but strips JSONC syntax before parsing.
 */
const QUOTED = String.raw`("(?:[^"\\]|\\.)*")`;
const decodeJsonString = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const parseLenientJsonGetter = SchemaGetter.onSome((input: string) => {
  // Single-line comments, then multi-line comments, then trailing commas before `}` or `]`.
  // Every pattern starts with an alternative that swallows quoted strings, so text inside a
  // string (a comma in `{"note":"a,]"}`, say) is never mistaken for syntax and removed.
  const stripped = [
    { pattern: new RegExp(QUOTED + "|//[^\\n]*", "g"), keep: () => "" },
    { pattern: new RegExp(QUOTED + "|/\\*[\\s\\S]*?\\*/", "g"), keep: () => "" },
    {
      pattern: new RegExp(QUOTED + "|,(\\s*[}\\]])", "g"),
      keep: (bracket?: string) => bracket ?? "",
    },
  ].reduce(
    (text, { pattern, keep }) =>
      text.replace(pattern, (whole: string, quoted?: string, extra?: string) =>
        quoted ? whole : keep(extra),
      ),
    input,
  );

  const decoded = decodeJsonString(stripped).pipe(Effect.mapError(({ issue }) => issue));
  return Effect.map(decoded, (value) => Option.some(value));
});

/**
 * Schema transformation: lenient JSONC string ↔ unknown.
 *
 * Same API as `SchemaTransformation.fromJsonString`, but the decode side
 * strips trailing commas and JS-style comments before parsing.
 * Encoding produces strict JSON via `JSON.stringify`.
 */
const strictJsonEncoder = SchemaGetter.stringifyJson();
const fromLenientJsonString = new SchemaTransformation.Transformation(
  parseLenientJsonGetter,
  strictJsonEncoder,
);

/**
 * Build a schema that decodes a lenient JSON string into `A`.
 *
 * Drop-in replacement for `Schema.fromJsonString(schema)` that tolerates
 * trailing commas and comments in the input.
 */
export const parseLenientJson = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromLenientJsonString));
