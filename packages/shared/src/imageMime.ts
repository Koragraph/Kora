/** What a picker writes when it did not recognize the file; the name is better evidence. */
const UNRECOGNIZED_TYPES = [
  "application/unknown",
  "binary/octet-stream",
  "application/octet-stream",
];
export const GENERIC_MIME_TYPES = new Set(UNRECOGNIZED_TYPES);
