import { createDownloadFilename } from '../shared/export/file';
import { createClipSessionMarkdown } from '../shared/export/session-markdown';
import { putClipAsset } from '../shared/storage/blob-store';
import type { ClipMode, ClipSession, RuntimeContext } from '../shared/types/session';
import { clipRecordSchema } from '../shared/types/session';
import type { PageContext } from '../shared/types/snapshot';
import { createSnapshotId } from '../shared/utils/id';
import { appendClipToSession, ensureClipSession } from './storage';

async function startDownload(url: string, filename: string): Promise<void> {
  await chrome.downloads.download({
    url,
    filename,
    saveAs: true,
  });
}

export async function commitClipToSession(params: {
  clipMode: ClipMode;
  title?: string;
  note?: string;
  imageDataUrl: string;
  imageWidth: number;
  imageHeight: number;
  crop: { x: number; y: number; width: number; height: number };
  pageContext: PageContext;
  runtimeContext: RuntimeContext | null;
  annotations?: import('../shared/types/session').ClipAnnotation[];
}): Promise<ClipSession> {
  const session = await ensureClipSession();
  const clipId = createSnapshotId();
  const imageAssetId = `clip-asset:${clipId}`;
  const imageBlob = await fetch(params.imageDataUrl).then(async (response) => response.blob());
  await putClipAsset(imageAssetId, imageBlob);

  const clip = clipRecordSchema.parse({
    id: clipId,
    createdAt: new Date().toISOString(),
    clipMode: params.clipMode,
    title: params.title?.trim() || `Clip ${session.clips.length + 1}`,
    imageAssetId,
    imageFormat: 'png',
    imageWidth: params.imageWidth,
    imageHeight: params.imageHeight,
    crop: params.crop,
    page: {
      title: params.pageContext.title,
      url: params.pageContext.url,
      viewport: params.pageContext.viewport,
      userAgent: params.pageContext.userAgent,
      platform: params.pageContext.platform,
      language: params.pageContext.language,
      timeZone: params.pageContext.timeZone,
    },
    domSummary: params.pageContext.domSummary,
    runtimeContext: params.runtimeContext,
    note: params.note?.trim() ?? '',
    annotations: params.annotations ?? [],
  });

  return appendClipToSession(clip);
}

export async function exportClipSession(session: ClipSession, format: 'json' | 'markdown'): Promise<void> {
  switch (format) {
    case 'json': {
      const json = JSON.stringify(session, null, 2);
      await startDownload(
        `data:application/json;charset=utf-8,${encodeURIComponent(json)}`,
        createDownloadFilename('snapclip-session', 'json'),
      );
      return;
    }
    case 'markdown': {
      const markdown = createClipSessionMarkdown(session);
      await startDownload(
        `data:text/markdown;charset=utf-8,${encodeURIComponent(markdown)}`,
        createDownloadFilename('snapclip-session', 'md'),
      );
      return;
    }
  }
}

export async function getOrCreateSession(): Promise<ClipSession> {
  return ensureClipSession();
}
