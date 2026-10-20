import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";

// ---------------------------------------------------------------------------
// Strings and numbers
// ---------------------------------------------------------------------------

/** A string that is trimmed on the way in and on the way out. */
const trimBothWays = SchemaTransformation.transform({
  encode: (value: string) => value.trim(),
  decode: (value: string) => value.trim(),
});

export const TrimmedString = Schema.String.pipe(Schema.decodeTo(Schema.String, trimBothWays));

/** Trimmed, and not empty afterwards. */
export const NonblankString = TrimmedString.check(Schema.isNonEmpty());

/** Integers from `minimum` up. */
const intFrom = (minimum: number) => Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimum));
export const WholeNumber = intFrom(0);
export const CountingNumber = intFrom(1);
export const PortSchema = Schema.Int.check(Schema.isBetween({ maximum: 65_535, minimum: 1 }));

/** An ISO-8601 instant carried as text; the format is not checked. */
export const IsoInstant = Schema.String;
export type IsoInstant = Schema.Schema.Type<typeof IsoInstant>;

// ---------------------------------------------------------------------------
// Forward-compatible codecs. A newer server may send values this build cannot
// decode; these keep one unknown value from failing the whole payload.
// ---------------------------------------------------------------------------

/** Optional key; a value that does not decode under `valueSchema` reads as absent. */
export const ForwardCompatibleOptional = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  valueSchema: S,
) => {
  const decodeValue = Schema.decodeUnknownOption(valueSchema);
  return Schema.optionalKey(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.optionalKey(Schema.toType(valueSchema)),
      SchemaTransformation.transformOptional({
        decode: (input: Option.Option<unknown>) => Option.flatMap(input, decodeValue),
        encode: (input: Option.Option<S["Type"]>) => input,
      }),
    ),
  );
};

/** Nullable; a missing or undecodable value reads as `null`. */
export const ForwardCompatibleNullable = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  valueSchema: S,
) => {
  const decodeValue = Schema.decodeUnknownOption(valueSchema);
  return Schema.Unknown.pipe(
    Schema.decodeTo(
      Schema.NullOr(Schema.toType(valueSchema)),
      SchemaTransformation.transform({
        decode: (input: unknown): S["Type"] | null => Option.getOrNull(decodeValue(input)),
        encode: (input: S["Type"] | null): unknown => input,
      }),
    ),
    // A missing key reads as null too.
    Schema.withDecodingDefault(Effect.succeed(null)),
  );
};

/** Array that silently drops elements which do not decode under `elementSchema`. */
export const LenientArray = <S extends Schema.Top & { readonly DecodingServices: never }>(
  elementSchema: S,
) => {
  const decodeElement = Schema.decodeUnknownOption(elementSchema);
  return Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.toType(elementSchema)),
      SchemaTransformation.transform({
        decode: (items: ReadonlyArray<unknown>): ReadonlyArray<S["Type"]> =>
          items.flatMap((item) => {
            const decoded = decodeElement(item);
            return Option.isSome(decoded) ? [decoded.value] : [];
          }),
        encode: (items: ReadonlyArray<S["Type"]>): ReadonlyArray<unknown> => items,
      }),
    ),
  );
};

// ---------------------------------------------------------------------------
// Entity ids
// ---------------------------------------------------------------------------

const makeId = <B extends string>(brand: B) => NonblankString.pipe(Schema.brand(brand));

export const ThreadId = makeId("ThreadId");
export type ThreadId = Schema.Schema.Type<typeof ThreadId>;
export const ProjectId = makeId("ProjectId");
export type ProjectId = Schema.Schema.Type<typeof ProjectId>;
export const HostId = makeId("HostId");
export type HostId = Schema.Schema.Type<typeof HostId>;
export const DispatchCommandId = makeId("DispatchCommandId");
export type DispatchCommandId = Schema.Schema.Type<typeof DispatchCommandId>;
export const EventId = makeId("EventId");
export type EventId = Schema.Schema.Type<typeof EventId>;
export const ItemId = makeId("ItemId");
export type ItemId = Schema.Schema.Type<typeof ItemId>;
export const TurnId = makeId("TurnId");
export type TurnId = Schema.Schema.Type<typeof TurnId>;
export const DaemonSessionId = makeId("DaemonSessionId");
export type DaemonSessionId = Schema.Schema.Type<typeof DaemonSessionId>;
export const AgentItemId = makeId("AgentItemId");
export type AgentItemId = Schema.Schema.Type<typeof AgentItemId>;
export const RuntimeSessionId = makeId("RuntimeSessionId");
export type RuntimeSessionId = Schema.Schema.Type<typeof RuntimeSessionId>;
export const RuntimeItemId = makeId("RuntimeItemId");
export type RuntimeItemId = Schema.Schema.Type<typeof RuntimeItemId>;
export const RuntimeRequestId = makeId("RuntimeRequestId");
export type RuntimeRequestId = Schema.Schema.Type<typeof RuntimeRequestId>;
export const RuntimeTaskId = makeId("RuntimeTaskId");
export type RuntimeTaskId = Schema.Schema.Type<typeof RuntimeTaskId>;
export const RequestId = makeId("RequestId");
export type RequestId = Schema.Schema.Type<typeof RequestId>;
export const TurnCheckpointRef = makeId("TurnCheckpointRef");
export type TurnCheckpointRef = Schema.Schema.Type<typeof TurnCheckpointRef>;

export const RpcClientId = WholeNumber.pipe(Schema.brand("RpcClientId"));
export type RpcClientId = (typeof RpcClientId)["Type"];

// ---------------------------------------------------------------------------
// Client environment vocabularies
// ---------------------------------------------------------------------------

/** The product surface a client is. Optional wherever used: old clients never send it. */
export const ClientSurface = Schema.Literals(["web", "desktop", "mobile", "cli"]);
export type ClientSurface = (typeof ClientSurface)["Type"];

export const ClientOs = Schema.Literals([
  "macOS",
  "Windows",
  "Linux",
  "iOS",
  "Android",
  "ChromeOS",
  "other",
  "unknown",
]);
export type ClientOs = (typeof ClientOs)["Type"];

export const ClientDeviceType = Schema.Literals(["desktop", "phone", "tablet", "unknown"]);
export type ClientDeviceType = (typeof ClientDeviceType)["Type"];

export const ClientWebDeployment = Schema.Literals(["hosted", "server"]);
export type ClientWebDeployment = (typeof ClientWebDeployment)["Type"];

export const ClientLinkMethod = Schema.Literals(["direct", "unknown"]);
export type ClientLinkMethod = Schema.Schema.Type<typeof ClientLinkMethod>;
