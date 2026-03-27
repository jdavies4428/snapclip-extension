const DATA_URI_PREFIX_PATTERN = /^data:([^;]+);base64,/i;

export function base64ToBlob(base64: string, mimeType = 'image/png'): Blob {
  const normalized = base64.trim();
  const prefixMatch = normalized.match(DATA_URI_PREFIX_PATTERN);
  const resolvedMimeType = prefixMatch?.[1] || mimeType;
  const payload = prefixMatch ? normalized.slice(prefixMatch[0].length) : normalized;
  const decoded = atob(payload);
  const bytes = new Uint8Array(decoded.length);

  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }

  return new Blob([bytes], { type: resolvedMimeType });
}

export function buildAttachmentFilename(clipId: string, index = 0): string {
  const safeClipId = clipId.replace(/[^a-z0-9_-]+/gi, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'clip';
  const suffix = index > 0 ? `-${index + 1}` : '';
  return `llm-clip-${safeClipId}${suffix}.png`;
}

export function buildImageFormData(
  fieldName: string,
  blob: Blob,
  filename: string,
): FormData {
  const formData = new FormData();
  formData.append(fieldName, blob, filename);
  return formData;
}
