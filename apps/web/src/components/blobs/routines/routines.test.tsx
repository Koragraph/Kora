// Routines UI: the cadence picker's plain-words preview, the run log's statuses, the webhook secret shown once, and
// the report card's Open run / Back to results.
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toastAdd = vi.fn();
// The real renderer needs a browser (router, window); the card's job is to hand the report to it as markdown.
vi.mock("../../ReplyMarkdown", () => ({
  default: (props: { text: string }) => <div data-md>{props.text}</div>,
}));
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: (...a: unknown[]) => toastAdd(...a), close: vi.fn() },
}));
vi.mock("../../ui/button", () => ({
  Button: ({
    children,
    variant: _v,
    size: _s,
    ...rest
  }: {
    children?: React.ReactNode;
    [k: string]: unknown;
  }) => <button {...rest}>{children}</button>,
}));
vi.mock("../../ui/input", () => ({
  Input: ({ nativeInput: _n, size: _s, ...rest }: { [k: string]: unknown }) => <input {...rest} />,
}));
vi.mock("../../ui/label", () => ({
  Label: ({ children, ...rest }: { children?: React.ReactNode; [k: string]: unknown }) => (
    <label {...rest}>{children}</label>
  ),
}));

import { CadencePicker } from "./CadencePicker";
import { RoutineRow } from "./RoutinesPanel";
import {
  RoutineReportCard,
  RoutineRunBanner,
  RoutineConfirmCard,
  foldMarkdown,
} from "./RoutineReportCard";
import { RunLog } from "./RunLog";
import { SecretReveal, WebhookTriggers } from "./WebhookTriggers";
import {
  draftFromCadence,
  type CadenceDraft,
  type RoutineWire,
  type RunWire,
  type TriggerWire,
} from "./routineModel";
import { RoutinesApiProvider, UNAVAILABLE_ROUTINES_API, type RoutinesApi } from "./routinesApi";

const NOW = Date.UTC(2026, 9, 12, 15, 0);

function text(node: ReactTestInstance | string): string {
  if (typeof node === "string") return node;
  return node.children.map((c) => text(c as ReactTestInstance | string)).join("");
}
const byData = (r: ReactTestRenderer, attr: string) =>
  r.root.findAll((n) => typeof n.type === "string" && n.props[attr] !== undefined);
const buttons = (r: ReactTestRenderer) => r.root.findAllByType("button");
const buttonByText = (r: ReactTestRenderer, re: RegExp) =>
  buttons(r).find((b) => re.test(text(b)))!;

async function render(ui: React.ReactElement): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer;
  await act(async () => {
    r = create(ui);
  });
  return r;
}

const okApi = (over: Partial<RoutinesApi> = {}): RoutinesApi => ({
  ...UNAVAILABLE_ROUTINES_API,
  preview: async () => ({
    ok: true,
    value: { words: "x", next: [NOW + 3_600_000, NOW + 90_000_000] },
  }),
  ...over,
});

