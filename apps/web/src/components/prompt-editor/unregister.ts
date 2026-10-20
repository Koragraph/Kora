/** One cleanup for several Lexical registrations (each `register*` returns its own). */
export function unregisterAll(...cleanups: ReadonlyArray<() => void>): () => void {
  return () => {
    for (const cleanup of cleanups) cleanup();
  };
}
