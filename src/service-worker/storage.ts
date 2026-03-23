import type { ClipAnnotation, ClipHandoffRecord, ClipRecord, ClipSession, ClipSessionIndex } from '../shared/types/session';
import { STORAGE_KEYS, getClipStorageKey } from '../shared/snapshot/storage';
import { clipRecordSchema, clipSessionIndexSchema, clipSessionSchema } from '../shared/types/session';
import { createSnapshotId } from '../shared/utils/id';
import { putClipAsset } from '../shared/storage/blob-store';
import { z } from 'zod';

const legacyClipRecordSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  clipMode: z.enum(['visible', 'region']),
  title: z.string(),
  imageDataUrl: z.string(),
  imageFormat: z.enum(['png']),
  crop: z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
  }),
  page: z.object({
    title: z.string(),
    url: z.string(),
    viewport: z.object({
      width: z.number(),
      height: z.number(),
      dpr: z.number(),
    }),
    userAgent: z.string(),
    platform: z.string(),
    language: z.string(),
    timeZone: z.string(),
  }),
  domSummary: z.object({
    headings: z.array(z.string()),
    buttons: z.array(z.string()),
    fields: z.array(z.string()),
    selectedText: z.string().optional(),
  }),
  runtimeContext: z.unknown().nullable(),
  note: z.string(),
  annotations: z.array(
    z.object({
      id: z.string(),
      x: z.number(),
      y: z.number(),
      width: z.number(),
      height: z.number(),
      color: z.string(),
    }),
  ),
});

const legacyClipSessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  clips: z.array(legacyClipRecordSchema),
  activeClipId: z.string().nullable(),
});

async function saveClipRecord(clip: ClipRecord): Promise<void> {
  await chrome.storage.local.set({
    [getClipStorageKey(clip.id)]: clip,
  });
}

async function getClipRecord(clipId: string): Promise<ClipRecord | null> {
  const result = await chrome.storage.local.get(getClipStorageKey(clipId));
  const clip = result[getClipStorageKey(clipId)] as ClipRecord | undefined;
  return clip ? clipRecordSchema.parse(clip) : null;
}

async function getClipSessionIndex(): Promise<ClipSessionIndex | null> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.clipSessionIndex);
  const sessionIndex = result[STORAGE_KEYS.clipSessionIndex] as ClipSessionIndex | undefined;
  return sessionIndex ? clipSessionIndexSchema.parse(sessionIndex) : null;
}

async function saveClipSessionIndex(sessionIndex: ClipSessionIndex): Promise<void> {
  await chrome.storage.local.set({
    [STORAGE_KEYS.clipSessionIndex]: sessionIndex,
  });
}

async function migrateLegacySessionIfNeeded(): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEYS.legacyClipSession);
  const legacySession = result[STORAGE_KEYS.legacyClipSession] as unknown;
  if (!legacySession || typeof legacySession !== 'object' || !('clips' in legacySession)) {
    return;
  }

  const parsedLegacySession = legacyClipSessionSchema.safeParse(legacySession);
  if (!parsedLegacySession.success) {
    return;
  }

  const migratedClips = await Promise.all(
    parsedLegacySession.data.clips.map(async (legacyClip) => {
      const imageAssetId = `clip-asset:${legacyClip.id}`;
      const imageBlob = await fetch(legacyClip.imageDataUrl).then(async (response) => response.blob());
      await putClipAsset(imageAssetId, imageBlob);

      const imageWidth = Math.max(1, Math.round(legacyClip.crop.width * legacyClip.page.viewport.dpr));
      const imageHeight = Math.max(1, Math.round(legacyClip.crop.height * legacyClip.page.viewport.dpr));

      return clipRecordSchema.parse({
        ...legacyClip,
        imageAssetId,
        imageWidth,
        imageHeight,
      });
    }),
  );

  await Promise.all(migratedClips.map((clip) => saveClipRecord(clip)));
  await saveClipSessionIndex({
    id: parsedLegacySession.data.id,
    createdAt: parsedLegacySession.data.createdAt,
    updatedAt: parsedLegacySession.data.updatedAt,
    clipIds: migratedClips.map((clip) => clip.id),
    activeClipId: parsedLegacySession.data.activeClipId,
  });
  await chrome.storage.local.remove(STORAGE_KEYS.legacyClipSession);
}

export async function getClipSession(): Promise<ClipSession | null> {
  await migrateLegacySessionIfNeeded();

  const sessionIndex = await getClipSessionIndex();
  if (!sessionIndex) {
    return null;
  }

  const clips = (
    await Promise.all(sessionIndex.clipIds.map((clipId) => getClipRecord(clipId)))
  ).filter((clip): clip is ClipRecord => clip !== null);

  return clipSessionSchema.parse({
    id: sessionIndex.id,
    createdAt: sessionIndex.createdAt,
    updatedAt: sessionIndex.updatedAt,
    clips,
    activeClipId: sessionIndex.activeClipId,
  });
}

