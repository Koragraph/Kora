export interface UpdateControl {
  readonly pause: boolean;
  readonly message?: string | undefined;
  readonly minVersion?: string | undefined;
}

export const DEFAULT_UPDATE_CONTROL_URL =
  "https://raw.githubusercontent.com/agilkatakam/kora/main/update-control.json";

export async function fetchUpdateControl(
  url: string = DEFAULT_UPDATE_CONTROL_URL,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = 3000,
): Promise<UpdateControl | null> {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await fetchFn(url, { signal });
    if (!res.ok) return null;
    const json = await res.json();
    if (typeof json === "object" && json !== null) {
      const record = json as Record<string, unknown>;
      return {
        pause: Boolean(record.pause),
        message: typeof record.message === "string" ? record.message : undefined,
        minVersion: typeof record.minVersion === "string" ? record.minVersion : undefined,
      };
    }
    return null;
  } catch {
    // Fail-open: any network error, timeout, or parse failure must never block updates.
    return null;
  }
}
