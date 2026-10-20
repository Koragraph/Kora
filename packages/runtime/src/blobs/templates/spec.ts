// The shape of one starter blob (structural twin of the contract's BlobTemplate; the runtime never imports @kora/contracts).
// SOUL texts live beside this file, one per blob; templates.ts assembles them. SOULs are plain text: no backticks and
// no template placeholders inside them (they are TS template literals).
export interface StarterSpec {
  id: string;
  name: string;
  title: string;
  /** One line: what this blob does. Also the "does:" line of its capability card. */
  job: string;
  /** Three bullets for the proposal / gallery card ("How it works"). */
  howItWorks: [string, string, string];
  soul: string;
  outfit: { head: string | null; face: string | null; neck: string | null };
  /** Connected apps it works best with (Connect chips). */
  apps: string[];
  /** Skills it leans on (display only: the document skills ship to every blob). */
  skills: string[];
  /** Suggested routines. Always stored paused. */
  routines: Array<{ title: string; cadence: string; /** What each run is asked to do (a generic line when absent). */ prompt?: string }>;
  blurb: string;
  exampleAsks: [string, string, string];
  /** Human sentence for the gallery ("works best with Gmail"). */
  wants: string[];
}
