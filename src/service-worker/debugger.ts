import type {
  ChromeDebuggerContext,
  ChromeDebuggerFrame,
  ChromeDebuggerHeader,
  ChromeDebuggerLogEntry,
  ChromeDebuggerNetworkRequest,
} from '../shared/types/session';
import { formatDebuggerHeadersText, sanitizeDebuggerHeaders } from '../shared/export/evidence';

const DEBUGGER_PROTOCOL_VERSIONS = ['1.3', '1.2', '1.1', '1.0', '0.1'] as const;
const MAX_LOG_ENTRIES = 12;
const MAX_NETWORK_ENTRIES = 32;
const MAX_FRAME_ENTRIES = 8;
const OBSERVATION_WINDOW_MS = 450;

type DebuggerMetricName =
  | 'Documents'
  | 'Frames'
  | 'Nodes'
  | 'JSEventListeners'
  | 'JSHeapUsedSize'
  | 'JSHeapTotalSize'
  | 'LayoutCount'
  | 'RecalcStyleCount'
  | 'TaskDuration';

type NetworkSnapshot = ChromeDebuggerNetworkRequest & {
  _seenAt: number;
};

function emptyDebuggerContext(fallback: { url: string; title: string }, error?: string): ChromeDebuggerContext {
  return {
    capturedAt: new Date().toISOString(),
    attachError: error ?? null,
    detachReason: null,
    observationWindowMs: OBSERVATION_WINDOW_MS,
    networkEntryLimit: MAX_NETWORK_ENTRIES,
    currentUrl: fallback.url,
    currentTitle: fallback.title,
    frameCount: 0,
    layout: {
      viewportWidth: null,
      viewportHeight: null,
      contentWidth: null,
      contentHeight: null,
    },
    performance: {
      documents: null,
      frames: null,
      nodes: null,
      jsEventListeners: null,
      jsHeapUsedSize: null,
      jsHeapTotalSize: null,
      layoutCount: null,
      recalcStyleCount: null,
      taskDuration: null,
    },
    frames: [],
    logs: [],
    network: [],
  };
}

function wait(ms: number) {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, ms);
  });
}

function normalizeHeaders(headers: unknown): ChromeDebuggerHeader[] {
  if (!headers || typeof headers !== 'object') {
    return [];
  }

  if (Array.isArray(headers)) {
    return headers.flatMap((entry) => {
      if (!entry || typeof entry !== 'object') {
        return [];
      }

      const candidate = entry as { name?: unknown; value?: unknown };
      if (typeof candidate.name !== 'string') {
        return [];
      }

      return [
        {
          name: candidate.name,
          value: typeof candidate.value === 'string' ? candidate.value : String(candidate.value ?? ''),
        },
      ];
    });
  }

  return Object.entries(headers as Record<string, unknown>).map(([name, value]) => ({
    name,
    value: typeof value === 'string' ? value : String(value ?? ''),
  }));
}

function captureHeaders(headers: unknown) {
  const sanitized = sanitizeDebuggerHeaders(normalizeHeaders(headers), 24, 180);

  return {
    headers: sanitized.headers,
    headersText: formatDebuggerHeadersText(sanitized.headers),
    hasHeaders: sanitized.headers.length > 0,
    isTruncated: sanitized.isTruncated,
  };
}

function readMetricValue(
  metrics: Array<{ name?: string; value?: number }> | undefined,
  name: DebuggerMetricName,
): number | null {
  const match = metrics?.find((entry) => entry.name === name);
  return typeof match?.value === 'number' ? match.value : null;
}

