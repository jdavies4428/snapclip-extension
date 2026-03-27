import { formatClipContext } from '../context';
import type { ClipRecord } from '../../types/session';

type DiscordEmbedField = {
  name: string;
  value: string;
  inline?: boolean;
};

export type DiscordEmbed = {
  title: string;
  description: string;
  color: number;
  fields: DiscordEmbedField[];
  footer: {
    text: string;
  };
  timestamp: string;
  image: {
    url: string;
  };
};

function clamp(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1).trimEnd()}…`;
}

export function buildClipEmbed(clip: ClipRecord): DiscordEmbed {
  const context = formatClipContext(clip);
  const fields: DiscordEmbedField[] = [
    {
      name: 'Page',
      value: clamp(context.pageUrl, 1024),
    },
    {
      name: 'Viewport',
      value: context.viewport,
      inline: true,
    },
    {
      name: 'Mode',
      value: context.clipMode,
      inline: true,
    },
  ];

  if (context.consoleErrors.length) {
    fields.push({
      name: 'Console errors',
      value: clamp(context.consoleErrors.map((item) => `• ${item}`).join('\n'), 1024),
    });
  }

  if (context.networkFailures.length) {
    fields.push({
      name: 'Network failures',
      value: clamp(context.networkFailures.map((item) => `• ${item}`).join('\n'), 1024),
    });
  }

  return {
    title: clamp(context.title, 256),
    description: clamp(context.note || context.pageTitle, 2048),
    color: 0x15783d,
    fields,
    footer: {
      text: context.attribution,
    },
    timestamp: context.timestamp,
    image: {
      url: 'attachment://clip.png',
    },
  };
}
