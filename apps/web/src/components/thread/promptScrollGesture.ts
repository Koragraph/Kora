export function shouldCollapsePromptForScrollKey(input: {
  isAtLogicalEnd: boolean;
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
  key: string;
}): boolean {
  const { key, scrollTop } = input;
  if (key === "PageUp" || key === "Home") {
    return scrollTop > 1;
  }
  if (key === "PageDown" || key === "End") {
    const lastScrollableTop = input.scrollHeight - input.clientHeight - 1;
    return !input.isAtLogicalEnd && scrollTop < lastScrollableTop;
  }
  return false;
}
