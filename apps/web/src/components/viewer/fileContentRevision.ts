const FNV_OFFSET_BASIS = 2_166_136_261;
const FNV_PRIME = 16_777_619;

function fileContentRevision(contents: string): string {
  let state = FNV_OFFSET_BASIS;
  let at = 0;
  while (at < contents.length) {
    state = Math.imul(state ^ contents.charCodeAt(at), FNV_PRIME);
    at += 1;
  }
  return `${contents.length}:${(state >>> 0).toString(36)}`;
}

export function projectFileCacheKey(cwd: string, relativePath: string, contents: string): string {
  return `${cwd}:${relativePath}:${fileContentRevision(contents)}`;
}

interface EditorFileIdentity {
  readonly cacheKey?: string;
  readonly contents: string;
}

export function projectFileEditorCacheKey(
  hostId: string,
  workspaceRoot: string,
  relativePath: string,
  contents: string,
  editorFile: EditorFileIdentity | undefined,
): string {
  if (editorFile?.contents === contents && editorFile.cacheKey) {
    return editorFile.cacheKey;
  }
  return `editor:${hostId}:${projectFileCacheKey(workspaceRoot, relativePath, contents)}`;
}
