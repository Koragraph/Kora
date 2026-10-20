import { useEffect, useRef } from "react";

export function workspaceMutationRefreshToken(
  resource: string,
  mutation: string | null,
): string | null {
  if (mutation === null) return null;
  return [resource, mutation].join("\u0000");
}

/**
 * Refreshes once per mutation and resource. Disabled mutations stay pending,
 * which lets an editable file catch up after its local save finishes.
 */
export function useWorkspaceMutationRefresh(options: {
  readonly resourceKey: string;
  readonly refresh: () => void;
  readonly mutationId: string | null;
  readonly enabled?: boolean;
}): void {
  const { enabled = true, mutationId, refresh, resourceKey } = options;
  const handledTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (enabled === false) return;
    const tok = workspaceMutationRefreshToken(resourceKey, mutationId);
    if (tok === null || tok === handledTokenRef.current) return;
    handledTokenRef.current = tok;
    refresh();
  }, [enabled, mutationId, refresh, resourceKey]);
}
