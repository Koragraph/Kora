import { fetchPrimaryHost } from "../hosts/primary/shellAuth";

/**
 * Ask the daemon to re-read plan limits through each CLI (no turn, no tokens). Results arrive on the config stream.
 * Without `force` the daemon skips every provider read less than a minute ago; `force` is the Refresh button.
 */
export async function refreshPlanUsage(
  httpBaseUrl: string,
  provider?: string,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = fetchPrimaryHost,
  force = false,
): Promise<void> {
  const res = await fetchImpl(new URL("/api/usage/refresh", httpBaseUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(provider ? { provider } : {}), ...(force ? { force: true } : {}) }),
  });
  if (!res.ok) throw new Error(`Usage refresh failed (${res.status})`);
}
