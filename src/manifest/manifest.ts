import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'LLM Clip',
  description: 'Current-tab capture and AI-first context packaging for Chrome.',
  version: '0.1.0',
  permissions: ['activeTab', 'scripting', 'storage', 'downloads', 'sidePanel', 'tabs', 'offscreen', 'clipboardWrite', 'debugger', 'alarms', 'identity'],
  host_permissions: [
    'http://127.0.0.1:4311/*',
    'http://localhost:4311/*',
    'https://slack.com/*',
    'https://*.slack.com/*',
    'https://*.atlassian.net/*',
    'https://discord.com/*',
    'https://discordapp.com/*',
    'https://api.linear.app/*',
    'https://linear.app/*',
    'https://graph.microsoft.com/*',
    'https://login.microsoftonline.com/*',
  ],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  action: {
    default_title: 'Open LLM Clip',
    default_popup: 'src/popup/index.html',
  },
  commands: {
    'start-region-clip': {
      suggested_key: {
        default: 'Alt+Shift+C',
        mac: 'Option+Shift+C',
      },
      description: 'Start clipping a selected region on the current tab.',
    },
    'start-visible-clip': {
      suggested_key: {
        default: 'Alt+Shift+T',
        mac: 'Option+Shift+T',
      },
      description: 'Clip the full visible current tab.',
    },
    'open-last-clip-editor': {
      suggested_key: {
        default: 'Alt+Shift+A',
        mac: 'Option+Shift+A',
      },
      description: 'Toggle the editor for the most recent clip.',
    },
    'open-side-panel': {
      suggested_key: {
        default: 'Alt+Shift+S',
        mac: 'Option+Shift+S',
      },
      description: 'Open the LLM Clip side panel.',
    },
  },
  background: {
    service_worker: 'src/service-worker/index.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'src/side-panel/index.html',
  },
});
