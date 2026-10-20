import * as Schema from "effect/Schema";

/**
 * Key of one `settings.usageLimitSources` entry. Lives in its own module so
 * both the settings and the usage-limit contracts can import it without
 * importing each other.
 */
export const QuotaSourceId = Schema.String.pipe(Schema.brand("QuotaSourceId"));
export type QuotaSourceId = typeof QuotaSourceId.Type;
