import * as Electron from "electron";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";

// Errors describe the failing call by sizes and counts only: dialog text may carry paths or user content.

export class NativeDialogPickFolderError extends Schema.TaggedError<NativeDialogPickFolderError>()(
  "NativeDialogPickFolderError",
  {
    cause: Schema.Defect(),
    defaultPath: Schema.NullOr(Schema.String),
    ownerWindowId: Schema.NullOr(Schema.Number),
  },
) {
  override get message() {
    const holder = this.ownerWindowId === null ? "the application" : `window ${this.ownerWindowId}`;
    const begin = this.defaultPath === null ? "no default path" : this.defaultPath;
    return `Failed to open the Electron folder picker for ${holder} with ${begin}.`;
  }
}

export class NativeDialogShowMessageBoxError extends Schema.TaggedError<NativeDialogShowMessageBoxError>()(
  "NativeDialogShowMessageBoxError",
  {
    cause: Schema.Defect(),
    buttonCount: Schema.Number,
    detailLength: Schema.NullOr(Schema.Number),
    messageLength: Schema.Number,
    titleLength: Schema.NullOr(Schema.Number),
    type: Schema.NullOr(Schema.Literals(["none", "info", "error", "question", "warning"])),
  },
) {
  override get message() {
    return `Failed to show the Electron ${this.type ?? "untyped"} message box with ${this.buttonCount} buttons.`;
  }
}

export class NativeDialogShowErrorBoxError extends Schema.TaggedError<NativeDialogShowErrorBoxError>()(
  "NativeDialogShowErrorBoxError",
  {
    cause: Schema.Defect(),
    contentLength: Schema.Number,
    titleLength: Schema.Number,
  },
) {
  override get message() {
    return `Failed to show the Electron error box with a ${this.titleLength}-character title and ${this.contentLength}-character content.`;
  }
}

export const NativeDialogError = Schema.Union([
  NativeDialogPickFolderError,
  NativeDialogShowMessageBoxError,
  NativeDialogShowErrorBoxError,
]);
export type NativeDialogError = typeof NativeDialogError.Type;

export interface NativeDialogPickFolderInput {
  readonly owner: Option.Option<Electron.BrowserWindow>;
  readonly defaultPath: Option.Option<string>;
}

export class NativeDialog extends Context.Service<
  NativeDialog,
  {
    readonly pickFolder: (
      request: NativeDialogPickFolderInput,
    ) => Effect.Effect<Option.Option<string>, NativeDialogPickFolderError>;
    readonly showMessageBox: (
      opts: Electron.MessageBoxOptions,
    ) => Effect.Effect<Electron.MessageBoxReturnValue, NativeDialogShowMessageBoxError>;
    readonly showErrorBox: (heading: string, contentBody: string) => Effect.Effect<void>;
  }
>()("@kora/desktop/native/NativeDialog") {}

const pickFolder: NativeDialog["Service"]["pickFolder"] = (request) =>
  Effect.tryPromise({
    try: async () => {
      const opts: Electron.OpenDialogOptions = {
        properties: ["openDirectory", "createDirectory"],
        ...Option.match(request.defaultPath, {
          onNone: () => ({}),
          onSome: (defaultPath) => ({ defaultPath }),
        }),
      };
      const result = Option.isSome(request.owner)
        ? await Electron.dialog.showOpenDialog(request.owner.value, opts)
        : await Electron.dialog.showOpenDialog(opts);
      return result.canceled ? Option.none<string>() : Option.fromNullishOr(result.filePaths[0]);
    },
    catch: (reason) =>
      new NativeDialogPickFolderError({
        ownerWindowId: Option.match(request.owner, { onNone: () => null, onSome: (w) => w.id }),
        defaultPath: Option.getOrNull(request.defaultPath),
        cause: reason,
      }),
  }).pipe(Effect.withSpan("shell.electron.dialog.pickFolder"));

const make = NativeDialog.of({
  pickFolder,
  showMessageBox: (opts) =>
    Effect.tryPromise({
      try: () => Electron.dialog.showMessageBox(opts),
      catch: (reason) =>
        new NativeDialogShowMessageBoxError({
          type: opts.type ?? null,
          titleLength: opts.title?.length ?? null,
          messageLength: opts.message.length,
          detailLength: opts.detail?.length ?? null,
          buttonCount: opts.buttons?.length ?? 0,
          cause: reason,
        }),
    }),
  showErrorBox: (heading, contentBody) =>
    Effect.try({
      try: () => Electron.dialog.showErrorBox(heading, contentBody),
      catch: (reason) =>
        new NativeDialogShowErrorBoxError({
          titleLength: heading.length,
          contentLength: contentBody.length,
          cause: reason,
        }),
    }).pipe(Effect.orDie),
});

export const layer = Layer.succeed(NativeDialog, make);
