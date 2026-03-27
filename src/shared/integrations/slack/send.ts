import { getIntegrationConfig } from '../config';
import { formatClipContext } from '../context';
import { buildAttachmentFilename } from '../utils';
import type { ClipRecord } from '../../types/session';

type SlackUploadUrlResponse = {
  ok?: boolean;
  upload_url?: string;
  file_id?: string;
  error?: string;
};

type SlackCompleteUploadResponse = {
  ok?: boolean;
  error?: string;
  files?: Array<{
    permalink?: string;
  }>;
};

function createSlackHeaders(token: string, contentType = 'application/json') {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': contentType,
  };
}

function buildInitialComment(clip: ClipRecord): string {
  const context = formatClipContext(clip);
  const lines = [
    `*${context.title}*`,
    context.note || context.pageTitle,
    '',
    `Page: ${context.pageUrl}`,
    `Capture: ${context.clipMode} · ${context.viewport}`,
  ];

  if (context.consoleErrors.length) {
    lines.push('', 'Console errors:');
    lines.push(...context.consoleErrors.map((item) => `• ${item}`));
  }

  if (context.networkFailures.length) {
    lines.push('', 'Network failures:');
    lines.push(...context.networkFailures.map((item) => `• ${item}`));
  }

  lines.push('', context.attribution);
  return lines.join('\n');
}

async function requestUploadUrl(token: string, filename: string, length: number): Promise<SlackUploadUrlResponse> {
  const response = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: createSlackHeaders(token),
    body: JSON.stringify({
      filename,
      length,
    }),
  });

  return response.json();
}

async function completeUpload(params: {
  token: string;
  fileId: string;
  title: string;
  channelId: string;
  initialComment: string;
}): Promise<SlackCompleteUploadResponse> {
  const response = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: createSlackHeaders(params.token),
    body: JSON.stringify({
      files: [
        {
          id: params.fileId,
          title: params.title,
        },
      ],
      channel_id: params.channelId,
      initial_comment: params.initialComment,
    }),
  });

  return response.json();
}

export async function sendClipToSlack(params: {
  clip: ClipRecord;
  imageBlob: Blob;
}): Promise<{ externalUrl?: string }> {
  const config = await getIntegrationConfig('slack');
  if (!config.botToken || !config.channelId) {
    throw new Error('Slack is not configured yet.');
  }

  chrome.alarms.create('integration-keepalive', { delayInMinutes: 0.4 });

  try {
    const filename = buildAttachmentFilename(params.clip.id);
    const uploadUrl = await requestUploadUrl(config.botToken, filename, params.imageBlob.size);

    if (!uploadUrl.ok || !uploadUrl.upload_url || !uploadUrl.file_id) {
      throw new Error(uploadUrl.error || 'Slack did not return an upload URL.');
    }

    const uploadResponse = await fetch(uploadUrl.upload_url, {
      method: 'PUT',
      headers: {
        'Content-Type': params.imageBlob.type || 'image/png',
      },
      body: params.imageBlob,
    });

    if (!uploadResponse.ok) {
      throw new Error('Slack rejected the uploaded screenshot bytes.');
    }

    let completion = await completeUpload({
      token: config.botToken,
      fileId: uploadUrl.file_id,
      title: params.clip.title || 'LLM Clip screenshot',
      channelId: config.channelId,
      initialComment: buildInitialComment(params.clip),
    });

    if (!completion.ok) {
      completion = await completeUpload({
        token: config.botToken,
        fileId: uploadUrl.file_id,
        title: params.clip.title || 'LLM Clip screenshot',
        channelId: config.channelId,
        initialComment: buildInitialComment(params.clip),
      });
    }

    if (!completion.ok) {
      throw new Error(completion.error || 'Slack did not complete the upload.');
    }

    return {
      externalUrl: completion.files?.[0]?.permalink,
    };
  } finally {
    chrome.alarms.clear('integration-keepalive').catch(() => undefined);
  }
}
