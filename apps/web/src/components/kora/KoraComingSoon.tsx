// The Kora tab while the Kora surface is coming soon (branding.ts KORA_SURFACE, koraSurface.ts): what Kora will do, in the
// Pitch palette (true black, lifted cards, no hue), with the pixel team idling above the headline. No signup, no email,
// no network: one button back to Code. Every /blobs, /apps, blob-thread and blob-settings address lands here.
import {
  BrainIcon,
  CrownIcon,
  FileTextIcon,
  GlobeIcon,
  HandIcon,
  LaptopIcon,
  MessagesSquareIcon,
  RepeatIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

import { useEffect, useRef } from "react";

import { useAppSurfaceStore } from "../assistant/surfaceStore";
import { useSurfaceSwitch } from "../assistant/useSurfaceSwitch";
import { PixelSprite, SpriteMotionProvider, type SpriteAccessory } from "../sprite";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { thisComputer, yourComputer } from "../../util/utils";

export const KORA_COMING_SOON_HEADLINE = "Kora is coming soon";
const KORA_COMING_SOON_TAGLINE = `A team of AI assistants that live on ${yourComputer()} — each with its own memory, routines and browser.`;

interface Feature {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly body: string;
}

/** One sentence each, from docs/bots/SPEC.md. */
export const KORA_FEATURES: readonly Feature[] = [
  {
    icon: UsersIcon,
    title: "A team you hire",
    body: "Hire assistants from a gallery or describe your own, each with its own folder and personality.",
  },
  {
    icon: BrainIcon,
    title: "Memory that knows you",
    body: "They remember what matters about you and your work, and forget anything the moment you ask.",
  },
  {
    icon: RepeatIcon,
    title: "Routines on a schedule",
    body: "Recurring tasks like a morning brief or a weekly report run on their own, right on time.",
  },
  {
    icon: GlobeIcon,
    title: "A browser of its own",
    body: "You sign in once, it stays signed in, and it never sees or types your password.",
  },
  {
    icon: HandIcon,
    title: "Asks before it acts",
    body: "Bookings, forms, sends and payments stop and wait for your approval.",
  },
  {
    icon: CrownIcon,
    title: "Kora, the Chief",
    body: "Hand Kora a big job and it splits the work across the team, then brings it back together.",
  },
  {
    icon: MessagesSquareIcon,
    title: "Group chats",
    body: "Talk to several assistants at once, and the best fit for each message answers.",
  },
  {
    icon: FileTextIcon,
    title: "Real files, not just chat",
    body: "Reports, docs and spreadsheets land as files in the assistant's folder, ready to open.",
  },
  {
    icon: LaptopIcon,
    title: `Private, on ${yourComputer()}`,
    body: `Folders, memory and browser sign-ins stay on ${thisComputer()}, with no Kora account and no cloud copy.`,
  },
];

/** The team above the headline: the Chief (crown) in the middle, four teammates in outfits around it. */
const TEAM: ReadonlyArray<{ accessory: SpriteAccessory | null; chief?: boolean; phase: number }> = [
  { accessory: "phones", phase: 0.15 },
  { accessory: "beret", phase: 0.55 },
  { accessory: null, chief: true, phase: 0 },
  { accessory: "shades", phase: 0.35 },
  { accessory: "flower", phase: 0.8 },
];

function TeamRow() {
  return (
    // "ambient": the idle hop + blink; prefers-reduced-motion stops every frame (sprite.css).
    <SpriteMotionProvider value="ambient">
      <div aria-hidden className="flex items-end justify-center gap-3 sm:gap-5">
        {TEAM.map((m) => (
          <PixelSprite
            key={m.accessory ?? "chief"}
            accessory={m.accessory}
            chief={m.chief ?? false}
            size={m.chief ? 72 : 48}
            phase={m.phase}
            className={m.chief ? undefined : "opacity-80"}
          />
        ))}
      </div>
    </SpriteMotionProvider>
  );
}

function FeatureCard({ feature }: { readonly feature: Feature }) {
  const Icon = feature.icon;
  return (
    <li className="flex gap-3 rounded-2xl bg-card p-4 sm:p-5" data-kora-feature={feature.title}>
      <span
        aria-hidden
        className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full lift-inset text-foreground"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-medium text-foreground">{feature.title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{feature.body}</p>
      </div>
    </li>
  );
}

export function KoraComingSoonContent(props: { readonly onOpenCode: () => void }) {
  return (
    <div
      data-testid="kora-coming-soon"
      className="mx-auto flex w-full max-w-5xl flex-col items-center px-4 pt-14 pb-16 sm:px-8 sm:pt-20"
    >
      <TeamRow />
      <p className="mt-8 rounded-full lift-inset px-3 py-1 text-xs font-medium text-muted-foreground">
        Coming soon
      </p>
      <h1 className="mt-4 text-center text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
        {KORA_COMING_SOON_HEADLINE}
      </h1>
      <p className="mt-3 max-w-xl text-center text-base leading-relaxed text-muted-foreground">
        {KORA_COMING_SOON_TAGLINE}
      </p>

      <section aria-labelledby="kora-coming-soon-features" className="mt-12 w-full">
        <h2
          id="kora-coming-soon-features"
          className="mb-4 text-center text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground"
        >
          What Kora will do
        </h2>
        <ul className="grid w-full grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {KORA_FEATURES.map((f) => (
            <FeatureCard key={f.title} feature={f} />
          ))}
        </ul>
      </section>

      <div className="mt-12 flex flex-col items-center gap-3">
        <Button size="lg" onClick={props.onOpenCode} data-testid="kora-coming-soon-open-code">
          Meanwhile, Kora Code is ready
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          Kora arrives as an update to this app. There is nothing to sign up for.
        </p>
      </div>
    </div>
  );
}

/** The page: a full main pane that scrolls on its own. */
export function KoraComingSoon() {
  const [surface, switchSurface] = useSurfaceSwitch();
  const [, setStoredSurface] = useAppSurfaceStore();
  // A deep link (/blobs, /apps, a blob thread) shows the Kora tab as the selected one.
  // Once per mount: the "back to Code" click must not be flipped straight back.
  const synced = useRef(false);
  useEffect(() => {
    if (synced.current) return;
    synced.current = true;
    if (surface !== "blobs") setStoredSurface("blobs");
  }, [surface, setStoredSurface]);
  return (
    <SidebarInset className="h-svh min-h-0 overflow-y-auto overscroll-y-contain bg-background text-foreground md:h-dvh">
      <main className="w-full">
        <KoraComingSoonContent onOpenCode={() => switchSurface("code", { force: true })} />
      </main>
    </SidebarInset>
  );
}

/** One quiet line for a settings page that exists only for Kora (Settings > Kora, Connections, Outside access). */
export function KoraComingSoonSettingsNote() {
  return (
    <div data-testid="kora-coming-soon-settings" className="mx-auto w-full max-w-3xl px-6 py-8">
      <p className="text-sm text-muted-foreground">
        {KORA_COMING_SOON_HEADLINE}. These settings arrive with it.
      </p>
    </div>
  );
}
