import { z } from 'zod';

export const integrationTargetSchema = z.enum([
  'slack',
  'jira',
  'discord',
  'linear',
  'teams',
]);

export type IntegrationTarget = z.infer<typeof integrationTargetSchema>;

export const integrationDeliveryStatusSchema = z.enum([
  'pending',
  'sending',
  'sent',
  'failed',
]);

export type IntegrationDeliveryStatus = z.infer<typeof integrationDeliveryStatusSchema>;

export const slackConfigSchema = z.object({
  botToken: z.string().trim().default(''),
  channelId: z.string().trim().default(''),
  channelName: z.string().trim().default(''),
  workspaceName: z.string().trim().default(''),
  configuredAt: z.string().trim().default(''),
});

export type SlackConfig = z.infer<typeof slackConfigSchema>;

export const jiraConfigSchema = z.object({
  domain: z.string().trim().default(''),
  email: z.string().trim().default(''),
  apiToken: z.string().trim().default(''),
  defaultProjectKey: z.string().trim().default(''),
  defaultIssueTypeId: z.string().trim().default(''),
  defaultIssueTypeName: z.string().trim().default(''),
  configuredAt: z.string().trim().default(''),
});

export type JiraConfig = z.infer<typeof jiraConfigSchema>;

export const discordConfigSchema = z.object({
  webhookUrl: z.string().trim().default(''),
  channelName: z.string().trim().default(''),
  enabled: z.boolean().default(false),
  lastVerifiedAt: z.string().trim().default(''),
  configuredAt: z.string().trim().default(''),
});

export type DiscordConfig = z.infer<typeof discordConfigSchema>;

export const linearConfigSchema = z.object({
  apiKey: z.string().trim().default(''),
  teamId: z.string().trim().default(''),
  teamName: z.string().trim().default(''),
  issueLabelId: z.string().trim().default(''),
  issueLabelName: z.string().trim().default(''),
  configuredAt: z.string().trim().default(''),
});

export type LinearConfig = z.infer<typeof linearConfigSchema>;

export const teamsConfigSchema = z.object({
  clientId: z.string().trim().default(''),
  tenantId: z.string().trim().default('common'),
  accessToken: z.string().trim().default(''),
  refreshToken: z.string().trim().default(''),
  expiresAt: z.string().trim().default(''),
  teamId: z.string().trim().default(''),
  teamName: z.string().trim().default(''),
  channelId: z.string().trim().default(''),
  channelName: z.string().trim().default(''),
  configuredAt: z.string().trim().default(''),
});

export type TeamsConfig = z.infer<typeof teamsConfigSchema>;

export type IntegrationConfigMap = {
  slack: SlackConfig;
  jira: JiraConfig;
  discord: DiscordConfig;
  linear: LinearConfig;
  teams: TeamsConfig;
};

export const integrationConfigSchemas = {
  slack: slackConfigSchema,
  jira: jiraConfigSchema,
  discord: discordConfigSchema,
  linear: linearConfigSchema,
  teams: teamsConfigSchema,
} as const;

export type IntegrationDeliveryRecord = {
  clipId: string;
  target: IntegrationTarget;
  status: IntegrationDeliveryStatus;
  externalUrl?: string;
  error?: string;
  sentAt?: string;
};

export const integrationDeliveryRecordSchema = z.object({
  clipId: z.string(),
  target: integrationTargetSchema,
  status: integrationDeliveryStatusSchema,
  externalUrl: z.string().optional(),
  error: z.string().optional(),
  sentAt: z.string().optional(),
});

export type IntegrationConnectionSummary = {
  target: IntegrationTarget;
  configured: boolean;
  label: string;
  detail: string;
};
