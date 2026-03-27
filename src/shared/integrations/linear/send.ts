import { getIntegrationConfig } from '../config';
import { formatClipContext } from '../context';
import { buildMarkdownBody } from './markdown';
import type { ClipRecord } from '../../types/session';

type LinearGraphqlResponse<T> = {
  data?: T;
  errors?: Array<{
    message?: string;
  }>;
};

const ISSUE_CREATE_MUTATION = `
  mutation IssueCreate($input: IssueCreateInput!) {
    issueCreate(input: $input) {
      success
      issue {
        id
        identifier
        url
      }
    }
  }
`;

export async function createIssueWithComment(params: {
  clip: ClipRecord;
  imageDataUrl: string;
}): Promise<{ externalUrl?: string }> {
  const config = await getIntegrationConfig('linear');
  if (!config.apiKey || !config.teamId) {
    throw new Error('Linear is not configured yet.');
  }

  const context = formatClipContext(params.clip);
  const response = await fetch('https://api.linear.app/graphql', {
    method: 'POST',
    headers: {
      Authorization: config.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: ISSUE_CREATE_MUTATION,
      variables: {
        input: {
          title: context.title,
          description: buildMarkdownBody(context, params.imageDataUrl),
          teamId: config.teamId,
          ...(config.issueLabelId ? { labelIds: [config.issueLabelId] } : {}),
        },
      },
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as LinearGraphqlResponse<{
    issueCreate?: {
      success?: boolean;
      issue?: {
        id?: string;
        identifier?: string;
        url?: string;
      };
    };
  }>;

  const issue = payload.data?.issueCreate?.issue;
  if (!response.ok || !payload.data?.issueCreate?.success || !issue?.url) {
    throw new Error(payload.errors?.[0]?.message || 'Linear rejected the issue create request.');
  }

  return {
    externalUrl: issue.url,
  };
}