export async function ensureClipSession(): Promise<ClipSession> {
  const existing = await getClipSession();
  if (existing) {
    return existing;
  }

  const createdAt = new Date().toISOString();
  const session = clipSessionSchema.parse({
    id: createSnapshotId(),
    createdAt,
    updatedAt: createdAt,
    clips: [],
    activeClipId: null,
  });

  await saveClipSessionIndex({
    id: session.id,
    createdAt,
    updatedAt: createdAt,
    clipIds: [],
    activeClipId: null,
  });
  return session;
}

export async function appendClipToSession(clip: ClipRecord): Promise<ClipSession> {
  const session = await ensureClipSession();
  const updatedAt = new Date().toISOString();
  await saveClipRecord(clip);
  await saveClipSessionIndex({
    id: session.id,
    createdAt: session.createdAt,
    updatedAt,
    activeClipId: clip.id,
    clipIds: [...session.clips.map((existingClip) => existingClip.id), clip.id],
  });

  return clipSessionSchema.parse({
    ...session,
    updatedAt,
    activeClipId: clip.id,
    clips: [...session.clips, clip],
  });
}

export async function updateClipNote(clipId: string, note: string): Promise<ClipSession> {
  const session = await ensureClipSession();
  const targetClip = session.clips.find((clip) => clip.id === clipId);
  if (!targetClip) {
    return session;
  }

  const updatedAt = new Date().toISOString();
  const updatedClip = clipRecordSchema.parse({
    ...targetClip,
    note,
  });
  await saveClipRecord(updatedClip);
  await saveClipSessionIndex({
    id: session.id,
    createdAt: session.createdAt,
    updatedAt,
    activeClipId: session.activeClipId,
    clipIds: session.clips.map((clip) => clip.id),
  });

  return clipSessionSchema.parse({
    ...session,
    updatedAt,
    clips: session.clips.map((clip) => (clip.id === clipId ? updatedClip : clip)),
  });
}

export async function updateClipTitle(clipId: string, title: string): Promise<ClipSession> {
  const session = await ensureClipSession();
  const targetClip = session.clips.find((clip) => clip.id === clipId);
  if (!targetClip) {
    return session;
  }

  const updatedAt = new Date().toISOString();
  const nextTitle = title.trim() || targetClip.title;
  const updatedClip = clipRecordSchema.parse({
    ...targetClip,
    title: nextTitle,
  });
  await saveClipRecord(updatedClip);
  await saveClipSessionIndex({
    id: session.id,
    createdAt: session.createdAt,
    updatedAt,
    activeClipId: session.activeClipId,
    clipIds: session.clips.map((clip) => clip.id),
  });

  return clipSessionSchema.parse({
    ...session,
    updatedAt,
    clips: session.clips.map((clip) => (clip.id === clipId ? updatedClip : clip)),
  });
}

export async function updateClipAnnotations(clipId: string, annotations: ClipAnnotation[]): Promise<ClipSession> {
  const session = await ensureClipSession();
  const targetClip = session.clips.find((clip) => clip.id === clipId);
  if (!targetClip) {
    return session;
  }

  const updatedAt = new Date().toISOString();
  const updatedClip = clipRecordSchema.parse({
    ...targetClip,
    annotations,
  });
  await saveClipRecord(updatedClip);
  await saveClipSessionIndex({
    id: session.id,
    createdAt: session.createdAt,
    updatedAt,
    activeClipId: session.activeClipId,
    clipIds: session.clips.map((clip) => clip.id),
  });

  return clipSessionSchema.parse({
    ...session,
    updatedAt,
    clips: session.clips.map((clip) => (clip.id === clipId ? updatedClip : clip)),
  });
}

export async function updateClipHandoff(clipId: string, handoff: ClipHandoffRecord): Promise<ClipSession> {
  const session = await ensureClipSession();
  const targetClip = session.clips.find((clip) => clip.id === clipId);
  if (!targetClip) {
    return session;
  }

  const updatedAt = new Date().toISOString();
  const updatedClip = clipRecordSchema.parse({
    ...targetClip,
    lastHandoff: handoff,
  });
  await saveClipRecord(updatedClip);
  await saveClipSessionIndex({
    id: session.id,
    createdAt: session.createdAt,
    updatedAt,
    activeClipId: session.activeClipId,
    clipIds: session.clips.map((clip) => clip.id),
  });

  return clipSessionSchema.parse({
    ...session,
    updatedAt,
    clips: session.clips.map((clip) => (clip.id === clipId ? updatedClip : clip)),
  });
}
