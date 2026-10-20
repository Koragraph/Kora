// One connect flow at a time per component. `connect(toolkit, alias)` opens the browser and polls; `phase` drives the
// UI; `reset` returns to idle (also stops a poll that is still waiting).
import { useCallback, useEffect, useRef, useState } from "react";

import { localApiOrThrow } from "~/localApi";
import { useAppsApi } from "./appsApi";
import { runConnect, type ConnectPhase } from "./connectFlow";

export function useConnectApp(
  onConnected?: (toolkit: string, account: { id: string; alias: string | null }) => void,
) {
  const api = useAppsApi();
  const [phase, setPhase] = useState<ConnectPhase>({ phase: "idle" });
  const token = useRef(0);
  const cb = useRef(onConnected);
  cb.current = onConnected;
  useEffect(
    () => () => {
      token.current += 1; // unmounting stops the poll
    },
    [],
  );
  const connect = useCallback(
    async (toolkit: string, alias: string | null) => {
      const mine = ++token.current;
      const final = await runConnect(toolkit, alias, {
        api,
        open: (url) => localApiOrThrow().shell.openExternal(url),
        onPhase: (p) => {
          if (token.current === mine) setPhase(p);
        },
        cancelled: () => token.current !== mine,
      });
      if (token.current === mine && final.phase === "connected")
        cb.current?.(final.toolkit, final.account);
      return final;
    },
    [api],
  );
  const reset = useCallback(() => {
    token.current += 1;
    setPhase({ phase: "idle" });
  }, []);
  return { phase, connect, reset };
}
