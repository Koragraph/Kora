const DISCONNECTED_PROMPT_PLACEHOLDER = "Let's build something";

// assistant lane (General + chat projects) placeholder: no code-flavoured "build" language.
// New thread (hero, no messages yet) vs a follow-up in an existing thread.
const ASSISTANT_NEW_THREAD_PLACEHOLDER = "Ask anything, or give Kora a goal…";
const ASSISTANT_FOLLOW_UP_PLACEHOLDER = "Reply…";

/** A blob's composer: "Message Popo…", and Kora (the Chief) is asked to plan, not messaged. */
export function blobPromptPlaceholder(
  blob: { name: string; chief: boolean },
  newThread: boolean,
): string {
  if (blob.chief) return newThread ? "Ask Kora to plan something…" : "Message Kora…";
  return `Message ${blob.name}…`;
}

/** A Code thread that already has messages: the "build something" greeting is for a new thread only. */
const CODE_FOLLOW_UP_PLACEHOLDER = "Ask a follow-up, or say what to change…";
