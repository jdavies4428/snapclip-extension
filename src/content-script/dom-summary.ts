function textList(selector: string, limit = 8): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>(selector))
    .map((element) => element.innerText.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function fieldList(limit = 8): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select'))
    .map((field) => {
      const label = field.labels?.[0]?.innerText.trim();
      return label || field.getAttribute('aria-label') || field.getAttribute('name') || field.getAttribute('placeholder') || field.tagName.toLowerCase();
    })
    .filter((value): value is string => Boolean(value))
    .slice(0, limit);
}

export function readDomSummary() {
  return {
    headings: textList('h1, h2, h3'),
    buttons: textList('button, [role="button"]'),
    fields: fieldList(),
  };
}

