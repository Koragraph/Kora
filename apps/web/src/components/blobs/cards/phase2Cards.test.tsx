import type { BlobProfile } from "@kora/contracts";
import { act, create, type ReactTestInstance } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/button", () => ({
  Button: ({ children, ...rest }: { children?: React.ReactNode; [key: string]: unknown }) => (
    <button {...rest}>{children}</button>
  ),
}));
vi.mock("~/components/ui/spinner", () => ({ Spinner: () => null }));
// the proposal's app chips are real Connect chips now: they need a router, the blobs roster and an apps API (none connected here)
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../shell/blobsApi", () => ({
  useBlobsApi: () => ({ update: vi.fn() }),
  useBlobsState: () => ({ hostId: null, snapshot: { blobs: [] }, error: null }),
}));
vi.mock("../../ui/dialog", () => {
  const P = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Dialog: () => null,
    DialogPopup: P,
    DialogHeader: P,
    DialogTitle: P,
    DialogDescription: P,
    DialogPanel: P,
    DialogFooter: P,
  };
});
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render?: React.ReactElement<{ children?: React.ReactNode }>;
    children?: React.ReactNode;
  }) => (render ? { ...render, props: { ...render.props, children } } : <span>{children}</span>),
  TooltipPopup: ({ children }: { children?: React.ReactNode }) => <i>{children}</i>,
}));

import type { BlobCardRef } from "../../../thread/timeline";
import { JobCard } from "./JobCard";
import {
  COMBINING_WINDOW_MS,
  compactSummary,
  isCombining,
  jobWord,
  latestJob,
  parseJob,
  stages,
  waitsOn,
} from "./jobModel";
import { ProposalCard } from "./ProposalCard";
import { latestVersion, lookDeck, parseProposal, stepLook } from "./proposalModel";
import type { JobActions, ProposalActions } from "./teamCardActions";

const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("");
const byAttr = (root: ReactTestInstance, attr: string, value?: string) =>
  root.findAll(
    (n) =>
      typeof n.type === "string" &&
      (value === undefined ? attr in n.props : n.props[attr] === value),
  );

// ── proposal ───────────────────────────────────────────────────────────────────────────────────────────────

const draft = (over: Record<string, unknown> = {}) => ({
  name: "Zibbo",
  title: "Refund watcher",
  job: "Watches your Shopify orders and pings you about refunds.",
  howItWorks: ["Checks new orders hourly", "Flags refunds over $50", "Drafts a reply, never sends"],
  soul: "…",
  engine: null,
  permission: "ask",
  outfit: { head: "cap", face: null, neck: null },
  apps: ["Shopify"],
  skills: ["refund-triage"],
  routines: [{ title: "Daily refund digest", cadence: "every weekday 8am" }],
  templateId: null,
  ...over,
});
const proposal = (
  version: number,
  over: Record<string, unknown> = {},
  state = "open",
): BlobCardRef => ({
  cardId: "prop_1",
  version,
  payload: {
    cardKind: "proposal",
    cardId: "prop_1",
    version,
    draft: draft(over),
    state,
    hiredBlobId: null,
  },
});

const profile = (name: string): BlobProfile => ({
  id: "blob_zibbo",
  version: 1,
  name,
  title: "Refund watcher",
  role: "member",
  teamId: "t",
  engine: { instanceId: "claude", model: "sonnet", effort: null },
  permission: "ask",
  outfit: null,
  toolGrants: {
    apps: { mode: "none", allow: [] },
    mcp: [],
    computer: { browser: false, vm: false },
  },
  slug: "zibbo",
  workspace: "/tmp/zibbo",
  templateId: null,
  pinned: false,
  hidden: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
});

function proposalActions(over: Partial<ProposalActions> = {}): ProposalActions {
  return {
    hire: vi.fn(async (d) => ({ ok: true as const, value: profile(d.name) })),
    dismiss: vi.fn(async () => ({ ok: true as const, value: {} })),
    ...over,
  };
}

