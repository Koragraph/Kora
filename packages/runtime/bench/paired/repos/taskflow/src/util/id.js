let counter = 0;

export function nextId(prefix = 'job') {
  counter += 1;
  return `${prefix}_${counter.toString(36).padStart(5, '0')}`;
}
