import { act, create } from "react-test-renderer";
import { afterEach, beforeAll, describe, expect, it, vi } from "vite-plus/test";

const fakeWindow: { shellBridge?: unknown; prompt?: (message: string) => string | null } = {};
vi.stubGlobal("window", fakeWindow);

const pickFolder = vi.fn(async (): Promise<string | null> => "/Users/me/repo");
const createProject = vi.fn(async (_input: unknown) => ({ _tag: "Success" as const }));
const openNewThread = vi.fn(async (_ref: unknown) => {});
const addToast = vi.fn();
const fetchGraphStatus = vi.fn(async (_base: string, _cwd: string): Promise<unknown> => null);
const startIndex = vi.fn(async (_base: string, _cwd: string) => true);

vi.mock("../localApi", () => ({ readLocalApi: () => ({ dialogs: { pickFolder } }) }));
vi.mock("../atoms/projects", () => ({ projectHost: { create: {} } }));
vi.mock("../atoms/use-atom-command", () => ({ useAtomAction: () => createProject }));
vi.mock("../atoms/hosts", () => ({
  usePrimaryHostId: () => "local",
  useHostHttpBaseUrl: () => "http://127.0.0.1:8810",
}));
vi.mock("../components/onboarding/projectSetup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/onboarding/projectSetup")>()),
  fetchGraphStatus,
  startIndex,
}));
vi.mock("./useStartThread", () => ({ useStartThread: () => ({ openNewThread }) }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: addToast } }));

let useAddLocalFolderProject: typeof import("./useAddLocalFolderProject").useAddLocalFolderProject;
let ADD_FOLDER_NEEDS_SHELL_TOAST: typeof import("./useAddLocalFolderProject").ADD_FOLDER_NEEDS_SHELL_TOAST;
beforeAll(async () => {
  ({ useAddLocalFolderProject, ADD_FOLDER_NEEDS_SHELL_TOAST } =
    await import("./useAddLocalFolderProject"));
}, 30_000);

afterEach(() => {
  delete fakeWindow.shellBridge;
  delete fakeWindow.prompt;
  vi.clearAllMocks();
});

type AddFolder = ReturnType<typeof useAddLocalFolderProject>;
function renderHook(): AddFolder {
  let run: AddFolder | null = null;
  function Probe() {
    run = useAddLocalFolderProject();
    return null;
  }
  act(() => {
    create(<Probe />);
  });
  return run!;
}

describe("useAddLocalFolderProject", () => {
  it("tells a browser user to use the desktop app instead of silently doing nothing", async () => {
    const addFolder = renderHook();
    await act(async () => void (await addFolder()));
    expect(addToast).toHaveBeenCalledWith(ADD_FOLDER_NEEDS_SHELL_TOAST);
    expect(pickFolder).not.toHaveBeenCalled();
    expect(createProject).not.toHaveBeenCalled();
  });

  it("asks a browser user for the folder path and adds it", async () => {
    fakeWindow.prompt = () => "  /Users/me/web-repo/ ";
    const addFolder = renderHook();
    await act(async () => void (await addFolder()));
    expect(addToast).not.toHaveBeenCalled();
    expect(pickFolder).not.toHaveBeenCalled();
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ workspaceRoot: "/Users/me/web-repo" }),
      }),
    );
  });

  it("a cancelled browser prompt adds nothing; a relative path explains the desktop app", async () => {
    fakeWindow.prompt = () => null;
    const addFolder = renderHook();
    await act(async () => void (await addFolder()));
    expect(createProject).not.toHaveBeenCalled();
    expect(addToast).not.toHaveBeenCalled();
    fakeWindow.prompt = () => "repo";
    await act(async () => void (await addFolder()));
    expect(createProject).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(ADD_FOLDER_NEEDS_SHELL_TOAST);
  });

  it("opens the native picker and adds the folder on the desktop", async () => {
    fakeWindow.shellBridge = {};
    const addFolder = renderHook();
    await act(async () => void (await addFolder()));
    expect(addToast).not.toHaveBeenCalled();
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        hostId: "local",
        input: expect.objectContaining({ workspaceRoot: "/Users/me/repo" }),
      }),
    );
    expect(openNewThread).toHaveBeenCalledTimes(1);
  });

  it("adds a folder handed in (a recent Claude Code folder) without asking, and never starts an index", async () => {
    fetchGraphStatus.mockResolvedValueOnce({
      indexed: false,
      indexing: null,
      safeToIndex: true,
      isGitRepo: true,
    });
    const addFolder = renderHook();
    let result: Awaited<ReturnType<AddFolder>> | null = null;
    await act(async () => {
      result = await addFolder("/Users/me/app");
    });
    expect(result).toEqual({ kind: "added" });
    expect(pickFolder).not.toHaveBeenCalled();
    expect(createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ workspaceRoot: "/Users/me/app" }),
      }),
    );
    // User rule: opening a project never indexes it, even a fresh git repo; only an explicit click does.
    expect(startIndex).not.toHaveBeenCalled();
  });

  it("never indexes a plain folder or an already indexed repo on its own", async () => {
    const addFolder = renderHook();
    fetchGraphStatus.mockResolvedValueOnce({
      indexed: false,
      safeToIndex: false,
      isGitRepo: false,
    });
    await act(async () => void (await addFolder("/Users/me/notes")));
    fetchGraphStatus.mockResolvedValueOnce({ indexed: true, safeToIndex: true, isGitRepo: true });
    await act(async () => void (await addFolder("/Users/me/app")));
    expect(createProject).toHaveBeenCalledTimes(2);
    expect(startIndex).not.toHaveBeenCalled();
  });

  it("refuses a folder that does not exist with a plain message instead of adding it", async () => {
    fetchGraphStatus.mockResolvedValueOnce({ indexed: false, folderMissing: true });
    const addFolder = renderHook();
    let result: Awaited<ReturnType<AddFolder>> | null = null;
    await act(async () => {
      result = await addFolder("/Users/me/typo");
    });
    expect(result).toEqual({
      kind: "failed",
      message: "There is no folder at /Users/me/typo. Check the path and try again.",
    });
    expect(createProject).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Couldn't open that folder" }),
    );
  });
});
