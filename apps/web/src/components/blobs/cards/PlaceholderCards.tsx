// Any card kind this client does not know falls back to its one-line summary.
import { InfoIcon } from "lucide-react";

import { CardLine } from "./CardLine";

export function UnknownCard({ label }: { readonly label: string }) {
  return (
    <CardLine icon={InfoIcon} kind="unknown" muted>
      {label}
    </CardLine>
  );
}