describe("CadencePicker", () => {
  const draft = (over: Partial<CadenceDraft> = {}): CadenceDraft => ({
    ...draftFromCadence(null, NOW),
    tz: "America/New_York",
    ...over,
  });

  it("shows the cadence in plain words and the daemon's next times", async () => {
    vi.useFakeTimers();
    const api = okApi();
    const r = await render(
      <RoutinesApiProvider api={api}>
        <CadencePicker draft={draft()} onChange={() => {}} />
      </RoutinesApiProvider>,
    );
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    const preview = text(byData(r, "data-cadence-preview")[0]!);
    expect(preview).toContain("Weekdays at 8:00 AM (America/New_York)");
    expect(preview).toContain("Next:");
    vi.useRealTimers();
  });

  it("Mon to Fri reads as Weekdays and the lit preset says so (no stray 'Every day' label)", async () => {
    const r = await render(
      <RoutinesApiProvider api={okApi()}>
        <CadencePicker draft={draft()} onChange={() => {}} />
      </RoutinesApiProvider>,
    );
    const presets = byData(r, "data-day-presets")[0]!;
    const lit = presets
      .findAllByType("button")
      .filter((b) => b.props["aria-checked"] === true)
      .map((b) => text(b));
    expect(lit).toEqual(["Weekdays"]);
    expect(text(presets)).toContain("Weekends");
    expect(text(byData(r, "data-cadence-preview")[0]!)).toContain("Weekdays at 8:00 AM");
  });

  it("the preset buttons set the days (Every day, Weekends) and light up when they match", async () => {
    const seen: CadenceDraft[] = [];
    const r = await render(
      <RoutinesApiProvider api={okApi()}>
        <CadencePicker draft={draft({ days: [0, 6] })} onChange={(d) => seen.push(d)} />
      </RoutinesApiProvider>,
    );
    const presets = byData(r, "data-day-presets")[0]!;
    expect(
      presets
        .findAllByType("button")
        .find((b) => b.props["aria-checked"] === true && /Weekends/.test(text(b))),
    ).toBeTruthy();
    await act(async () => {
      presets
        .findAllByType("button")
        .find((b) => /Every day/.test(text(b)))!
        .props.onClick();
    });
    expect(seen.at(-1)!.days).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("next times are printed in the zone the routine runs in, and say what that is on your clock", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 9, 11, 12, 0)); // a fixed 'now' before the printed times
    // 08:00 in Calcutta on Mon 12 Oct 2026 is 02:30 UTC
    const at = Date.UTC(2026, 9, 12, 2, 30);
    const api = okApi({
      preview: async () => ({ ok: true, value: { words: "x", next: [at, at + 86_400_000] } }),
    });
    const r = await render(
      <RoutinesApiProvider api={api}>
        <CadencePicker draft={draft({ tz: "Asia/Calcutta" })} onChange={() => {}} />
      </RoutinesApiProvider>,
    );
    // async: the preview promise must settle too (the sync advance raced it on a loaded machine, 2026-10-19)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const next = text(byData(r, "data-next-times")[0]!);
    // the machine's own locale formats these ("Mon, Oct 12, 8:00 AM" in en-US, "Mon, 12 Oct, 8:00 am" in en-GB / en-IN)
    expect(next).toMatch(/Mon,? (Oct 12|12 Oct),? 8:00\s?(AM|am)/);
    expect(next).toMatch(/Tue,? (Oct 13|13 Oct),? 8:00\s?(AM|am)/);
    vi.useRealTimers();
  });

  it("the sentence follows the draft: cron calendar rule, interval, and errors", async () => {
    const sentence = async (d: CadenceDraft) => {
      const r = await render(
        <RoutinesApiProvider api={okApi()}>
          <CadencePicker draft={d} onChange={() => {}} />
        </RoutinesApiProvider>,
      );
      return text(byData(r, "data-cadence-preview")[0]!);
    };
    expect(await sentence(draft({ kind: "cron", cron: "0 9 * * 1#1" }))).toContain(
      "On the first Monday of the month at 9:00 AM (America/New_York)",
    );
    expect(await sentence(draft({ kind: "cron", cron: "0 9 L * *" }))).toContain(
      "On the last day of the month at 9:00 AM",
    );
    expect(await sentence(draft({ kind: "interval", everyMinutes: "45" }))).toContain(
      "Every 45 minutes",
    );
    expect(await sentence(draft({ kind: "interval", everyMinutes: "2" }))).toContain(
      "Choose between 5 and 1,440 minutes.",
    );
    expect(await sentence(draft({ days: [] }))).toContain("Pick at least one day.");
  });

  it("picking a day and a kind reports a new draft", async () => {
    const seen: CadenceDraft[] = [];
    const r = await render(
      <RoutinesApiProvider api={okApi()}>
        <CadencePicker draft={draft({ days: [1] })} onChange={(d) => seen.push(d)} />
      </RoutinesApiProvider>,
    );
    await act(async () => {
      r.root.findAll((n) => n.type === "button" && text(n) === "Wed")[0]!.props.onClick();
    });
    expect(seen.at(-1)!.days.sort()).toEqual([1, 3]);
    await act(async () => {
      buttonByText(r, /Custom rule/).props.onClick();
    });
    expect(seen.at(-1)!.kind).toBe("cron");
  });
});

