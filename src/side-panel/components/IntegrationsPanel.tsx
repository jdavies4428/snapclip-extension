import { useState } from 'react';
import type { FormEvent } from 'react';
import { useIntegrationConfigs } from '../state/useIntegrationConfigs';
import type {
  IntegrationConfigMap,
  IntegrationConnectionSummary,
  IntegrationTarget,
} from '../../shared/integrations/types';
import { launchTeamsAuth } from '../../shared/integrations/teams/auth';

const TARGET_ORDER: IntegrationTarget[] = [
  'slack',
  'jira',
  'discord',
  'linear',
  'teams',
];

const TARGET_SYMBOL: Record<IntegrationTarget, string> = {
  slack: '#',
  jira: '◆',
  discord: '◇',
  linear: '◈',
  teams: '▦',
};

function getSummary(
  summaries: IntegrationConnectionSummary[],
  target: IntegrationTarget,
): IntegrationConnectionSummary {
  return summaries.find((item) => item.target === target) ?? {
    target,
    configured: false,
    label: target,
    detail: 'Not connected',
  };
}

function readValue(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

function renderFields(
  target: IntegrationTarget,
  config: IntegrationConfigMap[IntegrationTarget],
) {
  switch (target) {
    case 'slack': {
      const slack = config as IntegrationConfigMap['slack'];
      return (
        <>
          <label className="integration-field">
            <span>Bot token</span>
            <input defaultValue={slack.botToken} name="botToken" placeholder="xoxb-..." type="password" />
          </label>
          <label className="integration-field">
            <span>Channel ID</span>
            <input defaultValue={slack.channelId} name="channelId" placeholder="C0123456789" type="text" />
          </label>
          <label className="integration-field">
            <span>Channel name</span>
            <input defaultValue={slack.channelName} name="channelName" placeholder="#bugs" type="text" />
          </label>
          <label className="integration-field">
            <span>Workspace</span>
            <input defaultValue={slack.workspaceName} name="workspaceName" placeholder="Acme Corp" type="text" />
          </label>
        </>
      );
    }
    case 'jira': {
      const jira = config as IntegrationConfigMap['jira'];
      return (
        <>
          <label className="integration-field">
            <span>Domain</span>
            <input defaultValue={jira.domain} name="domain" placeholder="acme.atlassian.net" type="text" />
          </label>
          <label className="integration-field">
            <span>Email</span>
            <input defaultValue={jira.email} name="email" placeholder="you@acme.com" type="email" />
          </label>
          <label className="integration-field">
            <span>API token</span>
            <input defaultValue={jira.apiToken} name="apiToken" placeholder="Atlassian API token" type="password" />
          </label>
          <label className="integration-field">
            <span>Project key</span>
            <input defaultValue={jira.defaultProjectKey} name="defaultProjectKey" placeholder="PROJ" type="text" />
          </label>
          <label className="integration-field">
            <span>Issue type ID</span>
            <input defaultValue={jira.defaultIssueTypeId} name="defaultIssueTypeId" placeholder="10004" type="text" />
          </label>
          <label className="integration-field">
            <span>Issue type name</span>
            <input defaultValue={jira.defaultIssueTypeName} name="defaultIssueTypeName" placeholder="Bug" type="text" />
          </label>
        </>
      );
    }
    case 'discord': {
      const discord = config as IntegrationConfigMap['discord'];
      return (
        <>
          <label className="integration-field integration-field--full">
            <span>Webhook URL</span>
            <input defaultValue={discord.webhookUrl} name="webhookUrl" placeholder="https://discord.com/api/webhooks/..." type="password" />
          </label>
          <label className="integration-field">
            <span>Channel label</span>
            <input defaultValue={discord.channelName} name="channelName" placeholder="#dev-bugs" type="text" />
          </label>
          <label className="integration-checkbox">
            <input defaultChecked={discord.enabled} name="enabled" type="checkbox" />
            <span>Enable Discord delivery</span>
          </label>
        </>
      );
    }
    case 'linear': {
      const linear = config as IntegrationConfigMap['linear'];
      return (
        <>
          <label className="integration-field">
            <span>API key</span>
            <input defaultValue={linear.apiKey} name="apiKey" placeholder="lin_api_..." type="password" />
          </label>
          <label className="integration-field">
            <span>Team ID</span>
            <input defaultValue={linear.teamId} name="teamId" placeholder="team id" type="text" />
          </label>
          <label className="integration-field">
            <span>Team name</span>
            <input defaultValue={linear.teamName} name="teamName" placeholder="Mobile" type="text" />
          </label>
          <label className="integration-field">
            <span>Label ID</span>
            <input defaultValue={linear.issueLabelId} name="issueLabelId" placeholder="optional" type="text" />
          </label>
          <label className="integration-field">
            <span>Label name</span>
            <input defaultValue={linear.issueLabelName} name="issueLabelName" placeholder="Bug" type="text" />
          </label>
        </>
      );
    }
    case 'teams': {
      const teams = config as IntegrationConfigMap['teams'];
      return (
        <>
          <label className="integration-field">
            <span>Client ID</span>
            <input defaultValue={teams.clientId} name="clientId" placeholder="Azure app client id" type="text" />
          </label>
          <label className="integration-field">
            <span>Tenant</span>
            <input defaultValue={teams.tenantId} name="tenantId" placeholder="common" type="text" />
          </label>
          <label className="integration-field">
            <span>Team ID</span>
            <input defaultValue={teams.teamId} name="teamId" placeholder="team id" type="text" />
          </label>
          <label className="integration-field">
            <span>Team name</span>
            <input defaultValue={teams.teamName} name="teamName" placeholder="Frontend" type="text" />
          </label>
          <label className="integration-field">
            <span>Channel ID</span>
            <input defaultValue={teams.channelId} name="channelId" placeholder="channel id" type="text" />
          </label>
          <label className="integration-field">
            <span>Channel name</span>
            <input defaultValue={teams.channelName} name="channelName" placeholder="Bugs" type="text" />
          </label>
        </>
      );
    }
    default:
      return null;
  }
}

function buildPayload(
  target: IntegrationTarget,
  formData: FormData,
): Partial<IntegrationConfigMap[IntegrationTarget]> {
  switch (target) {
    case 'slack':
      return {
        botToken: readValue(formData, 'botToken'),
        channelId: readValue(formData, 'channelId'),
        channelName: readValue(formData, 'channelName'),
        workspaceName: readValue(formData, 'workspaceName'),
      } satisfies Partial<IntegrationConfigMap['slack']>;
    case 'jira':
      return {
        domain: readValue(formData, 'domain'),
        email: readValue(formData, 'email'),
        apiToken: readValue(formData, 'apiToken'),
        defaultProjectKey: readValue(formData, 'defaultProjectKey'),
        defaultIssueTypeId: readValue(formData, 'defaultIssueTypeId'),
        defaultIssueTypeName: readValue(formData, 'defaultIssueTypeName'),
      } satisfies Partial<IntegrationConfigMap['jira']>;
    case 'discord':
      return {
        webhookUrl: readValue(formData, 'webhookUrl'),
        channelName: readValue(formData, 'channelName'),
        enabled: formData.get('enabled') === 'on',
      } satisfies Partial<IntegrationConfigMap['discord']>;
    case 'linear':
      return {
        apiKey: readValue(formData, 'apiKey'),
        teamId: readValue(formData, 'teamId'),
        teamName: readValue(formData, 'teamName'),
        issueLabelId: readValue(formData, 'issueLabelId'),
        issueLabelName: readValue(formData, 'issueLabelName'),
      } satisfies Partial<IntegrationConfigMap['linear']>;
    case 'teams':
      return {
        clientId: readValue(formData, 'clientId'),
        tenantId: readValue(formData, 'tenantId') || 'common',
        teamId: readValue(formData, 'teamId'),
        teamName: readValue(formData, 'teamName'),
        channelId: readValue(formData, 'channelId'),
        channelName: readValue(formData, 'channelName'),
      } satisfies Partial<IntegrationConfigMap['teams']>;
    default:
      return {};
  }
}

export function IntegrationsPanel({
  onStatus,
}: {
  onStatus: (message: string) => void;
}) {
  const [expandedTarget, setExpandedTarget] = useState<IntegrationTarget | null>('slack');
  const integrations = useIntegrationConfigs(true);

  async function handleSubmit(event: FormEvent<HTMLFormElement>, target: IntegrationTarget) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    try {
      await integrations.saveTargetConfig(
        target,
        buildPayload(target, formData) as Partial<IntegrationConfigMap[typeof target]>,
      );
      onStatus(`${getSummary(integrations.summaries, target).label} settings saved.`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : 'The integration settings could not be saved.');
    }
  }

  async function handleReset(target: IntegrationTarget) {
    try {
      await integrations.clearTargetConfig(target);
      onStatus(`${getSummary(integrations.summaries, target).label} settings cleared.`);
    } catch (error) {
      onStatus(error instanceof Error ? error.message : 'The integration settings could not be cleared.');
    }
  }

  async function handleTeamsConnect() {
    try {
      await launchTeamsAuth();
      await integrations.refresh();
      onStatus('Teams connected.');
    } catch (error) {
      onStatus(error instanceof Error ? error.message : 'Teams sign-in failed.');
    }
  }

  return (
    <div className="integrations-panel">
      <div className="section-header">
        <span className="section-title">Integrations</span>
        <button
          className="btn btn-ghost"
          disabled={integrations.isLoading || integrations.isSaving}
          onClick={() => void integrations.refresh()}
          type="button"
        >
          Refresh
        </button>
      </div>

      <div className="integration-intro">
        <p className="integration-intro-title">Connect destinations once, then share from any clip.</p>
        <p className="integration-intro-copy">
          Slack, Jira, Discord, Linear, and Teams stay local in extension storage until you explicitly send.
        </p>
      </div>

      {integrations.error ? (
        <div className="integration-error">
          <p>{integrations.error}</p>
        </div>
      ) : null}

      <div className="integration-card-list">
        {TARGET_ORDER.map((target) => {
          const summary = getSummary(integrations.summaries, target);
          const config = integrations.configs?.[target];
          const isExpanded = expandedTarget === target;

          if (!config) {
            return null;
          }

          return (
            <section
              className={`integration-card${isExpanded ? ' is-expanded' : ''}`}
              data-configured={summary.configured}
              key={target}
            >
              <button
                aria-expanded={isExpanded}
                className="integration-card-header"
                onClick={() => setExpandedTarget(isExpanded ? null : target)}
                type="button"
              >
                <div className="integration-card-heading">
                  <span aria-hidden="true" className="integration-card-symbol">{TARGET_SYMBOL[target]}</span>
                  <div>
                    <div className="integration-card-title-row">
                      <span className="integration-card-title">{summary.label}</span>
                      <span className={`integration-card-status${summary.configured ? ' is-configured' : ''}`}>
                        {summary.configured ? 'Connected' : 'Setup'}
                      </span>
                    </div>
                    <p className="integration-card-detail">{summary.detail}</p>
                  </div>
                </div>
                <span aria-hidden="true" className="integration-card-chevron">
                  {isExpanded ? '−' : '+'}
                </span>
              </button>

              {isExpanded ? (
                <form className="integration-form" onSubmit={(event) => void handleSubmit(event, target)}>
                  <div className="integration-field-grid">
                    {renderFields(target, config)}
                  </div>
                  <div className="integration-form-footer">
                    <p className="integration-form-copy">
                      Connection details stay inside this browser profile until you clear them.
                    </p>
                    <div className="integration-form-actions">
                      {target === 'teams' ? (
                        <button
                          className="btn btn-secondary"
                          disabled={integrations.isSaving}
                          onClick={() => void handleTeamsConnect()}
                          type="button"
                        >
                          Connect Teams
                        </button>
                      ) : null}
                      <button
                        className="btn btn-ghost"
                        disabled={integrations.isSaving}
                        onClick={() => void handleReset(target)}
                        type="button"
                      >
                        Clear
                      </button>
                      <button
                        className="btn btn-primary"
                        disabled={integrations.isSaving}
                        type="submit"
                      >
                        {integrations.isSaving ? 'Saving…' : 'Save connection'}
                      </button>
                    </div>
                  </div>
                </form>
              ) : null}
            </section>
          );
        })}
      </div>
    </div>
  );
}
