export function readSelectedText(): string | undefined {
  const selectedText = window.getSelection()?.toString().trim();
  return selectedText ? selectedText.slice(0, 2000) : undefined;
}

