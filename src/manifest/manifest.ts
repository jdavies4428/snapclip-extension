import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'LLM Clip',
  description: 'Current-tab capture and AI-first context packaging for Chrome.',
  version: '0.1.0',
  permissions: ['activeTab', 'scripting', 'storage', 'downloads', 'sidePanel', 'tabs', 'offscreen', 'clipboardWrite'],
  host_permissions: ['http://127.0.0.1:4311/*', 'http://localhost:4311/*'],
  optional_host_permissions: ['http://*/*', 'https://*/*'],
  action: {
    default_title: 'Open LLM Clip',
    default_popup: 'src/popup/index.html',
  },
  commands: {
    'start-region-clip': {
      suggested_key: {
        default: 'Alt+Shift+S',
        mac: 'Option+Shift+S',
      },
      description: 'Start clipping a selected region on the current tab.',
    },
    'start-visible-clip': {
      suggested_key: {
        default: 'Alt+Shift+D',
        mac: 'Option+Shift+D',
      },
      description: 'Clip the full visible current tab.',
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
