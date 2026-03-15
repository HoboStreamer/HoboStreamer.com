# Codex Memory

## Current Goal
- Implement the HoboStreamer staff/auth fixes and the new collaborative canvas game.

## Completed Backend Work
- Auth responses now return `user` plus `capabilities`.
- Added `server/auth/permissions.js` and updated auth middleware for `requireGlobalMod` / `requireStaff`.
- Added channel moderation tables and helpers in `server/db/database.js`.
- Added staff routes:
  - `server/admin/mod-routes.js`
  - `server/admin/channel-mod-routes.js`
- Split admin-only actions from moderation actions.
- Tightened chat moderation behavior and wired moderation action logging.
- Added canvas backend:
  - `server/game/canvas-service.js`
  - `server/game/canvas-server.js`
  - `server/game/canvas-routes.js`
- Mounted canvas and staff routes in `server/index.js`.

## Completed Frontend Work
- `public/js/app.js`
  - Preserves auth capabilities after login/register/refresh.
  - Shows staff nav based on capabilities.
  - Routes `/game` to the new canvas page and `/game/adventure` to the original game.
- `public/js/canvas.js`
  - Dynamically converts the game page into a `Canvas` / `Adventure` hub.
  - Implements the collaborative board UI, websocket sync, palette, pan/zoom, keyboard cursor, cooldown display, activity feed, and presence.
- `public/index.html`
  - Staff heading renamed from `Admin Panel` to `Staff Console`.
  - Added script tags for `dashboard-moderation.js`, `staff-console.js`, and `canvas.js`.

## Still Missing
- `public/js/staff-console.js`
  - Must replace the old admin-only frontend with a role-aware staff console.
- `public/js/dashboard-moderation.js`
  - Must expose channel-owner / channel-mod tools in the dashboard.
- Styling for the new game hub / canvas / staff tools.
- Frontend chat moderation cleanup in `public/js/chat.js`.
- Runtime smoke test after frontend pieces are in place.

## Important Notes
- `public/index.html` already references `dashboard-moderation.js` and `staff-console.js`, so those files need to exist before testing.
- The canvas API is mounted before the old `/api/game` routes so anonymous board viewing works.
- Existing DBs may still store global moderators as `role = 'mod'`; permission helpers intentionally treat both `mod` and `global_mod` as the same capability.

## Next Steps
1. Create `public/js/staff-console.js`.
2. Create `public/js/dashboard-moderation.js`.
3. Add CSS for the new canvas/game hub and staff moderation UI.
4. Patch `public/js/chat.js` for staff-aware moderation controls.
5. Run a smoke test with `npm start`.
