// Outbound classification (SPEC: "Send / post / delete / pay / book always ask, even on Auto").
// Fail closed: a tool is "safe" only when its slug says it only reads (or drafts). Everything else needs approval.
// Composio slugs look like GMAIL_SEND_EMAIL / SLACK_SEND_MESSAGE / GITHUB_CREATE_AN_ISSUE / GOOGLECALENDAR_EVENTS_LIST.

const READ_WORDS = new Set([
  'GET', 'LIST', 'FETCH', 'SEARCH', 'READ', 'FIND', 'QUERY', 'RETRIEVE', 'DESCRIBE', 'CHECK', 'COUNT', 'LOOKUP', 'VIEW',
  'SHOW', 'EXPORT', 'DOWNLOAD', 'PROFILE', 'INFO', 'DETAILS', 'FREEBUSY', 'WHOAMI', 'STATUS', 'HISTORY', 'SUMMARY', 'DRAFT', 'DRAFTS',
]);
/** Words that make a tool outbound even when a read word is also present ("GET_AND_DELETE", "SEND_DRAFT"). */
const WRITE_WORDS = new Set([
  'SEND', 'REPLY', 'FORWARD', 'POST', 'PUBLISH', 'TWEET', 'COMMENT', 'DELETE', 'REMOVE', 'TRASH', 'DESTROY', 'CLEAR', 'PURGE',
  'PAY', 'PAYMENT', 'CHARGE', 'REFUND', 'TRANSFER', 'BOOK', 'ORDER', 'PURCHASE', 'INVITE', 'SHARE', 'MERGE', 'APPROVE', 'REJECT',
  'CREATE', 'UPDATE', 'EDIT', 'MODIFY', 'PATCH', 'SET', 'ADD', 'UPLOAD', 'MOVE', 'ARCHIVE', 'ASSIGN', 'CLOSE', 'REOPEN', 'REVOKE',
  'CANCEL', 'SUBSCRIBE', 'UNSUBSCRIBE', 'MESSAGE', 'NOTIFY', 'DISPATCH', 'TRIGGER', 'RUN', 'EXECUTE', 'WRITE', 'APPEND', 'REPLACE',
]);

export interface Classification { outbound: boolean; reason: string }

export function classifyTool(slug: string, hints: { readOnly?: boolean | null } = {}): Classification {
  const words = slug.toUpperCase().split('_').filter(Boolean);
  const rest = words.slice(1); // first word is the toolkit
  // MESSAGE/COMMENT/ORDER/RUN are often nouns ("SEARCH_MESSAGES", "LIST_ORDERS"): they only count when no read word is present.
  const SOFT = new Set(['MESSAGE', 'COMMENT', 'ORDER', 'RUN']);
  const hasRead = rest.some((w) => READ_WORDS.has(w));
  const hit = rest.find((w) => WRITE_WORDS.has(w) && !(SOFT.has(w) && hasRead));
  // "Create a DRAFT" saves nothing outward; sending a draft (SEND) is caught above. Drafts are the one write we let through.
  const draftOnly = rest.includes('DRAFT') && !rest.some((w) => ['SEND', 'DELETE', 'REMOVE', 'POST', 'PUBLISH', 'FORWARD', 'REPLY'].includes(w));
  if (hit && !draftOnly) return { outbound: true, reason: `${hit.toLowerCase()} changes something outside Kora` };
  if (hint(hints)) return { outbound: false, reason: 'tool says it is read-only' };
  if (rest.some((w) => READ_WORDS.has(w))) return { outbound: false, reason: 'read-only' };
  return { outbound: true, reason: 'could not tell it only reads, so it asks first' };
}
const hint = (h: { readOnly?: boolean | null }) => h.readOnly === true;
