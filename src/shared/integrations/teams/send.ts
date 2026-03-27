import { getIntegrationConfig } from '../config';
import { formatClipContext } from '../context';
import { getValidAccessToken } from './auth';
import type { ClipRecord } from '../../types/session';

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const [, payload = ''] = result.split(',', 2);
      resolve(payload);
    };
    reader.onerror = () => reject(reader.error ?? new Error('Failed to encode the Teams screenshot.'));
    reader.readAsDataURL(blob);
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function postTeamsMessage(params: {
  clip: ClipRecord;
  imageBlob: Blob;
}): Promise<{ externalUrl?: string }> {
  const config = await getIntegrationConfig('teams');
  if (!config.teamId || !config.channelId) {
    throw new Error('Teams is not configured yet.');
  }

  const accessToken = await getValidAccessToken();
  const context = formatClipContext(params.clip);
  const imageBase64 = await blobToBase64(params.imageBlob);
  const content = [
    `<p><strong>${escapeHtml(context.title)}</strong></p>`,
    `<p>${escapeHtml(context.note || context.pageTitle)}</p>`,
    `<p>${escapeHtml(context.pageUrl)}</p>`,
    `<p>${escapeHtml(`${context.clipMode} · ${context.viewport}`)}</p>`,
    `<p><img src="../hostedContents/1/$value" alt="${escapeHtml(context.title)}" /></p>`,
    `<p>${escapeHtml(context.attribution)}</p>`,
  ].join('');
  const response = await fetch(`https://graph.microsoft.com/v1.0/teams/${encodeURIComponent(config.teamId)}/channels/${encodeURIComponent(config.channelId)}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      body: {
        contentType: 'html',
        content,
      },
      hostedContents: [
        {
          '@microsoft.graph.temporaryId': '1',
          contentBytes: imageBase64,
          contentType: params.imageBlob.type || 'image/png',
        },
      ],
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: {
      message?: string;
    };
  };

  if (!response.ok) {
    throw new Error(payload.error?.message || 'Teams rejected the message send.');
  }

  return {};
}
