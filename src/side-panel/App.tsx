import { useMemo, useState } from 'react';
import type { SnapClipMessageResponse } from '../shared/messaging/messages';
import type { ClipRecord } from '../shared/types/session';
import { useClipAssetUrl } from './state/useClipAssetUrl';
import { useClipSession } from './state/useClipSession';

function formatClipLabel(clip: ClipRecord, index: number): string {
  const fallback = `Clip ${index + 1}`;
  const title = clip.title.trim() || fallback;
  return title.length > 48 ? `${title.slice(0, 47)}…` : title;
}

function formatClipMeta(clip: ClipRecord): string {
  const timestamp = new Date(clip.createdAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${clip.clipMode} • ${timestamp}`;
}

function ClipGalleryTile({
  clip,
  index,
  onOpen,
}: {
  clip: ClipRecord;
  index: number;
  onOpen: (clipId: string) => void;
}) {
  const imageUrl = useClipAssetUrl(clip.imageAssetId);

  return (
    <button
      aria-label={`Open ${clip.title || `clip ${index + 1}`} in the page editor`}
      className="clip-gallery-tile"
      onDoubleClick={() => onOpen(clip.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onOpen(clip.id);
        }
      }}
      title="Double-click to reopen this clip on the page."
      type="button"
    >
      {imageUrl ? (
        <img
          alt={clip.title || `Saved clip ${index + 1}`}
          className="clip-gallery-image"
          src={imageUrl}
        />
      ) : (
        <div className="clip-gallery-image clip-gallery-image-loading">Loading…</div>
      )}
      <div className="clip-gallery-overlay">
        <span className="clip-gallery-title">{formatClipLabel(clip, index)}</span>
        <span className="clip-gallery-meta">{formatClipMeta(clip)}</span>
      </div>
    </button>
  );
}

export default function App() {
  const { session, isLoading } = useClipSession();
  const [status, setStatus] = useState('');

  const clips = useMemo(
    () => [...(session?.clips ?? [])].sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()),
    [session?.clips],
  );

  async function openClipEditor(clipId: string) {
    try {
      const response = (await chrome.runtime.sendMessage({
        type: 'open-clip-editor',
        clipId,
      })) as SnapClipMessageResponse;

      setStatus(response.ok ? 'Opened clip editor.' : response.error);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Failed to open the clip editor.');
    }
  }

  if (isLoading) {
    return (
      <main className="gallery-shell">
        <section className="gallery-empty">
          <p className="gallery-empty-copy">Loading saved clips…</p>
        </section>
      </main>
    );
  }

  if (!clips.length) {
    return (
      <main className="gallery-shell">
        <section className="gallery-empty">
          <p className="gallery-empty-copy">Saved clips appear here. Double-click a thumbnail to reopen it on the page.</p>
        </section>
        <p aria-live="polite" className="sr-only" role="status">
          {status}
        </p>
      </main>
    );
  }

  return (
    <main className="gallery-shell">
      <section aria-label="Saved clips" className="clip-gallery">
        {clips.map((clip, index) => (
          <ClipGalleryTile clip={clip} index={index} key={clip.id} onOpen={openClipEditor} />
        ))}
      </section>
      <p aria-live="polite" className="sr-only" role="status">
        {status}
      </p>
    </main>
  );
}
