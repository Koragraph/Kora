import { createContext, use } from "react";
import type { ChatPromptHandle } from "./components/thread/ChatPrompt";

export type PromptHandleRef = React.RefObject<ChatPromptHandle | null>;

export const PromptHandleContext = createContext<PromptHandleRef | null>(null);

export function usePromptHandleContext(): PromptHandleRef | null {
  return use(PromptHandleContext);
}
