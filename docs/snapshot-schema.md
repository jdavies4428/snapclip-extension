# Clip session schema

The live product model is now a `ClipSession`, not a single `SnapshotRecord`.

Each session contains one or more clips from the current browsing task. The structure is still intentionally local-first and auditable.

## Current TypeScript shape

```ts
type ClipRecord = {
  id: string;
  createdAt: string;
  clipMode: 'visible' | 'region';
  title: string;
  imageAssetId: string;
  imageFormat: 'png';
  imageWidth: number;
  imageHeight: number;
  crop: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  page: {
    url: string;
    title: string;
    viewport: {
      width: number;
      height: number;
      dpr: number;
    };
    userAgent: string;
    platform: string;
    language: string;
    timeZone: string;
  };
  domSummary: {
    headings: string[];
    buttons: string[];
    fields: string[];
    selectedText?: string;
  };
  runtimeContext: RuntimeContext | null;
  note: string;
  annotations: Array<ClipAnnotation>;
};

type ClipSession = {
  id: string;
  createdAt: string;
  updatedAt: string;
  activeClipId: string | null;
  clips: ClipRecord[];
};
```

## Notes

- Clip image binaries now live in IndexedDB, while session metadata stays in `chrome.storage.local`.
- Runtime context exists, but it will be made explicit and bounded behind opt-in debug mode later in v1.
- The long-term export shape will produce local task bundles instead of only clipboard/download actions.