describe("proposal model", () => {
  it("reads defensively and the highest version wins", () => {
    const v = parseProposal(proposal(2))!;
    expect(v).toMatchObject({ cardId: "prop_1", version: 2, state: "open" });
    expect(v.draft.howItWorks).toHaveLength(3);
    expect(parseProposal({ cardId: "x", version: 1, payload: { cardKind: "job" } })).toBeNull();
    const old = parseProposal(proposal(1))!;
    expect(latestVersion(v, old)).toBe(v);
    expect(latestVersion(old, v)).toBe(v);
  });

  it("the look deck starts with the suggestion and wraps", () => {
    const deck = lookDeck({ head: "cap" });
    expect(deck[0]).toEqual({ head: "cap" });
    expect(new Set(deck.map((o) => JSON.stringify(o))).size).toBe(deck.length);
    expect(deck.some((o) => o.head === "crown")).toBe(false);
    expect(stepLook(0, deck.length, -1)).toBe(deck.length - 1);
    expect(stepLook(deck.length - 1, deck.length, 1)).toBe(0);
  });
});

describe("ProposalCard", () => {
  it("shows the preview, job, how it works, model, permission, apps as Connect chips, skills and paused routines", async () => {
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<ProposalCard card={proposal(1)} actions={proposalActions()} flyIn={false} />);
    });
    const t = text(r.root);
    expect(t).toContain("Zibbo");
    expect(t).toContain("Watches your Shopify orders");
    expect(t).toContain("How it works");
    expect(t).toContain("Flags refunds over $50");
    expect(t).toContain("Best available model");
    expect(t).toContain("Ask");
    expect(t).toContain("Connect Shopify");
    const chip = byAttr(r.root, "data-connect-chip", "shopify");
    expect(chip).toHaveLength(1); // a real chip now, not a disabled placeholder
    expect(chip[0]!.props["aria-disabled"]).toBeUndefined();
    expect(t).toContain("refund-triage");
    expect(t).toContain("Paused");
    expect(byAttr(r.root, "data-proposal-version-label")).toHaveLength(0);
    // Tweak only exists when the host can open the editor.
    expect(byAttr(r.root, "data-proposal-tweak")).toHaveLength(0);
  });

  it("is versioned in place: v2 shows a label and Kora's new draft; a stale v1 frame never rolls it back", async () => {
    const a = proposalActions();
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<ProposalCard card={proposal(1)} actions={a} flyIn={false} />);
    });
    await act(async () => {
      r.update(
        <ProposalCard
          card={proposal(2, { name: "Wumpy", job: "Watches refunds." })}
          actions={a}
          flyIn={false}
        />,
      );
    });
    expect(text(byAttr(r.root, "data-proposal-version-label")[0]!)).toBe("v2");
    expect(text(r.root)).toContain("Wumpy");
    await act(async () => {
      r.update(<ProposalCard card={proposal(1)} actions={a} flyIn={false} />);
    });
    expect(text(r.root)).toContain("Wumpy");
    expect(byAttr(r.root, "data-proposal-version")[0]!.props["data-proposal-version"]).toBe(2);
  });

  it("Hire sends the edited name and the chosen look with the proposal id, then collapses to a receipt", async () => {
    const a = proposalActions();
    const onHired = vi.fn();
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<ProposalCard card={proposal(1)} actions={a} onHired={onHired} flyIn={false} />);
    });
    // Rename inline.
    await act(async () => byAttr(r.root, "data-proposal-name")[0]!.props.onClick());
    const input = byAttr(r.root, "data-proposal-name-input")[0]!;
    await act(async () => input.props.onChange({ target: { value: "Wumpy" } }));
    await act(async () => input.props.onBlur());
    expect(text(r.root)).toContain("Wumpy");
    // Try the next look.
    const next = r.root.findAll(
      (n) => n.type === "button" && n.props["aria-label"] === "Next look",
    )[0]!;
    await act(async () => next.props.onClick());
    await act(async () => {
      await byAttr(r.root, "data-proposal-hire")[0]!.props.onClick();
    });
    expect(a.hire).toHaveBeenCalledTimes(1);
    const [sent, proposalId] = (a.hire as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(proposalId).toBe("prop_1");
    expect(sent.name).toBe("Wumpy");
    expect(sent.outfit).not.toEqual({ head: "cap", face: null, neck: null });
    expect(onHired).toHaveBeenCalled();
    // One-line receipt; the card body is gone.
    expect(text(r.root)).toContain("Wumpy joined the team");
    expect(byAttr(r.root, "data-proposal-hire")).toHaveLength(0);
    expect(byAttr(r.root, "data-proposal-state")[0]!.props["data-proposal-state"]).toBe("hired");
  });

  it("an already-hired card renders only the receipt", async () => {
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(
        <ProposalCard card={proposal(3, {}, "hired")} actions={proposalActions()} flyIn={false} />,
      );
    });
    expect(text(r.root)).toContain("Zibbo joined the team");
    expect(byAttr(r.root, "data-proposal-hire")).toHaveLength(0);
  });

  it("Not this dismisses the proposal and leaves a quiet line", async () => {
    const a = proposalActions();
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<ProposalCard card={proposal(1)} actions={a} flyIn={false} />);
    });
    await act(async () => {
      await byAttr(r.root, "data-proposal-dismiss")[0]!.props.onClick();
    });
    expect(a.dismiss).toHaveBeenCalledWith("prop_1");
    expect(text(r.root)).toContain("Skipped the Zibbo idea");
  });

  it("a failed hire keeps the card open and shows why; Tweak hands the edited draft to the editor", async () => {
    const a = proposalActions({
      hire: vi.fn(async () => ({ ok: false as const, message: "No room on the team." })),
    });
    const onTweak = vi.fn();
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<ProposalCard card={proposal(1)} actions={a} onTweak={onTweak} flyIn={false} />);
    });
    await act(async () => {
      await byAttr(r.root, "data-proposal-hire")[0]!.props.onClick();
    });
    expect(text(byAttr(r.root, "data-proposal-error")[0]!)).toBe("No room on the team.");
    expect(byAttr(r.root, "data-proposal-hire")).toHaveLength(1);
    await act(async () => byAttr(r.root, "data-proposal-tweak")[0]!.props.onClick());
    expect(onTweak).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Zibbo", apps: ["Shopify"] }),
      "prop_1",
    );
  });
});

