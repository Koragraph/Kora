// What a blob's reader sees for a Kora-authored turn (a worker note, a job note): one calm line, never "[kora] ...",
// "Worker updates" or "Kora -> Claude". The raw text stays one click away on the row.
export function quietNoticeLabel(text: string, who: string): string {
  if (/\b(worker|swarm|helper)\b/i.test(text)) return `${who} got an update from a helper`;
  if (/\b(finished|needs the user|asked the user|failed|step)\b/i.test(text))
    return "Update on a task Kora handed out";
  return "A note from Kora";
}
