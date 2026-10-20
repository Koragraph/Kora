import type { Root, RootContent } from "mdast";
import type { Plugin, Processor } from "unified";

interface Cache {
  offset: number;
  line: number;
  /** Pristine nodes: transforms mutate what a render receives, so each render gets clones. */
  children: RootContent[];
  /** Source text up to and including the blank line that follows a closed top-level fence. */
  prefix: string;
}

type AnyNode = { type: string; children?: AnyNode[] | undefined; position?: Position | undefined };
type Point = { line: number; column: number; offset?: number | undefined };
type Position = { start: Point; end: Point };

const clone = <Item>(val: Item): Item => structuredClone(val);

function containsDefinition(graphNode: AnyNode): boolean {
  if (graphNode.type === "definition" || graphNode.type === "footnoteDefinition") return true;
  return graphNode.children?.some(containsDefinition) ?? false;
}

function shift(graphNode: AnyNode, offset: number, lineDelta: number): void {
  const place = graphNode.position;
  if (place) {
    for (const point of [place.start, place.end]) {
      point.line += lineDelta;
      if (point.offset !== undefined) point.offset += offset;
    }
  }
  graphNode.children?.forEach((kid) => shift(kid, offset, lineDelta));
}

const SEPARATOR = /^\n[ \t]*\n/;

/** A top-level fence that has its own closing line, followed by a blank line. */
function closedFenceSeparator(origin: string, graphNode: AnyNode): number | null {
  const begin = graphNode.position?.start.offset;
  const until = graphNode.position?.end.offset;
  if (graphNode.type !== "code" || begin === undefined || until === undefined) return null;
  const str = origin.slice(begin, until);
  const opening = /^ {0,3}(`{3,}|~{3,})[^\n]*\n/.exec(str);
  if (!opening) return null;
  const fence = opening[1]!;
  const lastLine = str.slice(str.lastIndexOf("\n") + 1);
  const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(lastLine);
  if (!closing || closing[1]![0] !== fence[0] || closing[1]!.length < fence.length) return null;
  if (str.length <= opening[0].length) return null;
  const separator = SEPARATOR.exec(origin.slice(until));
  return separator ? separator[0].length : null;
}

/**
 * Re-parsing a growing message from the top is wasted work once a fenced block is finished:
 * everything before it can no longer change. One instance (one cache) per streaming renderer.
 */
export function createIncrementalMarkdownPlugin(): Plugin<[], Root> {
  let cache: Cache | null = null;

  const parseDocument = (origin: string, parse: (str: string) => Root): Root => {
    if (origin.includes("\r") || origin.includes("﻿")) return parse(origin);

    let baseDir: Root;
    let cachedPrefix: Cache | null = null;
    if (cache && origin.startsWith(cache.prefix)) {
      const ending = parse(origin.slice(cache.offset));
      if (containsDefinition(ending)) {
        // Definitions are document-wide: earlier references may now resolve differently.
        return parse(origin);
      }
      shift(ending, cache.offset, cache.line - 1);
      const children = [...clone(cache.children), ...ending.children];
      baseDir = {
        ...ending,
        children,
        position: {
          start: { line: 1, column: 1, offset: 0 },
          end: ending.position?.end ?? { line: cache.line, column: 1, offset: cache.offset },
        },
      };
      cachedPrefix = cache;
    } else {
      baseDir = parse(origin);
      if (containsDefinition(baseDir)) return baseDir;
    }

    for (let idx = baseDir.children.length - 1; idx >= 0; idx--) {
      const graphNode = baseDir.children[idx]! as AnyNode;
      const until = graphNode.position?.end;
      if (cachedPrefix && until && (until.offset ?? 0) < cachedPrefix.offset) break;
      const separatorLength = closedFenceSeparator(origin, graphNode);
      if (separatorLength === null || !until || until.offset === undefined) continue;
      const offset = until.offset + separatorLength;
      cache = {
        prefix: origin.slice(0, offset),
        offset,
        line: until.line + 2,
        children: clone(baseDir.children.slice(0, idx + 1)),
      };
      break;
    }
    return baseDir;
  };

  return function (this: Processor) {
    const original = this.parser as ((str: string, fileRef: unknown) => Root) | undefined;
    if (!original) return;
    // Only the first parse of a processor is the document; later ones are recovery parses.
    let documentParsed = false;
    this.parser = ((str: string, fileRef: unknown) => {
      if (documentParsed) return original(str, fileRef);
      documentParsed = true;
      return parseDocument(String(str), (piece) => original(piece, fileRef));
    }) as never;
  };
}
