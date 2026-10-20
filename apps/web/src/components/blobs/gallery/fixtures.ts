// Sample templates in the shape of `blobs.templates.list` (SPEC "Starter roster"). Used by the previews, QA specs and
// tests; the app itself always asks the daemon.
import type { BlobDraft, BlobTemplate } from "@kora/contracts";

const draft = (
  id: string,
  name: string,
  title: string,
  job: string,
  head: string | null,
  face: string | null,
  neck: string | null = null,
  routines: BlobDraft["routines"] = [],
): BlobDraft => ({
  name,
  title,
  job,
  howItWorks: [],
  soul: "",
  engine: null,
  permission: "auto",
  outfit: { head, face, neck },
  apps: [],
  skills: [],
  routines,
  templateId: id,
});

const t = (
  id: string,
  d: BlobDraft,
  blurb: string,
  exampleAsks: string[],
  wants: string[],
): BlobTemplate => ({ id, draft: d, blurb, exampleAsks, wants });

export const SAMPLE_TEMPLATES: ReadonlyArray<BlobTemplate> = [
  t(
    "popo",
    draft(
      "popo",
      "Popo",
      "Researcher",
      "Deep web research, delivered as a sourced brief.",
      null,
      "round-glasses",
      null,
      [{ title: "Weekly watch on a topic you care about", cadence: "Mondays at 9:00" }],
    ),
    "Researches things properly.",
    [
      "Compare home EV chargers under $700",
      "What changed in EU data rules this year?",
      "Find 5 competitors and their pricing",
    ],
    [],
  ),
  t(
    "bobble",
    draft(
      "bobble",
      "Bobble",
      "Inbox",
      "Triages your email and drafts replies. Never sends without asking.",
      "headphones",
      null,
    ),
    "Keeps the inbox calm.",
    [
      "What needs a reply today?",
      "Draft a polite no to the Tuesday invite",
      "Summarise the thread with Sam",
    ],
    ["Gmail", "Outlook"],
  ),
  t(
    "dimp",
    draft("dimp", "Dimp", "Planner", "Calendar, reminders and a plan for your week.", "cap", null),
    "Plans your week.",
    [
      "Plan my week around the Friday launch",
      "Find 2 hours for deep work tomorrow",
      "Remind me to renew the passport",
    ],
    ["Google Calendar"],
  ),
  t(
    "junip",
    draft("junip", "Junip", "Writer", "Drafts, edits and rewrites in your voice.", "beret", null),
    "Writes like you.",
    [
      "Rewrite this update to sound warmer",
      "Draft a launch post from these notes",
      "Tighten this to 100 words",
    ],
    [],
  ),
  t(
    "wobbo",
    draft("wobbo", "Wobbo", "Analyst", "Spreadsheets, CSVs, charts and numbers.", null, "monocle"),
    "Makes sense of numbers.",
    [
      "Clean this CSV and chart revenue by month",
      "Which customers churned last quarter?",
      "Build a budget sheet for the trip",
    ],
    [],
  ),
  t(
    "tibbo",
    draft(
      "tibbo",
      "Tibbo",
      "Briefing",
      "A morning brief: news, calendar and inbox highlights.",
      "top-hat",
      null,
      null,
      [{ title: "Morning brief", cadence: "Weekdays at 8:00" }],
    ),
    "Starts your day informed.",
    ["Give me today's brief", "Add AI policy news to my brief", "What's on my calendar this week?"],
    ["a routine (paused)"],
  ),
  t(
    "mibble",
    draft(
      "mibble",
      "Mibble",
      "Shopper",
      "Compares products, prices and reviews. Never buys.",
      null,
      "sunglasses",
    ),
    "Finds the good deal.",
    [
      "Best 4K monitor under $400?",
      "Is this laptop price actually good?",
      "Compare two standing desks",
    ],
    [],
  ),
  t(
    "zonk",
    draft(
      "zonk",
      "Zonk",
      "Traveller",
      "Trips, itineraries and options. Never books.",
      "beanie",
      null,
    ),
    "Plans the trip.",
    [
      "Plan 4 days in Lisbon in May",
      "Cheapest way from Dallas to Austin",
      "Pack list for a week of hiking",
    ],
    [],
  ),
  t(
    "plonk",
    draft(
      "plonk",
      "Plonk",
      "Builder",
      "Small scripts, automations and fixes inside a folder.",
      null,
      "square-glasses",
    ),
    "Fixes and builds small things.",
    ["Rename these photos by date", "Write a script to merge my CSVs", "Why does this build fail?"],
    ["a folder"],
  ),
  t(
    "fizzle",
    draft(
      "fizzle",
      "Fizzle",
      "Social",
      "Posts, captions and repurposed content. Never posts without asking.",
      "flower",
      null,
    ),
    "Keeps socials going.",
    [
      "Turn this blog post into 5 posts",
      "Write a caption for the launch photo",
      "Plan a week of LinkedIn content",
    ],
    ["X", "LinkedIn"],
  ),
];
