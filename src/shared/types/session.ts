import { z } from 'zod';
import { domSummarySchema, pageContextSchema } from './snapshot';

export const clipModeSchema = z.enum(['visible', 'region']);

export const clipRectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

const boxAnnotationSchema = z.object({
  id: z.string(),
  kind: z.literal('box'),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  color: z.string(),
});

const arrowAnnotationSchema = z.object({
  id: z.string(),
  kind: z.literal('arrow'),
  startX: z.number(),
  startY: z.number(),
  endX: z.number(),
  endY: z.number(),
  color: z.string(),
});

const textAnnotationSchema = z.object({
  id: z.string(),
  kind: z.literal('text'),
  x: z.number(),
  y: z.number(),
  text: z.string(),
  color: z.string(),
});

const legacyBoxAnnotationSchema = z
  .object({
    id: z.string(),
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
    color: z.string(),
  })
  .transform((annotation) => ({
    ...annotation,
    kind: 'box' as const,
  }));

export const clipAnnotationSchema = z.union([
  boxAnnotationSchema,
  arrowAnnotationSchema,
  textAnnotationSchema,
  legacyBoxAnnotationSchema,
]);

export const runtimeEventSchema = z.object({
  type: z.enum([
    'window_error',
    'unhandled_rejection',
    'console_error',
    'console_warn',
    'console_log',
    'route_change',
  ]),
  level: z.enum(['error', 'warn', 'log']),
  message: z.string(),
  timestamp: z.string(),
  source: z.string().nullable().optional(),
  url: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
});

export const runtimeSummarySchema = z.object({
  installedAt: z.string(),
  lastSeenAt: z.string(),
  eventCount: z.number(),
  errorCount: z.number(),
  warningCount: z.number(),
  networkRequestCount: z.number(),
  failedRequestCount: z.number(),
  slowRequestCount: z.number(),
  hasDomSummary: z.boolean(),
});

export const networkRequestSchema = z.object({
  id: z.string(),
  transport: z.enum(['fetch', 'xhr']),
  method: z.string(),
  url: z.string(),
  status: z.number().nullable(),
  ok: z.boolean(),
  durationMs: z.number(),
  classification: z.enum(['ok', 'failed', 'slow']),
  startedAt: z.string(),
  finishedAt: z.string(),
  error: z.string().nullable().optional(),
});

export const chromeDebuggerLogEntrySchema = z.object({
  source: z.string(),
  level: z.string(),
  text: z.string(),
  url: z.string().nullable().optional(),
  timestamp: z.string().nullable().optional(),
});

export const chromeDebuggerNetworkRequestSchema = z.object({
  id: z.string(),
  method: z.string(),
  url: z.string(),
  resourceType: z.string().nullable().optional(),
  status: z.number().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  priority: z.string().nullable().optional(),
  encodedDataLength: z.number().nullable().optional(),
  failedReason: z.string().nullable().optional(),
  blockedReason: z.string().nullable().optional(),
  fromDiskCache: z.boolean().optional(),
  fromServiceWorker: z.boolean().optional(),
  timestamp: z.string().nullable().optional(),
});

export const chromeDebuggerFrameSchema = z.object({
  id: z.string(),
  url: z.string(),
  domainAndRegistry: z.string().nullable().optional(),
  secureContextType: z.string().nullable().optional(),
  mimeType: z.string().nullable().optional(),
  unreachableUrl: z.string().nullable().optional(),
});

export const chromeDebuggerContextSchema = z.object({
  capturedAt: z.string(),
  attachError: z.string().nullable().optional(),
  detachReason: z.string().nullable().optional(),
  currentUrl: z.string(),
  currentTitle: z.string(),
  frameCount: z.number(),
  layout: z.object({
    viewportWidth: z.number().nullable(),
    viewportHeight: z.number().nullable(),
    contentWidth: z.number().nullable(),
    contentHeight: z.number().nullable(),
  }),
  performance: z.object({
    documents: z.number().nullable(),
    frames: z.number().nullable(),
    nodes: z.number().nullable(),
    jsEventListeners: z.number().nullable(),
    jsHeapUsedSize: z.number().nullable(),
    jsHeapTotalSize: z.number().nullable(),
    layoutCount: z.number().nullable(),
    recalcStyleCount: z.number().nullable(),
    taskDuration: z.number().nullable(),
  }),
  frames: z.array(chromeDebuggerFrameSchema),
  logs: z.array(chromeDebuggerLogEntrySchema),
  network: z.array(chromeDebuggerNetworkRequestSchema),
});

export const runtimeContextSchema = z.object({
  summary: runtimeSummarySchema,
  events: z.array(runtimeEventSchema),
  network: z.array(networkRequestSchema),
  domSummary: z
    .object({
      path: z.string(),
      headingTexts: z.array(z.string()),
      buttonTexts: z.array(z.string()),
      inputLabels: z.array(z.string()),
    })
    .nullable(),
  chromeDebugger: chromeDebuggerContextSchema.nullable().optional(),
});

export const clipRecordSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  clipMode: clipModeSchema,
  title: z.string(),
  imageAssetId: z.string(),
  imageFormat: z.enum(['png']),
  imageWidth: z.number(),
  imageHeight: z.number(),
  crop: clipRectSchema,
  page: pageContextSchema.pick({
    title: true,
    url: true,
    viewport: true,
    userAgent: true,
    platform: true,
    language: true,
    timeZone: true,
  }),
  domSummary: domSummarySchema,
  runtimeContext: runtimeContextSchema.nullable(),
  note: z.string(),
  annotations: z.array(clipAnnotationSchema),
});

export const clipSessionSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  clips: z.array(clipRecordSchema),
  activeClipId: z.string().nullable(),
});

export const clipSessionIndexSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  clipIds: z.array(z.string()),
  activeClipId: z.string().nullable(),
});

export type ClipMode = z.infer<typeof clipModeSchema>;
export type ClipRect = z.infer<typeof clipRectSchema>;
export type ClipAnnotation = z.infer<typeof clipAnnotationSchema>;
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export type RuntimeSummary = z.infer<typeof runtimeSummarySchema>;
export type NetworkRequest = z.infer<typeof networkRequestSchema>;
export type ChromeDebuggerLogEntry = z.infer<typeof chromeDebuggerLogEntrySchema>;
export type ChromeDebuggerNetworkRequest = z.infer<typeof chromeDebuggerNetworkRequestSchema>;
export type ChromeDebuggerFrame = z.infer<typeof chromeDebuggerFrameSchema>;
export type ChromeDebuggerContext = z.infer<typeof chromeDebuggerContextSchema>;
export type RuntimeContext = z.infer<typeof runtimeContextSchema>;
export type ClipRecord = z.infer<typeof clipRecordSchema>;
export type ClipSession = z.infer<typeof clipSessionSchema>;
export type ClipSessionIndex = z.infer<typeof clipSessionIndexSchema>;