function serializeRemoteValue(value: unknown): string {
  if (value instanceof Error) {
    return value.stack || value.message || String(value);
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null ||
    value === undefined
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function remoteObjectToText(object: {
  value?: unknown;
  unserializableValue?: string;
  description?: string;
  type?: string;
}): string {
  if (typeof object.value !== 'undefined') {
    return serializeRemoteValue(object.value);
  }

  if (object.unserializableValue) {
    return object.unserializableValue;
  }

  if (object.description) {
    return object.description;
  }

  return object.type || 'unknown';
}

function flattenFrameTree(
  frameTree: {
    frame?: {
      id?: string;
      url?: string;
      domainAndRegistry?: string;
      secureContextType?: string;
      mimeType?: string;
      unreachableUrl?: string;
    };
    childFrames?: Array<unknown>;
  } | null | undefined,
  acc: ChromeDebuggerFrame[],
) {
  if (!frameTree?.frame) {
    return;
  }

  acc.push({
    id: String(frameTree.frame.id || `frame-${acc.length + 1}`),
    url: String(frameTree.frame.url || ''),
    domainAndRegistry: frameTree.frame.domainAndRegistry ?? null,
    secureContextType: frameTree.frame.secureContextType ?? null,
    mimeType: frameTree.frame.mimeType ?? null,
    unreachableUrl: frameTree.frame.unreachableUrl ?? null,
  });

  const childFrames = Array.isArray(frameTree.childFrames) ? frameTree.childFrames : [];
  childFrames.forEach((child) => {
    flattenFrameTree(child as Parameters<typeof flattenFrameTree>[0], acc);
  });
}

export async function captureChromeDebuggerContext(
  tabId: number,
  fallback: { url: string; title: string },
): Promise<ChromeDebuggerContext> {
  const target: chrome.debugger.Debuggee = { tabId };
  const logs: ChromeDebuggerLogEntry[] = [];
  const networkById = new Map<string, NetworkSnapshot>();
  let detachReason: string | null = null;
  let attached = false;

  const pushLog = (entry: ChromeDebuggerLogEntry) => {
    logs.push(entry);
    if (logs.length > MAX_LOG_ENTRIES) {
      logs.splice(0, logs.length - MAX_LOG_ENTRIES);
    }
  };

  const upsertNetwork = (id: string, patch: Partial<NetworkSnapshot>) => {
    const existing = networkById.get(id);
    const next: NetworkSnapshot = {
      id,
      method: existing?.method || 'GET',
      url: existing?.url || fallback.url,
      resourceType: existing?.resourceType ?? null,
      status: existing?.status ?? null,
      mimeType: existing?.mimeType ?? null,
      priority: existing?.priority ?? null,
      encodedDataLength: existing?.encodedDataLength ?? null,
      failedReason: existing?.failedReason ?? null,
      blockedReason: existing?.blockedReason ?? null,
      fromDiskCache: existing?.fromDiskCache ?? false,
      fromServiceWorker: existing?.fromServiceWorker ?? false,
      requestHeaders: existing?.requestHeaders ?? [],
      responseHeaders: existing?.responseHeaders ?? [],
      requestHeadersText: existing?.requestHeadersText ?? null,
      responseHeadersText: existing?.responseHeadersText ?? null,
      hasRequestHeaders: existing?.hasRequestHeaders ?? false,
      hasResponseHeaders: existing?.hasResponseHeaders ?? false,
      hasRequestBody: existing?.hasRequestBody ?? false,
      hasResponseBody: existing?.hasResponseBody ?? false,
      isTruncated: existing?.isTruncated ?? false,
      statusText: existing?.statusText ?? null,
      timestamp: existing?.timestamp ?? null,
      ...existing,
      ...patch,
      _seenAt: Date.now(),
    };
    networkById.set(id, next);
  };

  const handleDebuggerEvent = (
    source: chrome.debugger.DebuggerSession,
    method: string,
    params?: object,
  ) => {
    const eventParams = (params ?? {}) as Record<string, unknown>;

    if (source.tabId !== tabId) {
      return;
    }

    if (method === 'Log.entryAdded') {
      const entry = eventParams.entry as
        | {
            source?: string;
            level?: string;
            text?: string;
            url?: string;
          }
        | undefined;
      pushLog({
        source: String(entry?.source || 'log'),
        level: String(entry?.level || 'info'),
        text: String(entry?.text || ''),
        url: entry?.url ? String(entry.url) : null,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (method === 'Runtime.consoleAPICalled') {
      const entry = eventParams as
        | {
            type?: string;
            args?: Array<{
              value?: unknown;
              unserializableValue?: string;
              description?: string;
              type?: string;
            }>;
          }
        | undefined;
      pushLog({
        source: 'console',
        level: String(entry?.type || 'log'),
        text: (entry?.args || []).map((item) => remoteObjectToText(item)).join(' ') || String(entry?.type || 'log'),
        url: null,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (method === 'Runtime.exceptionThrown') {
      const entry = eventParams as
        | {
            exceptionDetails?: {
              text?: string;
              url?: string;
              exception?: { description?: string; value?: unknown };
            };
          }
        | undefined;
      pushLog({
        source: 'runtime',
        level: 'error',
        text: String(
          entry?.exceptionDetails?.exception?.description ||
            entry?.exceptionDetails?.exception?.value ||
            entry?.exceptionDetails?.text ||
            'Runtime exception',
        ),
        url: entry?.exceptionDetails?.url ? String(entry.exceptionDetails.url) : null,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (method === 'Network.requestWillBeSent') {
      const entry = eventParams as
        | {
            requestId?: string;
            request?: {
              url?: string;
              method?: string;
              headers?: unknown;
              hasPostData?: boolean;
              initialPriority?: string;
            };
            type?: string;
          }
        | undefined;
      if (!entry?.requestId) {
        return;
      }
      const requestHeaders = captureHeaders(entry.request?.headers);
      upsertNetwork(entry.requestId, {
        method: String(entry.request?.method || 'GET'),
        url: String(entry.request?.url || fallback.url),
        resourceType: entry.type ? String(entry.type) : null,
        priority: entry.request?.initialPriority ? String(entry.request.initialPriority) : null,
        requestHeaders: requestHeaders.headers,
        requestHeadersText: requestHeaders.headersText,
        hasRequestHeaders: requestHeaders.hasHeaders,
        hasRequestBody: Boolean(entry.request?.hasPostData),
        isTruncated: requestHeaders.isTruncated,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (method === 'Network.requestWillBeSentExtraInfo') {
      const entry = eventParams as
        | {
            requestId?: string;
            headers?: unknown;
            headersText?: string;
          }
        | undefined;
      if (!entry?.requestId) {
        return;
      }
      const requestHeaders = captureHeaders(entry.headers);
      upsertNetwork(entry.requestId, {
        requestHeaders: requestHeaders.headers,
        requestHeadersText: requestHeaders.headersText,
        hasRequestHeaders: requestHeaders.hasHeaders,
        isTruncated: Boolean(requestHeaders.isTruncated),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (method === 'Network.responseReceived') {
      const entry = eventParams as
        | {
            requestId?: string;
            type?: string;
            response?: {
              status?: number;
              statusText?: string;
              mimeType?: string;
              headers?: unknown;
              fromDiskCache?: boolean;
              fromServiceWorker?: boolean;
            };
          }
        | undefined;
      if (!entry?.requestId) {
        return;
      }
      const responseHeaders = captureHeaders(entry.response?.headers);
      upsertNetwork(entry.requestId, {
        resourceType: entry.type ? String(entry.type) : null,
        status: typeof entry.response?.status === 'number' ? entry.response.status : null,
        statusText: entry.response?.statusText ? String(entry.response.statusText) : null,
        mimeType: entry.response?.mimeType ? String(entry.response.mimeType) : null,
        responseHeaders: responseHeaders.headers,
        responseHeadersText: responseHeaders.headersText,
        hasResponseHeaders: responseHeaders.hasHeaders,
        isTruncated: Boolean(responseHeaders.isTruncated),
        fromDiskCache: Boolean(entry.response?.fromDiskCache),
        fromServiceWorker: Boolean(entry.response?.fromServiceWorker),
      });
      return;
    }

    if (method === 'Network.responseReceivedExtraInfo') {
      const entry = eventParams as
        | {
            requestId?: string;
            headers?: unknown;
            headersText?: string;
            statusCode?: number;
          }
        | undefined;
      if (!entry?.requestId) {
        return;
      }
      const responseHeaders = captureHeaders(entry.headers);
      upsertNetwork(entry.requestId, {
        responseHeaders: responseHeaders.headers,
        responseHeadersText: responseHeaders.headersText,
        hasResponseHeaders: responseHeaders.hasHeaders,
        status: typeof entry.statusCode === 'number' ? entry.statusCode : undefined,
        isTruncated: Boolean(responseHeaders.isTruncated),
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (method === 'Network.loadingFinished') {
      const entry = eventParams as
        | {
            requestId?: string;
            encodedDataLength?: number;
          }
        | undefined;
      if (!entry?.requestId) {
        return;
      }
      upsertNetwork(entry.requestId, {
        encodedDataLength: typeof entry.encodedDataLength === 'number' ? entry.encodedDataLength : null,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (method === 'Network.loadingFailed') {
      const entry = eventParams as
        | {
            requestId?: string;
            errorText?: string;
            blockedReason?: string;
          }
        | undefined;
      if (!entry?.requestId) {
        return;
      }
      upsertNetwork(entry.requestId, {
        status: null,
        failedReason: entry.errorText ? String(entry.errorText) : null,
        blockedReason: entry.blockedReason ? String(entry.blockedReason) : null,
        timestamp: new Date().toISOString(),
      });
    }
  };

  const handleDetach = (source: chrome.debugger.Debuggee, reason: string) => {
    if (source.tabId !== tabId) {
      return;
    }

    attached = false;
    detachReason = reason;
  };

  chrome.debugger.onEvent.addListener(handleDebuggerEvent);
  chrome.debugger.onDetach.addListener(handleDetach);

  try {
    let attachedVersion: string | null = null;
    let lastAttachError: unknown = null;

    for (const version of DEBUGGER_PROTOCOL_VERSIONS) {
      try {
        await chrome.debugger.attach(target, version);
        attachedVersion = version;
        attached = true;
        break;
      } catch (error) {
        lastAttachError = error;
      }
    }

    if (!attachedVersion) {
      throw lastAttachError instanceof Error ? lastAttachError : new Error('Chrome debugger snapshot failed.');
    }

    attached = true;

    await Promise.allSettled([
      chrome.debugger.sendCommand(target, 'Page.enable'),
      chrome.debugger.sendCommand(target, 'Runtime.enable'),
      chrome.debugger.sendCommand(target, 'Log.enable'),
      chrome.debugger.sendCommand(target, 'Network.enable'),
      chrome.debugger.sendCommand(target, 'Performance.enable'),
    ]);

    await wait(OBSERVATION_WINDOW_MS);

    const [layoutResult, metricsResult, frameTreeResult, navigationResult] = await Promise.allSettled([
      chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics'),
      chrome.debugger.sendCommand(target, 'Performance.getMetrics'),
      chrome.debugger.sendCommand(target, 'Page.getFrameTree'),
      chrome.debugger.sendCommand(target, 'Page.getNavigationHistory'),
    ]);

    const layout = layoutResult.status === 'fulfilled' ? (layoutResult.value as Record<string, unknown>) : {};
    const metrics =
      metricsResult.status === 'fulfilled'
        ? ((metricsResult.value as { metrics?: Array<{ name?: string; value?: number }> }).metrics ?? [])
        : [];
    const frameTree =
      frameTreeResult.status === 'fulfilled'
        ? ((frameTreeResult.value as { frameTree?: Parameters<typeof flattenFrameTree>[0] }).frameTree ?? null)
        : null;
    const navigation =
      navigationResult.status === 'fulfilled'
        ? (navigationResult.value as {
            currentIndex?: number;
            entries?: Array<{ url?: string; title?: string }>;
          })
        : {};

    const frames: ChromeDebuggerFrame[] = [];
    flattenFrameTree(frameTree, frames);

    const currentEntry =
      typeof navigation.currentIndex === 'number' && Array.isArray(navigation.entries)
        ? navigation.entries[navigation.currentIndex]
        : null;

    const network = Array.from(networkById.values())
      .sort((left, right) => right._seenAt - left._seenAt)
      .slice(0, MAX_NETWORK_ENTRIES)
      .map(({ _seenAt, ...entry }) => entry);

    return {
      capturedAt: new Date().toISOString(),
      attachError: null,
      detachReason,
      observationWindowMs: OBSERVATION_WINDOW_MS,
      networkEntryLimit: MAX_NETWORK_ENTRIES,
      currentUrl: String(currentEntry?.url || frames[0]?.url || fallback.url),
      currentTitle: String(currentEntry?.title || fallback.title),
      frameCount: frames.length,
      layout: {
        viewportWidth:
          typeof (layout.cssLayoutViewport as { clientWidth?: number } | undefined)?.clientWidth === 'number'
            ? (layout.cssLayoutViewport as { clientWidth: number }).clientWidth
            : null,
        viewportHeight:
          typeof (layout.cssLayoutViewport as { clientHeight?: number } | undefined)?.clientHeight === 'number'
            ? (layout.cssLayoutViewport as { clientHeight: number }).clientHeight
            : null,
        contentWidth:
          typeof (layout.cssContentSize as { width?: number } | undefined)?.width === 'number'
            ? (layout.cssContentSize as { width: number }).width
            : null,
        contentHeight:
          typeof (layout.cssContentSize as { height?: number } | undefined)?.height === 'number'
            ? (layout.cssContentSize as { height: number }).height
            : null,
      },
      performance: {
        documents: readMetricValue(metrics, 'Documents'),
        frames: readMetricValue(metrics, 'Frames'),
        nodes: readMetricValue(metrics, 'Nodes'),
        jsEventListeners: readMetricValue(metrics, 'JSEventListeners'),
        jsHeapUsedSize: readMetricValue(metrics, 'JSHeapUsedSize'),
        jsHeapTotalSize: readMetricValue(metrics, 'JSHeapTotalSize'),
        layoutCount: readMetricValue(metrics, 'LayoutCount'),
        recalcStyleCount: readMetricValue(metrics, 'RecalcStyleCount'),
        taskDuration: readMetricValue(metrics, 'TaskDuration'),
      },
      frames: frames.slice(0, MAX_FRAME_ENTRIES),
      logs: logs.slice().reverse(),
      network,
    };
  } catch (error) {
    return emptyDebuggerContext(
      fallback,
      error instanceof Error ? error.message : 'Chrome debugger snapshot failed.',
    );
  } finally {
    chrome.debugger.onEvent.removeListener(handleDebuggerEvent);
    chrome.debugger.onDetach.removeListener(handleDetach);

    if (attached) {
      try {
        await chrome.debugger.detach(target);
      } catch {
        // Ignore cleanup failures.
      }
    }
  }
}
