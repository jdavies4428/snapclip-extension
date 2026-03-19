export function createDownloadFilename(base: string, extension: string): string {
  const normalizedBase = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  const fallbackBase = normalizedBase || 'snapclip-snapshot';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  return `${fallbackBase}-${timestamp}.${extension}`;
}