// ── job ────────────────────────────────────────────────────────────────────────────────────────────────────

const step = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  blobId: `blob_${id}`,
  blobName: "Popo",
  title: `Step ${id}`,
  task: "do it",
  kind: "research",
  dependsOn: [],
  status: "queued",
  threadId: null,
  resultGist: null,
  outputs: [],
  startedAt: null,
  finishedAt: null,
  ...over,
});
const job = (
  version: number,
  steps: unknown[],
  status = "running",
  title = "Lisbon trip",
): BlobCardRef => ({
  cardId: "job_1",
  version,
  payload: { cardKind: "job", cardId: "job_1", version, title, status, steps, createdAt: 1 },
});

function jobActions(over: Partial<JobActions> = {}): JobActions {
  return {
    cancelJob: vi.fn(async () => ({
      ok: true as const,
      value: job(9, [step("a", { status: "cancelled" })], "cancelled").payload,
    })),
    cancelStep: vi.fn(async () => ({
      ok: true as const,
      value: job(9, [step("a", { status: "cancelled" })], "running").payload,
    })),
    feedback: vi.fn(async () => ({ ok: true as const, value: {} })),
    ...over,
  };
}

const PLAN = [
  step("a", {
    blobName: "Popo",
    title: "Research neighbourhoods",
    status: "running",
    threadId: "th_a",
  }),
  step("b", {
    blobName: "Junip",
    title: "Draft out-of-office",
    status: "running",
    threadId: "th_b",
  }),
  step("c", {
    blobName: "Dimp",
    title: "Build the itinerary",
    dependsOn: ["a", "b"],
    status: "queued",
  }),
];

