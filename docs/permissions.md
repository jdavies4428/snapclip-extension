# Permissions

## Current permissions

The current build uses:

- `activeTab`
- `scripting`
- `storage`
- `downloads`
- `sidePanel`
- `tabs`
- `offscreen`
- `clipboardWrite`
- `debugger`

The manifest also declares fixed bridge host permissions for:

- `http://127.0.0.1:4311/*`
- `http://localhost:4311/*`

The manifest also declares optional host permissions for:

- `http://*/*`
- `https://*/*`

## Why each permission exists

### `activeTab`

Lets LLM Clip access the currently active page only after a direct user gesture, such as clicking the popup action. This avoids requesting broad host permissions up front.

### `scripting`

Lets the service worker inject the page-context extractor into the active tab at runtime.

### `storage`

Lets the extension persist the latest snapshot so the side panel can render it.

### `downloads`

Used for current image, JSON, and Markdown snapshot exports.

### `sidePanel`

Lets the extension register and open the side panel workspace.

### `tabs`

Lets the extension read active-tab metadata such as URL/title so the side panel can request access to the current site instead of asking for blanket web access.

### `offscreen`

Lets the extension create an offscreen document for clipboard writes that need richer MIME types than the side panel can safely handle alone.

### `clipboardWrite`

Lets the extension copy text, images, and combined packet payloads for external paste flows.

### `debugger`

Lets LLM Clip request a bounded Chrome debugger snapshot for extra local diagnostics when Chrome allows it. This is declared up front because Chrome does not offer it as an optional runtime permission.

## Bridge host permissions

LLM Clip uses the localhost bridge for workspace discovery, Claude session discovery, bundle writing, and Claude delivery. Those host permissions are intentionally narrow to the local bridge port instead of broad network access.

## Optional host permissions

The side panel can request access to the current site when the user wants to launch capture from the panel itself. Popup and keyboard-shortcut flows still use `activeTab` as the lower-friction fast path.

## Permission clarity

Current-site capture from the side panel still uses optional host access as the explicit approval step. The Chrome debugger capability is different: it is a declared extension permission, so there is no extra per-clip browser prompt when LLM Clip attempts the bounded debugger snapshot.
