# Permissions

## Current permissions

The current build uses:

- `activeTab`
- `scripting`
- `storage`
- `downloads`
- `sidePanel`
- `tabs`

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

## Bridge host permissions

LLM Clip uses the localhost bridge for workspace discovery, Claude session discovery, bundle writing, and Claude delivery. Those host permissions are intentionally narrow to the local bridge port instead of broad network access.

## Optional host permissions

The side panel can request access to the current site when the user wants to launch capture from the panel itself. Popup and keyboard-shortcut flows still use `activeTab` as the lower-friction fast path.

## Deferred permissions

Not requested in this milestone:

- `debugger`

Deep debugger capture remains deferred behind an explicit product decision because Chrome requires the `debugger` permission to be declared in the manifest up front.
