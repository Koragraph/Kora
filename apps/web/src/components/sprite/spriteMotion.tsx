/**
 * Where a sprite may move. The owner's rule: sprites in the left nav/sidebar animate ("ambient": idle
 * hop, working walk, "?" bob); every sprite in the chat/content area is STILL - one frame that carries
 * its state (?, ^^, xx, z) - and only plays a short reaction when the user presses it. The default is
 * "still"; only the sidebar nav opts in with <SpriteMotionProvider value="ambient">. prefers-reduced-motion
 * beats both (sprite.css).
 */
import { createContext, useContext } from "react";

export type SpriteMotion = "ambient" | "still";

const SpriteMotionContext = createContext<SpriteMotion>("still");

export const SpriteMotionProvider = SpriteMotionContext.Provider;

export function useSpriteMotion(): SpriteMotion {
  return useContext(SpriteMotionContext);
}