describe("job model", () => {
  it("groups parallel steps into stages and says what waits on whom", () => {
    const view = parseJob(job(1, PLAN))!;
    expect(stages(view.steps).map((g) => g.map((s) => s.id))).toEqual([["a", "b"], ["c"]]);
    expect(waitsOn(view.steps[2]!, view.steps)).toBe("after Popo and Junip");
    const after = parseJob(
      job(2, [{ ...PLAN[0], status: "done" }, { ...PLAN[1], status: "done" }, PLAN[2]]),
    )!;
    expect(waitsOn(after.steps[2]!, after.steps)).toBeNull();
  });

  it("latest version wins", () => {
    const v3 = parseJob(job(3, PLAN))!;
    const v2 = parseJob(job(2, PLAN))!;
    expect(latestJob(v3, v2)).toBe(v3);
    expect(latestJob(v2, v3)).toBe(v3);
  });
});

describe("JobCard", () => {
  it("lists each step with its blob, one status word, parallel vs waits, and a link to the thread", async () => {
    const onOpenThread = vi.fn();
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(
        <JobCard card={job(1, PLAN)} actions={jobActions()} onOpenThread={onOpenThread} />,
      );
    });
    const t = text(r.root);
    expect(t).toContain("Lisbon trip");
    expect(t).toContain("0 of 3 done");
    expect(t).toContain("At the same time");
    expect(text(byAttr(r.root, "data-job-step", "a")[0]!)).toContain("Popo · working");
    expect(text(byAttr(r.root, "data-job-step", "c")[0]!)).toContain(
      "Dimp · waiting · after Popo and Junip",
    );
    await act(async () =>
      byAttr(byAttr(r.root, "data-job-step", "b")[0]!, "data-step-open")[0]!.props.onClick(),
    );
    expect(onOpenThread).toHaveBeenCalledWith("th_b");
  });

  it("surfaces a step's question inline with a jump link", async () => {
    const onOpenThread = vi.fn();
    const steps = [
      step("a", {
        status: "needs-you",
        threadId: "th_a",
        resultGist: "Which airport do you prefer?",
      }),
    ];
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(
        <JobCard card={job(1, steps)} actions={jobActions()} onOpenThread={onOpenThread} />,
      );
    });
    const q = byAttr(r.root, "data-step-question")[0]!;
    expect(text(q)).toContain("Which airport do you prefer?");
    await act(async () => byAttr(q, "data-step-jump")[0]!.props.onClick());
    expect(onOpenThread).toHaveBeenCalledWith("th_a");
  });

  it("only steps that have not started can be edited; queued and running steps can be cancelled", async () => {
    const a = jobActions();
    const onEditStep = vi.fn();
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<JobCard card={job(1, PLAN)} actions={a} onEditStep={onEditStep} />);
    });
    const queued = byAttr(r.root, "data-job-step", "c")[0]!;
    await act(async () => byAttr(queued, "data-step-edit")[0]!.props.onClick());
    expect(onEditStep).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: "job_1" }),
      expect.objectContaining({ id: "c" }),
    );
    await act(async () => {
      await byAttr(queued, "data-step-cancel")[0]!.props.onClick();
    });
    expect(a.cancelStep).toHaveBeenCalledWith("job_1", "c");
    // a running step has no Edit, but it can be cancelled on its own (launch QA 2026-10-10)
    const b = jobActions();
    let r2!: ReturnType<typeof create>;
    await act(async () => {
      r2 = create(<JobCard card={job(1, PLAN)} actions={b} onEditStep={onEditStep} />);
    });
    const running = byAttr(r2.root, "data-job-step", "a")[0]!;
    expect(byAttr(running, "data-step-edit")).toHaveLength(0);
    await act(async () => {
      await byAttr(running, "data-step-cancel")[0]!.props.onClick();
    });
    expect(b.cancelStep).toHaveBeenCalledWith("job_1", "a");
  });

  it("Cancel job applies the returned payload: final state, compact", async () => {
    const a = jobActions();
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<JobCard card={job(1, PLAN)} actions={a} />);
    });
    await act(async () => {
      await byAttr(r.root, "data-job-cancel")[0]!.props.onClick();
    });
    expect(a.cancelJob).toHaveBeenCalledWith("job_1");
    expect(byAttr(r.root, "data-job-status")[0]!.props["data-job-status"]).toBe("cancelled");
    expect(byAttr(r.root, "data-job-steps")).toHaveLength(0); // compact
    expect(byAttr(r.root, "data-job-cancel")).toHaveLength(0);
  });

  it("a stale running snapshot re-reads the job and drops Cancel once it has ended", async () => {
    const refresh = vi.fn(async () => ({
      ok: true as const,
      value: job(7, [step("a", { status: "done" })], "done").payload,
    }));
    const a = jobActions({ refresh });
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<JobCard card={job(1, PLAN)} actions={a} />);
    });
    expect(refresh).toHaveBeenCalledWith("job_1");
    expect(byAttr(r.root, "data-job-status")[0]!.props["data-job-status"]).toBe("done");
    expect(byAttr(r.root, "data-job-cancel")).toHaveLength(0);
    expect(byAttr(r.root, "data-step-cancel")).toHaveLength(0);
  });

  it("latest version wins: an older frame after a newer one changes nothing", async () => {
    const a = jobActions();
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(
        <JobCard
          card={job(3, [{ ...PLAN[0], status: "done" }], "running", "Lisbon trip v3")}
          actions={a}
        />,
      );
    });
    await act(async () => {
      r.update(
        <JobCard
          card={job(2, [{ ...PLAN[0], status: "queued" }], "planned", "Lisbon trip v2")}
          actions={a}
        />,
      );
    });
    expect(text(r.root)).toContain("Lisbon trip v3");
    expect(byAttr(r.root, "data-job-version")[0]!.props["data-job-version"]).toBe(3);
    await act(async () => {
      r.update(
        <JobCard
          card={job(4, [{ ...PLAN[0], status: "done" }], "done", "Lisbon trip v4")}
          actions={a}
        />,
      );
    });
    expect(text(r.root)).toContain("Lisbon trip v4");
  });

  it("a finished job is compact, shows its outputs, and expands on demand; Good records feedback", async () => {
    const a = jobActions();
    const steps = [
      step("a", {
        status: "done",
        resultGist: "Three neighbourhoods fit.",
        outputs: ["outputs/lisbon.md"],
      }),
      step("b", { blobName: "Junip", status: "done", outputs: ["outputs/out-of-office.docx"] }),
    ];
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<JobCard card={job(5, steps, "done")} actions={a} />);
    });
    expect(text(byAttr(r.root, "data-job-summary")[0]!)).toContain("Done · 2 steps done");
    expect(byAttr(r.root, "data-job-steps")).toHaveLength(0);
    const outs = text(byAttr(r.root, "data-job-outputs")[0]!);
    expect(outs).toContain("lisbon.md");
    expect(outs).toContain("out-of-office.docx");
    await act(async () => byAttr(r.root, "data-job-toggle")[0]!.props.onClick());
    expect(byAttr(r.root, "data-job-steps")).toHaveLength(1);
    await act(async () => {
      await byAttr(byAttr(r.root, "data-job-step", "a")[0]!, "data-step-good")[0]!.props.onClick();
    });
    expect(a.feedback).toHaveBeenCalledWith("job_1", "a", "good");
  });

  it("a failed job says so and keeps its steps open", async () => {
    const steps = [
      step("a", { status: "done" }),
      step("b", { status: "failed", resultGist: "The site blocked the scrape." }),
    ];
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(<JobCard card={job(4, steps, "failed")} actions={jobActions()} />);
    });
    expect(text(byAttr(r.root, "data-job-summary")[0]!)).toContain("Failed");
    expect(text(byAttr(r.root, "data-job-step", "b")[0]!)).toContain(
      "The site blocked the scrape.",
    );
  });
});

