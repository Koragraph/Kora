export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function assertPositiveInteger(value, name) {
  assert(Number.isInteger(value) && value > 0, `${name} must be a positive integer, got ${value}`);
}
