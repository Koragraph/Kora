import type { AskQuestion } from "@kora/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildPendingQuestionAnswers as answersFor,
  countAnsweredQuestions as answeredCount,
  derivePendingQuestionProgress as progress,
  readPendingUserInputDrafts,
  resolvePendingQuestionAnswer as answerOf,
  setPendingQuestionCustomAnswer as typeAnswer,
  togglePendingQuestionOptionSelection as toggle,
  writePendingUserInputDrafts,
} from "./pendingUserInput";

/** A question the agent asked: `pick` single choice, `many` multi choice, with free text unless `fixed`. */
const ask = (
  id: string,
  options: Array<{ label: string; value?: string }>,
  shape: { many?: boolean; fixed?: boolean } = {},
): AskQuestion => ({
  id,
  header: id,
  question: `About ${id}?`,
  multiSelect: shape.many ?? false,
  options: options.map((o) => ({ ...o, description: o.label })),
  ...(shape.fixed ? { allowCustomAnswer: false } : {}),
});

const db = ask("db", [{ label: "Postgres" }, { label: "SQLite" }]);
const targets = ask("targets", [{ label: "macOS" }, { label: "Linux" }], { many: true });
/** Two options with one label, told apart by value; free text not allowed. */
const twins = ask(
  "pick",
  [
    { label: "Match", value: " first\t" },
    { label: "Match", value: "second" },
  ],
  { fixed: true },
);

describe("what counts as an answer", () => {
  it("free text beats a selected option, when free text is allowed", () => {
    expect(answerOf(db, { customAnswer: " Use DuckDB ", selectedOptionValues: ["Postgres"] })).toBe(
      "Use DuckDB",
    );
    expect(
      answerOf(twins, { customAnswer: "something else", selectedOptionValues: ["second"] }),
    ).toBe("second");
  });

  it("a single choice gives the option; a multi choice gives every selected option", () => {
    expect(answerOf(db, { selectedOptionValues: ["SQLite"] })).toBe("SQLite");
    expect(answerOf(targets, { selectedOptionValues: ["macOS", "Linux"] })).toEqual([
      "macOS",
      "Linux",
    ]);
  });

  it("only an option's value counts: never its label, never an unknown value", () => {
    expect(answerOf(twins, { selectedOptionValues: ["Match", "nope"] })).toBeNull();
  });

  it("attachments alone answer a free-text question once they have all uploaded", () => {
    const spec = ask("spec", []);
    expect(answersFor([spec], { spec: { attachmentCount: 2 } })).toEqual({ spec: "" });
    expect(
      answersFor([spec], { spec: { attachmentCount: 2, attachmentsBlocked: true } }),
    ).toBeNull();
    expect(
      answersFor([{ ...spec, allowCustomAnswer: false }], { spec: { attachmentCount: 2 } }),
    ).toBeNull();
  });
});

describe("editing the draft", () => {
  it("typing free text drops the selected options; clearing it keeps them", () => {
    expect(typeAnswer({ selectedOptionValues: ["macOS"] }, "all of them")).toEqual({
      customAnswer: "all of them",
    });
    expect(typeAnswer({ selectedOptionValues: ["macOS"] }, "  ")).toEqual({
      customAnswer: "  ",
      selectedOptionValues: ["macOS"],
    });
  });

  it("a multi choice toggles options on and off; a single choice replaces", () => {
    const one = toggle(targets, undefined, "Linux");
    expect(one).toEqual({ customAnswer: "", selectedOptionValues: ["Linux"] });
    expect(toggle(targets, { selectedOptionValues: ["Linux", "macOS"] }, "Linux")).toEqual({
      customAnswer: "",
      selectedOptionValues: ["macOS"],
    });
    expect(toggle(targets, one, "Linux")).toEqual({ customAnswer: "" });
    expect(toggle(db, { selectedOptionValues: ["Postgres"] }, "SQLite")).toEqual({
      customAnswer: "",
      selectedOptionValues: ["SQLite"],
    });
  });

  it("options that share a label are toggled separately, and answered with their exact values", () => {
    const many = { ...twins, multiSelect: true };
    const both = toggle(many, toggle(many, undefined, " first\t"), "second");
    expect(answersFor([many], { pick: both })).toEqual({ pick: [" first\t", "second"] });
    expect(answersFor([many], { pick: toggle(many, both, " first\t") })).toEqual({
      pick: ["second"],
    });
  });

  it.each([" first\t", ""])("an option value of %j is sent exactly as it is", (value) => {
    const question = { ...twins, options: [{ ...twins.options[0]!, value }, twins.options[1]!] };
    const draft = toggle(question, undefined, value);
    expect(answersFor([question], { pick: draft })).toEqual({ pick: value });
  });
});

describe("the question wizard", () => {
  it("can submit only when every question is answered", () => {
    expect(answersFor([db, targets], { db: { selectedOptionValues: ["SQLite"] } })).toBeNull();
    expect(
      answersFor([db, targets], {
        db: { customAnswer: "SQLite for now, Postgres later" },
        targets: { selectedOptionValues: ["Linux"] },
      }),
    ).toEqual({ db: "SQLite for now, Postgres later", targets: ["Linux"] });
    expect(answeredCount([db, targets], { db: { selectedOptionValues: ["SQLite"] } })).toBe(1);
  });

  it("knows the current question, whether it can move on, and how far along it is", () => {
    expect(
      progress([db, targets], { db: { selectedOptionValues: ["Postgres"] } }, 0),
    ).toMatchObject({
      questionIndex: 0,
      activeQuestion: db,
      resolvedAnswer: "Postgres",
      selectedOptionValues: ["Postgres"],
      customAnswer: "",
      usingCustomAnswer: false,
      canAdvance: true,
      isLastQuestion: false,
      isComplete: false,
      answeredQuestionCount: 1,
    });
    expect(progress([db, targets], {}, 9)).toMatchObject({
      questionIndex: 1,
      isLastQuestion: true,
      canAdvance: false,
    });
  });

  it("ignores free text on a question that does not allow it", () => {
    expect(progress([twins], { pick: { customAnswer: "mine" } }, 0)).toMatchObject({
      resolvedAnswer: null,
      customAnswer: "",
      usingCustomAnswer: false,
      canAdvance: false,
      isComplete: false,
    });
  });
});

describe("drafts kept for the tab's life", () => {
  const tabStorage = () => {
    const saved = new Map<string, string>();
    return {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
    };
  };

  it("come back per request: answers and which question was open", () => {
    const storage = tabStorage();
    const drafts = {
      answers: { req: { db: { selectedOptionValues: ["SQLite"] } } },
      indexes: { req: 1 },
    };
    writePendingUserInputDrafts(drafts, storage);
    expect(readPendingUserInputDrafts(storage)).toEqual(drafts);
  });

  it("only the newest 20 requests are kept", () => {
    const storage = tabStorage();
    const indexes = Object.fromEntries(Array.from({ length: 25 }, (_, n) => [`req${n}`, n]));
    writePendingUserInputDrafts({ answers: {}, indexes }, storage);
    const kept = Object.keys(readPendingUserInputDrafts(storage).indexes);
    expect([kept.length, kept[0], kept.at(-1)]).toEqual([20, "req5", "req24"]);
  });

  it.each([
    ["nothing saved", { getItem: () => null }],
    ["unreadable JSON", { getItem: () => "{" }],
    [
      "storage that throws (a private window)",
      {
        getItem: (): string => {
          throw new Error("denied");
        },
      },
    ],
  ])("start empty with %s", (_, storage) => {
    expect(readPendingUserInputDrafts(storage)).toEqual({ answers: {}, indexes: {} });
  });
});
