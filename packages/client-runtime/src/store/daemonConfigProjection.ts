import type { DaemonConfig, DaemonConfigStreamEvent } from "@kora/contracts";
import * as Option from "effect/Option";

export interface DaemonConfigProjection {
  readonly source: "cache" | "live";
  readonly latestEvent: DaemonConfigStreamEvent;
  readonly config: DaemonConfig;
}

/**
 * Cached config keeps the provider and model catalog available across reconnects.
 * Published themes and usage-limit sources are current machine state, so a
 * cache could restore a set the machine no longer reports. Replay sends both
 * as separate events.
 */
export function withoutHostThemes(config: DaemonConfig): DaemonConfig {
  if (config.hostThemes === undefined && config.usageLimitSources === undefined) {
    return config;
  }
  const { hostThemes: _themes, usageLimitSources: _sources, ...rest } = config;
  return rest;
}

const liveProjection = (
  config: DaemonConfig,
  latestEvent: DaemonConfigStreamEvent,
): DaemonConfigProjection => ({ latestEvent, source: "live", config });

export function applyDaemonConfigProjection(
  current: Option.Option<DaemonConfigProjection>,
  event: DaemonConfigStreamEvent,
): Option.Option<DaemonConfigProjection> {
  if (event.type === "snapshot") {
    // Wire snapshots never contain published themes. Keep the previous set
    // until a capable server sends its authoritative theme event. A legacy
    // server cannot send a later removal, so a downgrade must clear the set.
    const { capabilities } = event.config.environment;
    const previous = Option.isSome(current) ? current.value.config : undefined;
    const hostThemes = capabilities.hostThemes === true ? previous?.hostThemes : undefined;
    const usageLimitSources =
      capabilities.usageLimitSources === true ? previous?.usageLimitSources : undefined;
    return Option.some(
      liveProjection(
        {
          ...event.config,
          ...(hostThemes === undefined ? {} : { hostThemes }),
          ...(usageLimitSources === undefined ? {} : { usageLimitSources }),
        },
        event,
      ),
    );
  }
  const patch = ((): Partial<DaemonConfig> | null => {
    switch (event.type) {
      case "providerStatuses":
        return { providers: event.payload.providers };
      case "settingsUpdated":
        return { settings: event.payload.settings };
      case "hostThemesUpdated": {
        const { themes } = event.payload;
        return { hostThemes: themes.length > 0 ? themes : undefined };
      }
      case "usageLimitSourcesUpdated": {
        const { sources } = event.payload;
        return { usageLimitSources: sources.length > 0 ? sources : undefined };
      }
      default:
        return null;
    }
  })();
  if (patch === null) return current;
  return Option.map(current, (projection) =>
    liveProjection({ ...projection.config, ...patch }, event),
  );
}
