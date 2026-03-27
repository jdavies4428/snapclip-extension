import { useMemo, useState } from 'react';
import type { BridgeSession } from '../bridge/client';
import type { IntegrationConnectionSummary, IntegrationTarget } from './types';

export type ShareSheetSelection =
  | {
      id: string;
      kind: 'agent';
      label: string;
      detail: string;
      session: BridgeSession;
    }
  | {
      id: string;
      kind: 'integration';
      label: string;
      detail: string;
      target: IntegrationTarget;
    };

export type ShareSheetResult = {
  id: string;
  label: string;
  ok: boolean;
  message: string;
};

function formatAgentLabel(session: BridgeSession): string {
  return session.target === 'codex' ? `${session.label} · Codex` : `${session.label} · Claude`;
}

export function ShareSheet({
  bridgeSessions,
  bridgeLoading,
  bridgeError,
  integrations,
  onClose,
  onOpenIntegrations,
  onSend,
}: {
  bridgeSessions: BridgeSession[];
  bridgeLoading: boolean;
  bridgeError: string;
  integrations: IntegrationConnectionSummary[];
  onClose: () => void;
  onOpenIntegrations: () => void;
  onSend: (selection: ShareSheetSelection[]) => Promise<ShareSheetResult[]>;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [results, setResults] = useState<ShareSheetResult[]>([]);

  const options = useMemo<ShareSheetSelection[]>(() => {
    const agentOptions = bridgeSessions.map((session) => ({
      id: `agent:${session.id}`,
      kind: 'agent' as const,
      label: session.target === 'codex' ? 'Codex' : 'Claude',
      detail: formatAgentLabel(session),
      session,
    }));
    const integrationOptions = integrations
      .filter((integration) => integration.configured)
      .map((integration) => ({
        id: `integration:${integration.target}`,
        kind: 'integration' as const,
        label: integration.label,
        detail: integration.detail,
        target: integration.target,
      }));
    return [...agentOptions, ...integrationOptions];
  }, [bridgeSessions, integrations]);

  const selectedOptions = options.filter((option) => selectedIds.includes(option.id));

  async function handleSend() {
    if (!selectedOptions.length || isSending) {
      return;
    }

    setIsSending(true);
    try {
      const nextResults = await onSend(selectedOptions);
      setResults(nextResults);
    } finally {
      setIsSending(false);
    }
  }

  function toggleSelection(id: string) {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  }

  return (
    <div aria-modal="true" className="session-picker-backdrop" role="dialog">
      <div className="session-picker-modal">
        <div className="session-picker-header">
          <div>
            <h2>Share to</h2>
            <p>Send this clip to a live agent session or any connected integration.</p>
          </div>
          <button
            aria-label="Close share sheet"
            className="btn btn-secondary session-picker-close"
            onClick={onClose}
            type="button"
          >
            Close
          </button>
        </div>

        <div className="share-sheet-group">
          <span className="section-title">AI Agents</span>
          {bridgeLoading ? (
            <p className="session-picker-empty">Loading live agent sessions…</p>
          ) : bridgeError ? (
            <p className="session-picker-empty">{bridgeError}</p>
          ) : bridgeSessions.length ? (
            <div className="share-sheet-list">
              {bridgeSessions.map((session) => {
                const optionId = `agent:${session.id}`;
                return (
                  <label className="share-sheet-row" key={optionId}>
                    <input
                      checked={selectedIds.includes(optionId)}
                      onChange={() => toggleSelection(optionId)}
                      type="checkbox"
                    />
                    <span className="share-sheet-row-copy">
                      <strong>{session.target === 'codex' ? 'Codex' : 'Claude'}</strong>
                      <span>{formatAgentLabel(session)}</span>
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <p className="session-picker-empty">No live Claude or Codex sessions are available right now.</p>
          )}
        </div>

        <div className="share-sheet-group">
          <span className="section-title">Integrations</span>
          <div className="share-sheet-list">
            {integrations.map((integration) => {
              const optionId = `integration:${integration.target}`;
              const isSelectable = integration.configured;
              return (
                <div className="share-sheet-row share-sheet-row--static" key={optionId}>
                  {isSelectable ? (
                    <input
                      checked={selectedIds.includes(optionId)}
                      onChange={() => toggleSelection(optionId)}
                      type="checkbox"
                    />
                  ) : (
                    <span className="share-sheet-placeholder">Setup</span>
                  )}
                  <span className="share-sheet-row-copy">
                    <strong>{integration.label}</strong>
                    <span>{integration.detail}</span>
                  </span>
                  {!integration.configured ? (
                    <button className="btn btn-ghost" onClick={onOpenIntegrations} type="button">
                      Setup
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>

        {results.length ? (
          <div className="share-results">
            {results.map((result) => (
              <p className={`share-result${result.ok ? ' is-success' : ' is-error'}`} key={result.id}>
                {result.message}
              </p>
            ))}
          </div>
        ) : null}

        <div className="session-picker-footer">
          <button
            className="btn btn-primary"
            disabled={!selectedOptions.length || isSending}
            onClick={() => void handleSend()}
            type="button"
          >
            {isSending ? 'Sending…' : `Send to selected (${selectedOptions.length})`}
          </button>
          <span>Clips stay local until you trigger a send from this sheet.</span>
        </div>
      </div>
    </div>
  );
}
