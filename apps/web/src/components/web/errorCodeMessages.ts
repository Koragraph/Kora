/**
 * Resolve a friendly description for a Chromium / network error. Falls back
 * to the description string passed in when it isn't in our table.
 */

import { WEB_ERROR_CODE_MESSAGES } from "./webConstants";

export function describeWebError(description: string): string {
  const friendly = WEB_ERROR_CODE_MESSAGES[description];
  if (friendly) {
    return friendly;
  }
  if (description.length > 0) {
    return description;
  }
  return "Network error";
}
