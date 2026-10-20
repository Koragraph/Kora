import type { PickedNodePayload, WebMarkupPayload } from "@kora/contracts";

// These messages arrive from a preload running beside an arbitrary web page, so the checks are strict: later code
// calls string methods on the fields, and a malformed value must be refused here rather than blow up in the renderer.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isString = (value: unknown): value is string => typeof value === "string";
const isStringOrNull = (value: unknown): value is string | null =>
  value === null || isString(value);
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const isFiniteOrNull = (value: unknown): value is number | null =>
  value === null || isFiniteNumber(value);

function isStackFrame(value: unknown): boolean {
  return (
    isRecord(value) &&
    isStringOrNull(value.functionName) &&
    isStringOrNull(value.fileName) &&
    isFiniteOrNull(value.lineNumber) &&
    isFiniteOrNull(value.columnNumber)
  );
}

function isRect(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.x) &&
    isFiniteNumber(value.y) &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height)
  );
}

const isPoint = (value: unknown): boolean =>
  isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);

const everyItem = (value: unknown, check: (item: unknown) => boolean): value is unknown[] =>
  Array.isArray(value) && value.every(check);

export function isPickedNodePayload(value: unknown): value is PickedNodePayload {
  return (
    isRecord(value) &&
    isString(value.pageUrl) &&
    isString(value.tagName) &&
    isString(value.htmlPreview) &&
    isString(value.styles) &&
    isString(value.pickedAt) &&
    isStringOrNull(value.pageTitle) &&
    isStringOrNull(value.selector) &&
    isStringOrNull(value.componentName) &&
    (value.source === null || isStackFrame(value.source)) &&
    everyItem(value.stack, isStackFrame)
  );
}

export function isWebMarkupPayload(value: unknown): value is WebMarkupPayload {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.pageUrl) &&
    isString(value.comment) &&
    isString(value.createdAt) &&
    isStringOrNull(value.pageTitle) &&
    // The page never supplies the screenshot; the main process attaches it afterwards.
    value.screenshot === null &&
    everyItem(
      value.elements,
      (item) =>
        isRecord(item) &&
        isString(item.id) &&
        isPickedNodePayload(item.element) &&
        isRect(item.rect),
    ) &&
    everyItem(value.regions, (item) => isRecord(item) && isString(item.id) && isRect(item.rect)) &&
    everyItem(
      value.strokes,
      (item) =>
        isRecord(item) &&
        isString(item.id) &&
        isString(item.color) &&
        isFiniteNumber(item.width) &&
        everyItem(item.points, isPoint) &&
        isRect(item.bounds),
    ) &&
    everyItem(
      value.styleChanges,
      (item) =>
        isRecord(item) &&
        isString(item.targetId) &&
        isStringOrNull(item.selector) &&
        isString(item.property) &&
        isString(item.previousValue) &&
        isString(item.value),
    )
  );
}
