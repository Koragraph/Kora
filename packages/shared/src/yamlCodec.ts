import {
  type ToStringOptions,
  type ToJSOptions,
  type SchemaOptions,
  type ParseOptions,
  type DocumentOptions,
  type CreateNodeOptions,
  stringify as stringifyYamlValue,
  parse as parseYamlString,
  YAMLParseError,
} from "yaml";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as SchemaIssue from "effect/SchemaIssue";
import * as SchemaGetter from "effect/SchemaGetter";
import * as Effect from "effect/Effect";

export type YamlParseOptions = ToJSOptions & SchemaOptions & DocumentOptions & ParseOptions;
export type YamlStringifyOptions = ToStringOptions &
  CreateNodeOptions &
  ParseOptions &
  SchemaOptions &
  DocumentOptions;

function formatYamlParseError(error: unknown): string {
  if (error instanceof YAMLParseError) {
    const first = error.linePos?.[0];
    const where = first ? `, line=${first.line}, column=${first.col}` : "";
    return `Invalid YAML (code=${error.code}${where}).`;
  }
  return "Invalid YAML.";
}

/** Parses YAML during decoding, reporting parse failures as InvalidValue issues. */
function parseYaml<E extends string>(options?: YamlParseOptions): SchemaGetter.Getter<unknown, E> {
  const attempt = (input: E) =>
    Effect.try({
      catch: (error) => new SchemaIssue.InvalidValue({ message: formatYamlParseError(error) }),
      try: () => parseYamlString(input, options) as unknown,
    });
  return SchemaGetter.transformOrFail(attempt);
}

/** Serializes YAML during encoding, reporting stringify failures as InvalidValue issues. */
function stringifyYaml(options?: YamlStringifyOptions): SchemaGetter.Getter<string, unknown> {
  const attempt = (input: unknown) =>
    Effect.try({
      catch: () => new SchemaIssue.InvalidValue({ message: "Failed to stringify YAML." }),
      try: () => stringifyYamlValue(input, options),
    });
  return SchemaGetter.transformOrFail(attempt);
}

/**
 * Decodes a YAML string and encodes a value as YAML text.
 *
 * **When to use**
 *
 * Use when you need a schema transformation to decode YAML stored or
 * transmitted as a string before validating the parsed structure.
 *
 * **Details**
 *
 * Decode and encode failures become `InvalidValue` schema issues.
 *
 * **Example** (Parsing YAML)
 *
 * ```ts
 * import * as Schema from "effect/Schema"
 * import { fromYamlString } from "@kora/shared/yamlCodec"
 *
 * const schema = Schema.String.pipe(Schema.decodeTo(Schema.Unknown, fromYamlString))
 * ```
 */
export const fromYamlString = new SchemaTransformation.Transformation<unknown, string>(
  /* decode */ parseYaml(),
  /* encode */ stringifyYaml(),
);
