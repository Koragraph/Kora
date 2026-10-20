import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import type { BrowserWindow } from "electron";
import { beforeEach, vi } from "vite-plus/test";

import * as NativeDialog from "./NativeDialog.ts";

const dialog = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  showErrorBox: vi.fn(),
}));
vi.mock("electron", () => ({ dialog }));

const withDialogs = <A, E>(
  body: (d: NativeDialog.NativeDialog["Service"]) => Effect.Effect<A, E>,
) => Effect.flatMap(NativeDialog.NativeDialog, body).pipe(Effect.provide(NativeDialog.layer));

/** Dialog text can hold paths or the user's words: an error message may describe sizes, never the text itself. */
const assertLeaksNone = (message: string, ...texts: string[]) => {
  for (const t of texts) assert.notInclude(message, t, `the message repeats "${t}"`);
};

beforeEach(() => {
  for (const spy of Object.values(dialog)) spy.mockReset();
});

describe("folder picker", () => {
  it.effect("returns the chosen folder, or none when cancelled", () =>
    withDialogs((d) =>
      Effect.gen(function* () {
        dialog.showOpenDialog.mockResolvedValueOnce({
          canceled: false,
          filePaths: ["/Users/sam/code"],
        });
        const picked = yield* d.pickFolder({ owner: Option.none(), defaultPath: Option.none() });
        assert.isTrue(Option.contains(picked, "/Users/sam/code"));
        assert.deepEqual(dialog.showOpenDialog.mock.calls[0], [
          { properties: ["openDirectory", "createDirectory"] },
        ]);

        dialog.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
        assert.isTrue(
          Option.isNone(yield* d.pickFolder({ owner: Option.none(), defaultPath: Option.none() })),
        );
      }),
    ),
  );

  it.effect("a failure names the owner window and the starting folder", () =>
    withDialogs((d) =>
      Effect.gen(function* () {
        const boom = new Error("picker broke");
        dialog.showOpenDialog.mockRejectedValue(boom);
        const failure = yield* Effect.flip(
          d.pickFolder({
            owner: Option.some({ id: 12 } as BrowserWindow),
            defaultPath: Option.some("/srv/repos"),
          }),
        );
        assert.instanceOf(failure, NativeDialog.NativeDialogPickFolderError);
        assert.deepInclude(failure, { ownerWindowId: 12, defaultPath: "/srv/repos", cause: boom });
        assert.include(failure.message, "window 12");
        assert.include(failure.message, "/srv/repos");
        assert.notInclude(failure.message, boom.message);
      }),
    ),
  );
});

describe("message box", () => {
  it.effect("a failure keeps only the kind, the lengths and the button count", () =>
    withDialogs((d) =>
      Effect.gen(function* () {
        const boom = new Error("message box broke");
        dialog.showMessageBox.mockRejectedValue(boom);
        const request = {
          type: "question" as const,
          title: "Quit Kora?",
          message: "Workers are still running.",
          detail: "They stop when Kora quits.",
          buttons: ["Keep running", "Quit", "Cancel"],
        };
        const failure = yield* Effect.flip(d.showMessageBox(request));
        assert.instanceOf(failure, NativeDialog.NativeDialogShowMessageBoxError);
        assert.deepInclude(failure, {
          type: "question",
          titleLength: request.title.length,
          messageLength: request.message.length,
          detailLength: request.detail.length,
          buttonCount: 3,
          cause: boom,
        });
        for (const field of ["title", "dialogMessage", "dialogDetail", "buttons"])
          assert.notProperty(failure, field);
        assert.include(failure.message, "question");
        assertLeaksNone(
          failure.message,
          request.title,
          request.message,
          request.detail,
          ...request.buttons,
          boom.message,
        );
      }),
    ),
  );
});

describe("error box", () => {
  it.effect("a failure dies with lengths only", () =>
    withDialogs((d) =>
      Effect.gen(function* () {
        const boom = new Error("error box broke");
        dialog.showErrorBox.mockImplementation(() => {
          throw boom;
        });
        const [heading, body] = ["Kora could not start", "The daemon did not answer."];
        const exit = yield* Effect.exit(d.showErrorBox(heading, body));
        if (Exit.isSuccess(exit)) throw new Error("expected a defect");
        const failure = Cause.squash(exit.cause) as NativeDialog.NativeDialogShowErrorBoxError;
        assert.instanceOf(failure, NativeDialog.NativeDialogShowErrorBoxError);
        assert.deepInclude(failure, {
          titleLength: heading.length,
          contentLength: body.length,
          cause: boom,
        });
        assert.notProperty(failure, "title");
        assert.notProperty(failure, "content");
        assertLeaksNone(failure.message, heading, body, boom.message);
      }),
    ),
  );
});
