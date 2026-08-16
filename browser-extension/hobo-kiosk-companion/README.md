# Hobo Kiosk Companion (Firefox)

A tiny Firefox extension that gives the HoboStreamer **`/kiosk#input`** address bar
access to your Firefox **history** so it can autocomplete like a real browser bar.
It can also set the kiosk as your **new-tab page**.

## What it does

- Injects a content script only on `hobostreamer.com/kiosk` that bridges the page to a
  background script which queries `browser.history` and returns your top matches
  (ranked by visit count + recency). History never leaves your browser.
- Overrides the new-tab page to open `https://hobostreamer.com/kiosk#input`.
  (Don't want that? Delete the `chrome_url_overrides` block from `manifest.json`.)

The kiosk page detects the companion automatically — no configuration. Without the
extension the omnibar still works, it just falls back to its own on-page history.

## Permissions

- `history` — to read your browsing history for autocomplete.
- Runs its content script only on `*://hobostreamer.com/kiosk*`.

## Install — quick test (temporary, gone on restart)

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick this folder's `manifest.json`.
3. Open a new tab (or visit `hobostreamer.com/kiosk#input`) and start typing —
   history suggestions appear.

## Install — permanent

Firefox only runs signed extensions permanently. Sign it (free) with Mozilla:

```bash
npm install --global web-ext
cd browser-extension/hobo-kiosk-companion
# Get API credentials at https://addons.mozilla.org/developers/addon/api/key/
web-ext sign --api-key=YOUR_JWT_ISSUER --api-secret=YOUR_JWT_SECRET --channel=unlisted
```

This produces a signed `.xpi` in `web-ext-artifacts/`. Install it via
`about:addons` → gear icon → **Install Add-on From File…**.

(Alternatively, Firefox Developer Edition / ESR / Nightly can run unsigned
extensions by setting `xpinstall.signatures.required = false` in `about:config`.)

## Files

- `manifest.json` — MV3 manifest (Firefox).
- `background.js` — queries `browser.history`, ranks results.
- `history-bridge.js` — content script that relays page ⇄ background.
- `newtab.html` / `newtab.js` — new-tab override → kiosk.