describe("RunLog", () => {
  const run = (over: Partial<RunWire>): RunWire => ({
    id: "r",
    routineId: "rt",
    blobId: "b",
    title: "Morning brief",
    status: "completed",
    source: "schedule",
    dueAt: NOW - 3_600_000,
    startedAt: null,
    endedAt: null,
    threadId: "hid1",
    resultsThreadId: "res1",
    report: "ok",
    reason: null,
    ...over,
  });
  it("renders every status with its label, source and reason", async () => {
    const runs: RunWire[] = [
      run({ id: "1", status: "queued", threadId: null, resultsThreadId: null }),
      run({ id: "2", status: "active", resultsThreadId: null }),
      run({ id: "3", status: "waiting", resultsThreadId: null }),
      run({ id: "4", status: "completed" }),
      run({
        id: "5",
        status: "missed",
        threadId: null,
        resultsThreadId: null,
        reason: "Kora was not running at this time",
      }),
      run({
        id: "6",
        status: "failed",
        reason: "Stopped after 10 minutes (this routine's run limit)",
        source: "manual",
      }),
      run({ id: "7", status: "cancelled", source: "webhook", reason: "Stopped by you" }),
      run({ id: "8", status: "completed", source: "catch-up" }),
    ];
    const open = vi.fn();
    const r = await render(
      <RunLog
        runs={runs}
        now={NOW}
        onOpenRun={open}
        onOpenResults={() => {}}
        onCancel={() => {}}
      />,
    );
    const statuses = byData(r, "data-run-status").map((n) => n.props["data-run-status"]);
    expect(statuses).toEqual([
      "queued",
      "active",
      "waiting",
      "completed",
      "missed",
      "failed",
      "cancelled",
      "completed",
    ]);
    const all = text(r.root);
    for (const label of [
      "Queued",
      "Running",
      "Waiting for you",
      "Done",
      "Missed",
      "Failed",
      "Cancelled",
    ])
      expect(all).toContain(label);
    expect(all).toContain("Kora was not running at this time");
    expect(all).toContain("Needs your answer");
    expect(all).toContain("Catch-up");
    expect(all).toContain("Webhook");
    // Open run is offered when there is an execution thread, never for a run that never started
    const row = (id: string) => byData(r, "data-run").find((n) => n.props["data-run"] === id)!;
    expect(row("5").findAll((n) => n.type === "button")).toHaveLength(0);
    await act(async () => {
      row("4")
        .findAll((n) => n.type === "button" && /Open run/.test(text(n)))[0]!
        .props.onClick();
    });
    expect(open).toHaveBeenCalledWith("hid1");
  });
  it("is calm when empty", async () => {
    const r = await render(
      <RunLog
        runs={[]}
        now={NOW}
        onOpenRun={() => {}}
        onOpenResults={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(byData(r, "data-run-log-empty")).toHaveLength(1);
  });
});

const card0 = (): RoutineWire => ({
  id: "rt_s",
  blobId: "b",
  title: "Weekly reading check-in",
  prompt: "p",
  cadence: { kind: "weekly", days: [1], time: "08:00", tz: "UTC" },
  paused: false,
  results: { mode: "dedicated", threadId: null },
  rememberLastRun: false,
  maxRunMinutes: null,
  catchUp: "one",
  triggers: [],
  nextRunAt: null,
  live: null,
  lastRun: null,
  suggestedCadence: null,
  createdBy: "user",
  skipped: 0,
});

describe("webhook secret is shown once", () => {
  const trigger: TriggerWire = {
    id: "wh_1",
    label: "GitHub",
    url: "http://127.0.0.1:8800/hooks/wh_1",
    createdAt: NOW,
    rotatedAt: null,
    lastEventAt: null,
  };
  const routine = (triggers: TriggerWire[]): RoutineWire => ({
    id: "rt_1",
    blobId: "b",
    title: "On deploy",
    prompt: "p",
    cadence: { kind: "weekly", days: [1], time: "08:00", tz: "UTC" },
    paused: false,
    results: { mode: "dedicated", threadId: null },
    rememberLastRun: false,
    maxRunMinutes: null,
    catchUp: "one",
    triggers,
    nextRunAt: null,
    live: null,
    lastRun: null,
    suggestedCadence: null,
    createdBy: "user",
    skipped: 0,
  });
  beforeEach(() => toastAdd.mockClear());

  it("reveal shows the secret and a curl line using it", async () => {
    const r = await render(
      <SecretReveal trigger={trigger} secret="whsec_SECRET123" rotated={false} onDone={() => {}} />,
    );
    expect(text(byData(r, "data-secret-value")[0]!)).toBe("whsec_SECRET123");
    expect(text(byData(r, "data-curl")[0]!)).toContain("Authorization: Bearer whsec_SECRET123");
    expect(text(r.root)).toContain("shown once");
  });

  it("create -> secret on screen -> I saved it -> gone for good (the list never holds it)", async () => {
    let triggers: TriggerWire[] = [];
    const api = okApi({
      createTrigger: async () => {
        triggers = [trigger];
        return { ok: true, value: { trigger, secret: "whsec_ONCEONLY" } };
      },
    });
    const Wrapper = () => (
      <RoutinesApiProvider api={api}>
        <WebhookTriggers
          routine={routine(triggers)}
          webhook={{ baseUrl: "http://127.0.0.1:8800", receiverUp: true }}
          onChanged={() => {}}
          now={NOW}
        />
      </RoutinesApiProvider>
    );
    const r = await render(<Wrapper />);
    await act(async () => {
      byData(r, "data-add-webhook")[0]!.props.onClick();
    });
    await act(async () => {
      byData(r, "data-webhook-create")[0]!.props.onClick();
    });
    expect(byData(r, "data-secret-value")).toHaveLength(1);
    expect(text(r.root)).toContain("whsec_ONCEONLY");
    await act(async () => {
      byData(r, "data-secret-done")[0]!.props.onClick();
    });
    expect(byData(r, "data-secret-value")).toHaveLength(0);
    // re-render with the trigger in the list: still no secret anywhere
    await act(async () => {
      r.update(<Wrapper />);
    });
    expect(text(r.root)).not.toContain("whsec_ONCEONLY");
    expect(text(r.root)).toContain("POST http://127.0.0.1:8800/hooks/wh_1");
  });

  it("the webhook form is not a nested <form>: it sits inside the routine editor's form, and Enter must not save that one", async () => {
    const create = vi.fn(async () => ({
      ok: true as const,
      value: { trigger, secret: "whsec_X" },
    }));
    const outerSubmits = vi.fn();
    const r = await render(
      <RoutinesApiProvider api={okApi({ createTrigger: create })}>
        <form onSubmit={outerSubmits}>
          <WebhookTriggers
            routine={routine([])}
            webhook={{ baseUrl: "http://127.0.0.1:8800", receiverUp: true }}
            onChanged={() => {}}
            now={NOW}
          />
        </form>
      </RoutinesApiProvider>,
    );
    await act(async () => {
      byData(r, "data-add-webhook")[0]!.props.onClick();
    });
    expect(r.root.findAllByType("form")).toHaveLength(1); // only the outer one
    const stop = vi.fn();
    const group = r.root.findAll(
      (n) => n.props.role === "group" && n.props["aria-label"] === "New webhook",
    )[0]!;
    await act(async () => {
      group.props.onKeyDown({ key: "Enter", preventDefault() {}, stopPropagation: stop });
    });
    expect(create).toHaveBeenCalledTimes(1); // Enter creates the webhook
    expect(stop).toHaveBeenCalled(); // and stays inside it
    expect(outerSubmits).not.toHaveBeenCalled();
  });

  it("rotate asks first, then shows the new secret once", async () => {
    const rotate = vi.fn(async () => ({
      ok: true as const,
      value: { trigger: { ...trigger, rotatedAt: NOW }, secret: "whsec_NEWONE" },
    }));
    const r = await render(
      <RoutinesApiProvider api={okApi({ rotateTrigger: rotate })}>
        <WebhookTriggers
          routine={routine([trigger])}
          webhook={{ baseUrl: "http://127.0.0.1:8800", receiverUp: true }}
          onChanged={() => {}}
          now={NOW}
        />
      </RoutinesApiProvider>,
    );
    await act(async () => {
      buttonByText(r, /Rotate/).props.onClick();
    });
    expect(rotate).not.toHaveBeenCalled();
    expect(text(r.root)).toContain("Anything using the current secret will be refused");
    await act(async () => {
      buttonByText(r, /Rotate now/).props.onClick();
    });
    expect(rotate).toHaveBeenCalledWith("rt_1", "wh_1");
    expect(text(r.root)).toContain("whsec_NEWONE");
    expect(text(r.root)).toContain("The old one stopped working");
  });

  it("says plainly when the receiver is down and that only this Mac can reach it", async () => {
    const r = await render(
      <RoutinesApiProvider api={okApi()}>
        <WebhookTriggers
          routine={routine([])}
          webhook={{ baseUrl: "http://127.0.0.1:8800", receiverUp: false }}
          onChanged={() => {}}
          now={NOW}
        />
      </RoutinesApiProvider>,
    );
    expect(text(r.root)).toContain("only this Mac can reach");
    expect(text(r.root)).toContain("The receiver is not running");
  });
});

describe("report row and run banner", () => {
  const card = {
    cardKind: "routine-report" as const,
    cardId: "c",
    routineId: "rt",
    runId: "run",
    blobId: "b",
    title: "Morning brief",
    status: "completed" as const,
    ranAt: NOW,
    text: "Three emails matter.",
    outputs: ["a.md"],
    executionThreadId: "hid1",
    resultsThreadId: "res1",
  };
  it("Open run opens the hidden execution thread", async () => {
    const open = vi.fn();
    const r = await render(<RoutineReportCard card={card} onOpenRun={open} />);
    expect(text(r.root)).toContain("Three emails matter.");
    expect(text(r.root)).toContain("1 file made in this run");
    await act(async () => {
      byData(r, "data-open-run")[0]!.props.onClick();
    });
    expect(open).toHaveBeenCalledWith("hid1");
  });
  it("long reports fold", async () => {
    const r = await render(
      <RoutineReportCard card={{ ...card, text: "w ".repeat(600) }} onOpenRun={() => {}} />,
    );
    expect(text(r.root)).toContain("Show the whole report");
    expect(text(r.root).length).toBeLessThan(1000);
  });
  it("renders the report's markdown instead of showing its asterisks", async () => {
    const r = await render(
      <RoutineReportCard
        card={{ ...card, text: "**Weekly reading check-in**\n\n- one\n- two" }}
        onOpenRun={() => {}}
      />,
    );
    // the report goes through the markdown renderer, which turns **x** into bold; it is not printed as plain text
    expect(byData(r, "data-md")).toHaveLength(1);
    expect(byData(r, "data-routine-report-body")).toHaveLength(1);
  });
  it("a suggested routine offers Run now before Turn on", async () => {
    const run = vi.fn();
    const turnOn = vi.fn();
    const r = await render(
      <RoutineRow
        routine={{ ...card0(), paused: true, createdBy: "template", suggestedCadence: "Weekly" }}
        now={NOW}
        onEdit={() => {}}
        onToggle={turnOn}
        onRun={run}
        onDelete={() => {}}
        onOpenRun={() => {}}
      />,
    );
    const labels = r.root
      .findAllByType("button")
      .map((b) => text(b).trim() || String(b.props["aria-label"] ?? ""));
    expect(labels.indexOf("Run now")).toBeGreaterThan(-1);
    expect(labels.indexOf("Run now")).toBeLessThan(labels.indexOf("Turn on"));
    await act(async () => {
      r.root
        .findAllByType("button")
        .find((b) => text(b).trim() === "Run now")!
        .props.onClick();
    });
    expect(run).toHaveBeenCalled();
    expect(turnOn).not.toHaveBeenCalled();
  });
  it("a folded report never ends on a half-open marker", () => {
    const folded = foldMarkdown(
      `${"word ".repeat(100)}**bold start that runs long ${"x ".repeat(200)}**`,
      520,
    );
    expect((folded.match(/\*\*/g) ?? []).length % 2).toBe(0);
    expect(folded.endsWith("…")).toBe(true);
  });
  it("Back to results", async () => {
    const back = vi.fn();
    const r = await render(
      <RoutineRunBanner title="Morning brief" ranAt={NOW} resultsThreadId="res1" onBack={back} />,
    );
    await act(async () => {
      byData(r, "data-back-to-results")[0]!.props.onClick();
    });
    expect(back).toHaveBeenCalledWith("res1");
  });
  it("confirm card answers once through the api", async () => {
    const confirm = vi.fn(async () => ({
      ok: true as const,
      value: {
        cardKind: "routine-confirm" as const,
        cardId: "x",
        token: "t",
        blobId: "b",
        summary: "Schedule",
        details: [],
        state: "confirmed" as const,
        result: "Scheduled.",
      },
    }));
    const r = await render(
      <RoutinesApiProvider api={okApi({ confirm })}>
        <RoutineConfirmCard
          card={{
            cardKind: "routine-confirm",
            cardId: "x",
            token: "t",
            blobId: "b",
            summary: "Schedule Morning brief for Popo",
            details: ["Weekdays at 8:00 AM"],
            state: "open",
            result: null,
          }}
        />
      </RoutinesApiProvider>,
    );
    await act(async () => {
      buttonByText(r, /Approve/).props.onClick();
    });
    expect(confirm).toHaveBeenCalledWith("t", true);
    expect(text(r.root)).toContain("Scheduled.");
    expect(buttons(r)).toHaveLength(0);
  });
});

describe("Open run after retention", () => {
  it("a report whose hidden run thread was cleaned up says so instead of offering a dead link", async () => {
    const { RoutineReportCard } = await import("./RoutineReportCard");
    const card = {
      cardKind: "routine-report",
      cardId: "rr",
      version: 1,
      routineId: "rt",
      runId: "run_1",
      blobId: "b",
      title: "Morning brief",
      status: "completed",
      ranAt: 5,
      text: "Three things.",
      outputs: [],
      executionThreadId: "t9",
      resultsThreadId: "t1",
    } as never;
    let kept!: ReturnType<typeof create>;
    act(() => {
      kept = create(<RoutineReportCard card={card} onOpenRun={() => undefined} runKept />);
    });
    expect(
      kept.root.findAll(
        (n) => typeof n.type === "string" && n.props["data-open-run"] !== undefined,
      ),
    ).toHaveLength(1);
    let gone!: ReturnType<typeof create>;
    act(() => {
      gone = create(<RoutineReportCard card={card} onOpenRun={() => undefined} runKept={false} />);
    });
    expect(
      gone.root.findAll(
        (n) => typeof n.type === "string" && n.props["data-open-run"] !== undefined,
      ),
    ).toHaveLength(0);
    expect(gone.root.findAll((n) => n.props["data-run-cleaned-up"] !== undefined)).toHaveLength(1);
    let unknown!: ReturnType<typeof create>;
    act(() => {
      unknown = create(<RoutineReportCard card={card} onOpenRun={() => undefined} />);
    });
    expect(
      unknown.root.findAll(
        (n) => typeof n.type === "string" && n.props["data-open-run"] !== undefined,
      ),
    ).toHaveLength(1);
  });
});
