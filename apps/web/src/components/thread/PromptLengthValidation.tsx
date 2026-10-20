export function PromptLengthValidation({ message }: { message: string | null }) {
  if (!message) return null;

  return (
    <p
      className="px-3 pb-2 text-xs text-destructive sm:px-4"
      data-prompt-validation="prompt-length"
      role="alert"
    >
      {message}
    </p>
  );
}
