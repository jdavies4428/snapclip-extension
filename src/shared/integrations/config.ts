import {
  integrationConfigSchemas,
  type IntegrationConfigMap,
  type IntegrationConnectionSummary,
  type IntegrationTarget,
} from './types';

const STORAGE_PREFIX = '__llmclip';

function getConfigStorageKey(target: IntegrationTarget): string {
  return `${STORAGE_PREFIX}_${target}_config`;
}

function getConfiguredAt(): string {
  return new Date().toISOString();
}

function buildEmptyConfig<Target extends IntegrationTarget>(
  target: Target,
): IntegrationConfigMap[Target] {
  return integrationConfigSchemas[target].parse({}) as IntegrationConfigMap[Target];
}

export async function getIntegrationConfig<Target extends IntegrationTarget>(
  target: Target,
): Promise<IntegrationConfigMap[Target]> {
  const storageKey = getConfigStorageKey(target);
  const result = await chrome.storage.local.get(storageKey);
  return integrationConfigSchemas[target].parse(result[storageKey] ?? {}) as IntegrationConfigMap[Target];
}

export async function setIntegrationConfig<Target extends IntegrationTarget>(
  target: Target,
  config: Partial<IntegrationConfigMap[Target]>,
): Promise<IntegrationConfigMap[Target]> {
  const storageKey = getConfigStorageKey(target);
  const current = await getIntegrationConfig(target);
  const next = integrationConfigSchemas[target].parse({
    ...current,
    ...config,
    configuredAt: getConfiguredAt(),
  }) as IntegrationConfigMap[Target];

  await chrome.storage.local.set({
    [storageKey]: next,
  });

  return next;
}

export async function clearIntegrationConfig(target: IntegrationTarget): Promise<void> {
  await chrome.storage.local.remove(getConfigStorageKey(target));
}

export async function getAllIntegrationConfigs(): Promise<IntegrationConfigMap> {
  const targets = Object.keys(integrationConfigSchemas) as IntegrationTarget[];
  const entries = await Promise.all(
    targets.map(async (target) => [target, await getIntegrationConfig(target)] as const),
  );
  return Object.fromEntries(entries) as IntegrationConfigMap;
}

function summarizeConfiguredTarget(
  target: IntegrationTarget,
  config: IntegrationConfigMap[IntegrationTarget],
): IntegrationConnectionSummary {
  switch (target) {
    case 'slack': {
      const slack = config as IntegrationConfigMap['slack'];
      return {
        target,
        configured: Boolean(slack.botToken && slack.channelId),
        label: 'Slack',
        detail: slack.channelName && slack.workspaceName
          ? `${slack.channelName} · ${slack.workspaceName}`
          : 'Not connected',
      };
    }
    case 'jira': {
      const jira = config as IntegrationConfigMap['jira'];
      return {
        target,
        configured: Boolean(jira.domain && jira.email && jira.apiToken && jira.defaultProjectKey),
        label: 'Jira',
        detail: jira.defaultProjectKey && jira.defaultIssueTypeName
          ? `${jira.defaultProjectKey} · ${jira.defaultIssueTypeName}`
          : 'Not connected',
      };
    }
    case 'discord': {
      const discord = config as IntegrationConfigMap['discord'];
      return {
        target,
        configured: Boolean(discord.enabled && discord.webhookUrl),
        label: 'Discord',
        detail: discord.channelName || 'Not connected',
      };
    }
    case 'linear': {
      const linear = config as IntegrationConfigMap['linear'];
      return {
        target,
        configured: Boolean(linear.apiKey && linear.teamId),
        label: 'Linear',
        detail: linear.teamName && linear.issueLabelName
          ? `${linear.teamName} · ${linear.issueLabelName}`
          : linear.teamName || 'Not connected',
      };
    }
    case 'teams': {
      const teams = config as IntegrationConfigMap['teams'];
      return {
        target,
        configured: Boolean(teams.clientId && teams.teamId && teams.channelId && teams.refreshToken),
        label: 'Teams',
        detail: teams.teamName && teams.channelName
          ? `${teams.teamName} · ${teams.channelName}`
          : 'Not connected',
      };
    }
    default:
      return {
        target,
        configured: false,
        label: target,
        detail: 'Not connected',
      };
  }
}

export async function getIntegrationConnectionSummaries(): Promise<IntegrationConnectionSummary[]> {
  const configs = await getAllIntegrationConfigs();
  return (Object.keys(configs) as IntegrationTarget[]).map((target) =>
    summarizeConfiguredTarget(target, configs[target]),
  );
}

export function getDefaultIntegrationConfig<Target extends IntegrationTarget>(
  target: Target,
): IntegrationConfigMap[Target] {
  return buildEmptyConfig(target);
}
