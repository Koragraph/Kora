// "Name in the picker" reaches the advertised provider entry the picker reads (pl9 S2-1).
import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { daemonConfig } from "./config.ts";
import { applyProviderDisplayNames } from "./providerNames.ts";

const claude = () =>
  (daemonConfig.providers as unknown as Array<{ instanceId: string; displayName?: string }>).find(
    (p) => p.instanceId === "claude",
  )!;

NodeTest.test(
  "a provider name set in Settings shows in the picker, and clearing it restores the default",
  () => {
    const own = claude().displayName ?? "";
    NodeAssert.equal(
      applyProviderDisplayNames({
        providerInstances: { claude: { displayName: " Work Claude " } },
      }),
      true,
    );
    NodeAssert.equal(claude().displayName, "Work Claude");
    NodeAssert.equal(
      applyProviderDisplayNames({
        providerInstances: { claude: { displayName: " Work Claude " } },
      }),
      false,
      "no change, no push",
    );
    // A model probe rebuilds the entry with the daemon's own name: the user's name goes back on.
    claude().displayName = own;
    NodeAssert.equal(
      applyProviderDisplayNames({ providerInstances: { claude: { displayName: "Work Claude" } } }),
      true,
    );
    NodeAssert.equal(claude().displayName, "Work Claude");
    applyProviderDisplayNames({ providerInstances: { claude: {} } });
    NodeAssert.equal(claude().displayName, own);
  },
);