describe("job header for a step waiting on the user", () => {
  it("says 'Waiting on you' while a step needs the user, and the plain word otherwise", async () => {
    const { jobWord, needsYouCount } = await import("./jobModel");
    const base = { cardId: "j", version: 1, title: "Job", createdAt: 1 } as const;
    const step = (status: string) =>
      ({
        id: status,
        blobId: "b",
        blobName: "Junip",
        title: "t",
        task: "t",
        kind: "writing",
        dependsOn: [],
        status,
        threadId: null,
        resultGist: null,
        outputs: [],
      }) as never;
    expect(
      jobWord({ ...base, status: "running", steps: [step("running"), step("needs-you")] }),
    ).toBe("Waiting on you");
    expect(
      needsYouCount({ ...base, status: "running", steps: [step("needs-you"), step("needs-you")] }),
    ).toBe(2);
    expect(jobWord({ ...base, status: "running", steps: [step("running")] })).toBe("Running");
    expect(jobWord({ ...base, status: "done", steps: [step("done")] })).toBe("Done");
    expect(jobWord({ ...base, status: "cancelled", steps: [step("needs-you")] })).toBe("Cancelled");
  });
});

// ── a finished job is not a finished Kora (live QA #3: "Done" while Kora was still combining) ──────────────────

describe("job card while Kora is still combining the answer", () => {
  const T0 = 1_000_000;
  const DONE = [
    step("a", { status: "done", outputs: ["outputs/a.md"], finishedAt: T0 }),
    step("b", { blobName: "Junip", status: "done", finishedAt: T0 + 5_000 }),
  ];
  const doneJob = () => parseJob(job(6, DONE, "done"))!;

  it("says Combining… only while the thread's turn runs and the job just finished", () => {
    const v = doneJob();
    expect(isCombining(v, true, T0 + 60_000)).toBe(true);
    expect(isCombining(v, false, T0 + 60_000)).toBe(false);
    expect(jobWord(v, true)).toBe("Combining…");
    expect(jobWord(v, false)).toBe("Done");
    expect(compactSummary(v, true)).toContain("putting the answer together");
    expect(compactSummary(v, false)).toBe("2 steps done");
  });

  it("an old job card in a thread that is busy with something else stays Done", () => {
    expect(isCombining(doneJob(), true, T0 + 5_000 + COMBINING_WINDOW_MS + 1)).toBe(false);
  });

  it("a running, failed or cancelled job is never 'combining'", () => {
    for (const status of ["running", "failed", "cancelled"]) {
      const v = parseJob(job(2, DONE, status))!;
      expect(isCombining(v, true, T0)).toBe(false);
      expect(jobWord(v, true)).not.toBe("Combining…");
    }
  });

  it("renders Combining… on the card and flips to Done when the turn settles", async () => {
    let r!: ReturnType<typeof create>;
    await act(async () => {
      r = create(
        <JobCard
          card={job(6, DONE, "done")}
          actions={jobActions()}
          koraWorking
          now={T0 + 60_000}
        />,
      );
    });
    expect(text(byAttr(r.root, "data-job-word")[0]!)).toBe("Combining…");
    expect(byAttr(r.root, "data-blob-card", "job")[0]!.props["data-job-combining"]).toBe("true");
    expect(byAttr(r.root, "data-blob-card", "job")[0]!.props["data-job-status"]).toBe("done");
    await act(async () => {
      r.update(
        <JobCard
          card={job(6, DONE, "done")}
          actions={jobActions()}
          koraWorking={false}
          now={T0 + 61_000}
        />,
      );
    });
    expect(text(byAttr(r.root, "data-job-word")[0]!)).toBe("Done");
    expect(byAttr(r.root, "data-blob-card", "job")[0]!.props["data-job-combining"]).toBe("false");
  });
});

describe("a job that ended with a cancelled or failed step", () => {
  it("never reads plain Done", async () => {
    const { parseJobPayload } = await import("./jobModel");
    const mk = (statuses: string[]) =>
      parseJobPayload(
        job(
          2,
          statuses.map((s, i) => ({ id: `s${i}`, title: `S${i}`, status: s })),
          "done",
        ).payload,
        { cardId: "job_1", version: 2 },
      )!;
    const clean = mk(["done", "done"]);
    expect(jobWord(clean)).toBe("Done");
    expect(compactSummary(clean)).toBe("2 steps done");
    const cut = mk(["done", "done", "cancelled"]);
    expect(jobWord(cut)).toBe("Finished");
    expect(compactSummary(cut)).toBe("2 of 3 done, 1 cancelled");
  });
});
