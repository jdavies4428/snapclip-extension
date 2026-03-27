import { getIntegrationConfig } from '../config';
import { formatClipContext } from '../context';
import { buildAttachmentFilename } from '../utils';
import { buildClipEmbed } from './embed';
import type { ClipRecord } from '../../types/session';

const MAX_DISCORD_FILE_BYTES = 25 * 1024 * 1024;
const WEBHOOK_PATTERN = /^https:\/\/(?:canary\.)?discord(?:app)?\.com\/api\/webhooks\/[^/\s]+\/[^/\s]+/i;

export function isValidWebhookUrl(value: string): boolean {
  return WEBHOOK_PATTERN.test(value.trim());
}

function toDiscordErrorMessage(status: number): string {
  if (status === 404) {
    return 'The Discord webhook was not found. Re-enter the webhook URL.';
  }

  if (status === 401 || status === 403) {
    return 'Discord rejected the webhook. Check that the webhook still has access.';
  }

  return 'The Discord send failed.';
}

export async function sendClipToDiscord(params: {
  clip: ClipRecord;
  imageBlob: Blob;
}): Promise<{ externalUrl?: string }> {
  const config = await getIntegrationConfig('discord');
  if (!config.enabled || !config.webhookUrl || !isValidWebhookUrl(config.webhookUrl)) {
    throw new Error('Discord is not configured yet.');
  }

  if (params.imageBlob.size > MAX_DISCORD_FILE_BYTES) {
    throw new Error('Discord rejects files larger than 25MB.');
  }

  const context = formatClipContext(params.clip);
  const filename = buildAttachmentFilename(params.clip.id);
  const formData = new FormData();
  formData.append(
    'payload_json',
    JSON.stringify({
      content: context.note ? context.note : `Bug report from ${context.pageTitle}`,
      embeds: [buildClipEmbed(params.clip)],
      allowed_mentions: {
        parse: [],
      },
      attachments: [
        {
          id: 0,
          filename: 'clip.png',
          description: context.title,
        },
      ],
    }),
  );
  formData.append('files[0]', params.imageBlob, filename);

  const execute = async () => {
    const response = await fetch(`${config.webhookUrl}?wait=true`, {
      method: 'POST',
      body: formData,
    });

    if (response.status === 429) {
      const payload = (await response.json().catch(() => ({}))) as { retry_after?: number };
      const retryAfterMs = Math.ceil((payload.retry_after ?? 1) * 1000);
      await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
      return fetch(`${config.webhookUrl}?wait=true`, {
        method: 'POST',
        body: formData,
      });
    }

    return response;
  };

  const response = await execute();
  if (!response.ok) {
    throw new Error(toDiscordErrorMessage(response.status));
  }

  return {};
}
