import type { RuntimeContext } from '../shared/types/session';
import { runtimeContextSchema } from '../shared/types/session';

function installRuntimeMonitorInPage() {
  const monitorKey = '__snapclipRuntimeMonitor';
  const slowRequestThresholdMs = 1500;
  const windowWithMonitor = window as Window & {
    [monitorKey]?: {
      installedAt: string;
      lastSeenAt: string;
      events: Array<Record<string, unknown>>;
      network: Array<Record<string, unknown>>;
      originalConsoleError?: typeof console.error;
      originalConsoleWarn?: typeof console.warn;
      originalFetch?: typeof fetch;
      originalXhrOpen?: typeof XMLHttpRequest.prototype.open;
      originalXhrSend?: typeof XMLHttpRequest.prototype.send;
      originalPushState?: typeof history.pushState;
      originalReplaceState?: typeof history.replaceState;
      handleWindowError?: (event: ErrorEvent) => void;
      handleUnhandledRejection?: (event: PromiseRejectionEvent) => void;
      handleRouteChange?: () => void;
    };
  };

  if (windowWithMonitor[monitorKey]) {
    return { installed: false };
  }

  const maxEvents = 50;
  const monitor = {
    installedAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    events: [] as Array<Record<string, unknown>>,
    network: [] as Array<Record<string, unknown>>,
    originalConsoleError: console.error,
    originalConsoleWarn: console.warn,
    originalFetch: window.fetch.bind(window),
    originalXhrOpen: XMLHttpRequest.prototype.open,
    originalXhrSend: XMLHttpRequest.prototype.send,
    originalPushState: history.pushState.bind(history),
    originalReplaceState: history.replaceState.bind(history),
    handleWindowError: undefined as ((event: ErrorEvent) => void) | undefined,
    handleUnhandledRejection: undefined as ((event: PromiseRejectionEvent) => void) | undefined,
    handleRouteChange: undefined as (() => void) | undefined,
  };

  const serializeUnknown = (value: unknown): string => {
    if (value instanceof Error) {
      return value.stack || value.message || String(value);
    }

    if (typeof value === 'string') {
      return value;
    }

    if (
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
  };

  const collectText = (selector: string, limit: number) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector))
      .map((node) => node.innerText?.trim() || node.textContent?.trim() || '')
      .filter(Boolean)
      .slice(0, limit);

  const collectFieldLabels = (limit: number) => {
    const labels: string[] = [];

    for (const element of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input, textarea, select',
    )) {
      const byFor =
        element.id
          ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent
          : '';
      const parentLabel = element.closest('label')?.textContent || '';
      const labelText =
        element.getAttribute('aria-label') ||
        element.getAttribute('placeholder') ||
        byFor ||
        parentLabel ||
        element.getAttribute('name') ||
        element.id;

      if (!labelText) {
        continue;
      }

      labels.push(labelText.trim());
      if (labels.length >= limit) {
        break;
      }
    }

    return labels;
  };

  const captureDomSummary = () => ({
    path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    headingTexts: collectText('h1, h2, h3', 6),
    buttonTexts: collectText('button, [role="button"]', 8),
    inputLabels: collectFieldLabels(8),
  });

  const enqueue = (event: Record<string, unknown>) => {
    monitor.lastSeenAt = new Date().toISOString();
    monitor.events.push({
      ...event,
      timestamp: new Date().toISOString(),
    });

    if (monitor.events.length > maxEvents) {
      monitor.events.splice(0, monitor.events.length - maxEvents);
    }
  };

  const enqueueNetwork = (request: Record<string, unknown>) => {
    monitor.lastSeenAt = new Date().toISOString();
    monitor.network.push(request);

    if (monitor.network.length > maxEvents) {
      monitor.network.splice(0, monitor.network.length - maxEvents);
    }
  };

  const classifyRequest = (status: number | null, durationMs: number, error: string | null) => {
    if (error || status === null || status >= 400) {
      return 'failed';
    }

    if (durationMs >= slowRequestThresholdMs) {
      return 'slow';
    }

    return 'ok';
  };

  monitor.handleWindowError = (event) => {
    enqueue({
      type: 'window_error',
      level: 'error',
      message: event.message || 'Unknown window error',
      source: event.filename ? `${event.filename}:${event.lineno || 0}:${event.colno || 0}` : null,
    });
  };

  monitor.handleUnhandledRejection = (event) => {
    enqueue({
      type: 'unhandled_rejection',
      level: 'error',
      message: serializeUnknown(event.reason),
      source: null,
    });
  };

  monitor.handleRouteChange = () => {
    enqueue({
      type: 'route_change',
      level: 'log',
      message: `${window.location.pathname}${window.location.search}${window.location.hash}`,
      url: window.location.href,
      title: document.title || '',
    });
  };

  console.error = (...args) => {
    enqueue({
      type: 'console_error',
      level: 'error',
      message: args.map((entry) => serializeUnknown(entry)).join(' '),
      source: null,
    });
    monitor.originalConsoleError?.apply(console, args);
  };

  console.warn = (...args) => {
    enqueue({
      type: 'console_warn',
      level: 'warn',
      message: args.map((entry) => serializeUnknown(entry)).join(' '),
      source: null,
    });
    monitor.originalConsoleWarn?.apply(console, args);
  };

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const startedAt = new Date().toISOString();
    const startTime = performance.now();
    const method =
      (init?.method ||
        (typeof Request !== 'undefined' && input instanceof Request ? input.method : 'GET') ||
        'GET').toUpperCase();
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    try {
      const response = await monitor.originalFetch!(input, init);
      const durationMs = Math.round(performance.now() - startTime);
      enqueueNetwork({
        id: `fetch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        transport: 'fetch',
        method,
        url,
        status: response.status,
        ok: response.ok,
        durationMs,
        classification: classifyRequest(response.status, durationMs, null),
        startedAt,
        finishedAt: new Date().toISOString(),
        error: null,
      });
      return response;
    } catch (error) {
      const durationMs = Math.round(performance.now() - startTime);
      enqueueNetwork({
        id: `fetch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        transport: 'fetch',
        method,
        url,
        status: null,
        ok: false,
        durationMs,
        classification: 'failed',
        startedAt,
        finishedAt: new Date().toISOString(),
        error: serializeUnknown(error),
      });
      throw error;
    }
  };

  XMLHttpRequest.prototype.open = function patchedOpen(
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null,
  ) {
    Object.defineProperty(this, '__snapclipRequestMeta', {
      value: {
        method: String(method || 'GET').toUpperCase(),
        url: String(url),
      },
      configurable: true,
      writable: true,
    });

    return monitor.originalXhrOpen!.call(this, method, url, async ?? true, username, password);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body?: Document | XMLHttpRequestBodyInit | null) {
    const requestMeta = (this as XMLHttpRequest & {
      __snapclipRequestMeta?: { method: string; url: string };
    }).__snapclipRequestMeta;
    const startedAt = new Date().toISOString();
    const startTime = performance.now();

    const finalize = (status: number | null, error: string | null) => {
      const durationMs = Math.round(performance.now() - startTime);
      enqueueNetwork({
        id: `xhr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        transport: 'xhr',
        method: requestMeta?.method || 'GET',
        url: requestMeta?.url || window.location.href,
        status,
        ok: !error && status !== null && status < 400,
        durationMs,
        classification: classifyRequest(status, durationMs, error),
        startedAt,
        finishedAt: new Date().toISOString(),
        error,
      });
    };

    this.addEventListener(
      'loadend',
      () => {
        finalize(this.status || null, this.status === 0 ? 'Request finished without an HTTP status.' : null);
      },
      { once: true },
    );

    this.addEventListener(
      'error',
      () => {
        finalize(this.status || null, 'XMLHttpRequest network error.');
      },
      { once: true },
    );

    this.addEventListener(
      'timeout',
      () => {
        finalize(this.status || null, 'XMLHttpRequest timed out.');
      },
      { once: true },
    );

    return monitor.originalXhrSend!.call(this, body as never);
  };

  history.pushState = (...args) => {
    const result = monitor.originalPushState?.(...args);
    monitor.handleRouteChange?.();
    return result as void;
  };

  history.replaceState = (...args) => {
    const result = monitor.originalReplaceState?.(...args);
    monitor.handleRouteChange?.();
    return result as void;
  };

  window.addEventListener('error', monitor.handleWindowError);
  window.addEventListener('unhandledrejection', monitor.handleUnhandledRejection);
  window.addEventListener('popstate', monitor.handleRouteChange);
  window.addEventListener('hashchange', monitor.handleRouteChange);

  windowWithMonitor[monitorKey] = monitor;

  return {
    installed: true,
    domSummary: captureDomSummary(),
  };
}

function readRuntimeContextInPage() {
  const monitorKey = '__snapclipRuntimeMonitor';
  const windowWithMonitor = window as Window & {
    [monitorKey]?: {
      installedAt: string;
      lastSeenAt: string;
      events: Array<{
        type?: string;
        level?: string;
        message?: string;
        timestamp?: string;
        source?: string | null;
        url?: string | null;
        title?: string | null;
      }>;
      network: Array<{
        id?: string;
        transport?: string;
        method?: string;
        url?: string;
        status?: number | null;
        ok?: boolean;
        durationMs?: number;
        classification?: string;
        startedAt?: string;
        finishedAt?: string;
        error?: string | null;
      }>;
    };
  };

  const monitor = windowWithMonitor[monitorKey];

  const collectText = (selector: string, limit: number) =>
    Array.from(document.querySelectorAll<HTMLElement>(selector))
      .map((node) => node.innerText?.trim() || node.textContent?.trim() || '')
      .filter(Boolean)
      .slice(0, limit);

  const collectFieldLabels = (limit: number) => {
    const labels: string[] = [];

    for (const element of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input, textarea, select',
    )) {
      const byFor =
        element.id
          ? document.querySelector(`label[for="${CSS.escape(element.id)}"]`)?.textContent
          : '';
      const parentLabel = element.closest('label')?.textContent || '';
      const labelText =
        element.getAttribute('aria-label') ||
        element.getAttribute('placeholder') ||
        byFor ||
        parentLabel ||
        element.getAttribute('name') ||
        element.id;

      if (!labelText) {
        continue;
      }

      labels.push(labelText.trim());
      if (labels.length >= limit) {
        break;
      }
    }

    return labels;
  };

  const domSummary = {
    path: `${window.location.pathname}${window.location.search}${window.location.hash}`,
    headingTexts: collectText('h1, h2, h3', 6),
    buttonTexts: collectText('button, [role="button"]', 8),
    inputLabels: collectFieldLabels(8),
  };

  if (!monitor) {
    return {
      summary: {
        installedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        eventCount: 0,
        errorCount: 0,
        warningCount: 0,
        networkRequestCount: 0,
        failedRequestCount: 0,
        slowRequestCount: 0,
        hasDomSummary: true,
      },
      events: [],
      network: [],
      domSummary,
    };
  }

  const events = monitor.events
    .slice()
    .sort((left, right) => {
      const leftTime = new Date(left.timestamp || 0).getTime();
      const rightTime = new Date(right.timestamp || 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, 8);
  const network = monitor.network
    .slice()
    .sort((left, right) => {
      const leftTime = new Date(left.finishedAt || 0).getTime();
      const rightTime = new Date(right.finishedAt || 0).getTime();
      return rightTime - leftTime;
    })
    .slice(0, 12);

  return {
    summary: {
      installedAt: monitor.installedAt,
      lastSeenAt: monitor.lastSeenAt,
      eventCount: monitor.events.length,
      errorCount: monitor.events.filter((event) => event.level === 'error').length,
      warningCount: monitor.events.filter((event) => event.level === 'warn').length,
      networkRequestCount: monitor.network.length,
      failedRequestCount: monitor.network.filter((request) => request.classification === 'failed').length,
      slowRequestCount: monitor.network.filter((request) => request.classification === 'slow').length,
      hasDomSummary: true,
    },
    events,
    network,
    domSummary,
  };
}

export async function ensureRuntimeMonitor(tabId: number): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: installRuntimeMonitorInPage,
  });
}

export async function captureRuntimeContext(tabId: number): Promise<RuntimeContext> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: readRuntimeContextInPage,
  });

  return runtimeContextSchema.parse(result.result);
}
