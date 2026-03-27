import { getIntegrationConfig } from '../config';
import { formatClipContext } from '../context';
import { buildAttachmentFilename, buildImageFormData } from '../utils';
import { buildAdfDocument } from './adf';
import type { ClipRecord } from '../../types/session';

const MAX_JIRA_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function getJiraBaseUrl(domain: string): string {
  const normalized = domain.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return `https://${normalized}`;
}

function createAuthHeader(email: string, apiToken: string): string {
  return `Basic ${btoa(`${email}:${apiToken}`)}`;
}

export async function createIssueWithScreenshot(params: {
  clip: ClipRecord;
  imageBlob: Blob;
}): Promise<{ externalUrl?: string }> {
  const config = await getIntegrationConfig('jira');
  if (!config.domain || !config.email || !config.apiToken || !config.defaultProjectKey) {
    throw new Error('Jira is not configured yet.');
  }

  if (params.imageBlob.size > MAX_JIRA_ATTACHMENT_BYTES) {
    throw new Error('Jira rejects screenshots larger than 10MB.');
  }

  const baseUrl = getJiraBaseUrl(config.domain);
  const context = formatClipContext(params.clip);
  const authHeader = createAuthHeader(config.email, config.apiToken);
  const issueResponse = await fetch(`${baseUrl}/rest/api/3/issue`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        project: {
          key: config.defaultProjectKey,
        },
        summary: context.title,
        issuetype: config.defaultIssueTypeId
          ? { id: config.defaultIssueTypeId }
          : { name: config.defaultIssueTypeName || 'Bug' },
        description: buildAdfDocument(context),
      },
    }),
  });

  const issuePayload = (await issueResponse.json().catch(() => ({}))) as {
    key?: string;
    errors?: Record<string, string>;
    errorMessages?: string[];
  };
  if (!issueResponse.ok || !issuePayload.key) {
    const firstError = issuePayload.errorMessages?.[0] || Object.values(issuePayload.errors ?? {})[0];
    throw new Error(firstError || 'Jira rejected the issue create request.');
  }

  const filename = buildAttachmentFilename(params.clip.id);
  const attachmentResponse = await fetch(`${baseUrl}/rest/api/3/issue/${issuePayload.key}/attachments`, {
    method: 'POST',
    headers: {
      Authorization: authHeader,
      Accept: 'application/json',
      'X-Atlassian-Token': 'no-check',
    },
    body: buildImageFormData('file', params.imageBlob, filename),
  });

  if (!attachmentResponse.ok) {
    throw new Error('The Jira issue was created, but the screenshot upload failed.');
  }

  return {
    externalUrl: `${baseUrl}/browse/${issuePayload.key}`,
  };
}
