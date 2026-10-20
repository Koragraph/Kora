let counter = 0;

export function nextId(prefix = 'id') {
  counter += 1;
  return `${prefix}-${counter.toString(36).padStart(4, '0')}`;
}

export function resetIds() {
  counter = 0;
}
