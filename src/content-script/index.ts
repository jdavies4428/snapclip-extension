import type { PageContext } from '../shared/types/snapshot';

export function collectPageContext(): PageContext {
  const selectedText = window.getSelection()?.toString().trim().slice(0, 2000) || undefined;

  const textList = (selector: string, limit = 8): string[] =>
    Array.from(document.querySelectorAll<HTMLElement>(selector))
      .map((element) => element.innerText.trim())
      .filter(Boolean)
      .slice(0, limit);

  const fields = Array.from(
    document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'),
  )
    .map((field) => {
      const label = field.labels?.[0]?.innerText.trim();
      return (
        label ||
        field.getAttribute('aria-label') ||
        field.getAttribute('name') ||
        field.getAttribute('placeholder') ||
        field.tagName.toLowerCase()
      );
    })
    .filter((value): value is string => Boolean(value))
    .slice(0, 8);

  return {
    title: document.title || 'Untitled page',
    url: window.location.href,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    },
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown',
    domSummary: {
      headings: textList('h1, h2, h3'),
      buttons: textList('button, [role="button"]'),
      fields,
      selectedText,
    },
  };
}
