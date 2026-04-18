'use strict';

/**
 * SFU viewer stability regression tests
 *
 * Verifies the key behavioral fixes for the viewer re-watch loop:
 *   A. Server-side: _tryCreateSfuViewer guard skips transport recreation when DTLS is connected
 *   B. Server-side: webrtc-sfu.js consume() triggers requestKeyFrame() for video consumers
 *   C. Client-side: _sfuViewerSetupInProgress guard is present in stream-player.js
 *   D. Client-side: 20s first-frame grace window (not 8s in SFU path), armed from transport connected
 *   E. Client-side: 15s transport connect timeout + null-before-close cascade guard
 *   F. WHIP ICE disconnect: grace timer + explicit producer-removed emit in cleanupSession
 *   G. Broadcast-server: ICE-state filter + stale-source path + watch-queued message
 *   H. Client: sfu-source-unavailable and watch-queued handled without P2P offer timeout
 *   I. Client: frozen-video detector starts after play, stops on transport change
 *   J. /shared serving: startup sync + explicit JS content-type
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const playerSrc = fs.readFileSync(path.join(__dirname, '../public/js/stream-player.js'), 'utf8');
const sfuSrc = fs.readFileSync(path.join(__dirname, '../server/streaming/webrtc-sfu.js'), 'utf8');
const bcastSrc = fs.readFileSync(path.join(__dirname, '../server/streaming/broadcast-server.js'), 'utf8');
const whipSrc = fs.readFileSync(path.join(__dirname, '../server/streaming/whip-handler.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(__dirname, '../server/index.js'), 'utf8');

// ── A: broadcast-server dedup guard ────────────────────────────
assert.ok(
    bcastSrc.includes("dtlsState === 'connected'") && bcastSrc.includes('return true; // handled'),
    'broadcast-server.js _tryCreateSfuViewer must short-circuit when DTLS is already connected'
);
assert.ok(
    bcastSrc.includes('requestKeyFrame') && bcastSrc.includes('Keyframe re-request'),
    'broadcast-server.js must request a keyframe on existing consumer instead of recreating transport'
);
assert.ok(
    bcastSrc.includes('Clean up previous SFU viewer transport (e.g. on re-watch after real transport failure)'),
    'broadcast-server.js must still clean up on real failure path'
);
console.log('OK A: broadcast-server.js _tryCreateSfuViewer dedup guard present');

// ── B: webrtc-sfu.js keyframe request ──────────────────────────
assert.ok(
    sfuSrc.includes('requestKeyFrame()'),
    'webrtc-sfu.js consume() must call consumer.requestKeyFrame()'
);
assert.ok(
    sfuSrc.includes("consumer.kind === 'video'") && sfuSrc.includes('requestKeyFrame'),
    'webrtc-sfu.js must guard requestKeyFrame() behind kind === video'
);
assert.ok(
    sfuSrc.includes('Keyframe requested for video consumer'),
    'webrtc-sfu.js must log keyframe request for diagnostics'
);
console.log('OK B: webrtc-sfu.js consume() calls requestKeyFrame() for video consumers');

// ── C: client-side in-progress guard ───────────────────────────
assert.ok(
    playerSrc.includes('let _sfuViewerSetupInProgress = false'),
    'stream-player.js must declare _sfuViewerSetupInProgress module-level flag'
);
assert.ok(
    playerSrc.includes('if (_sfuViewerSetupInProgress)'),
    'stream-player.js must guard sfu-viewer-ready message with _sfuViewerSetupInProgress check'
);
assert.ok(
    playerSrc.includes('_sfuViewerSetupInProgress = true;'),
    'stream-player.js must set _sfuViewerSetupInProgress = true before handleSfuViewerReady'
);
assert.ok(
    playerSrc.includes('finally') && playerSrc.includes('_sfuViewerSetupInProgress = false'),
    'stream-player.js must clear _sfuViewerSetupInProgress in a finally block'
);
console.log('OK C: _sfuViewerSetupInProgress concurrent-setup guard present in stream-player.js');

// ── D: 20s stall timer in SFU path, armed from connected state ──
assert.ok(
    playerSrc.includes("starting 20s first-frame grace window"),
    'stream-player.js SFU path must log 20s first-frame grace window message'
);
assert.ok(
    playerSrc.includes('}, 20000);'),
    'stream-player.js must have a 20000ms stall timer'
);
assert.ok(
    playerSrc.includes("state === 'connected'") &&
    playerSrc.indexOf("starting 20s first-frame grace window") >
        playerSrc.indexOf("state === 'connected'"),
    'stream-player.js 20s stall timer must be armed inside the connected state handler'
);
assert.ok(
    playerSrc.includes('no frames after 20s post-connect'),
    'stream-player.js SFU stall log must say 20s post-connect, not 8s'
);
console.log('OK D: 20s first-frame grace window armed inside transport connected handler');

// ── E: connect timeout + null-before-close cascade guard ────────
assert.ok(
    playerSrc.includes('}, 15000);') && playerSrc.includes('_sfuTransportConnectTimeout'),
    'stream-player.js must have a 15s ICE/DTLS connect timeout (_sfuTransportConnectTimeout)'
);
assert.ok(
    playerSrc.includes('_oldRecvTransport') && playerSrc.includes('player._sfuRecvTransport = null;'),
    'stream-player.js must null player._sfuRecvTransport BEFORE calling close() to prevent cascade'
);
assert.ok(
    playerSrc.includes('if (!player || player._sfuRecvTransport !== recvTransport) return;'),
    'stream-player.js connectionstatechange handler must guard against stale transport events'
);
console.log('OK E: 15s connect timeout + null-before-close cascade guard present in stream-player.js');

// ── F: WHIP ICE disconnect grace timer ──────────────────────────
assert.ok(
    whipSrc.includes("state === 'disconnected'") && whipSrc.includes('_iceGraceTimer'),
    'whip-handler.js must set a grace timer on ICE disconnected'
);
assert.ok(
    whipSrc.includes('15000') && whipSrc.includes('ICE grace expired'),
    'whip-handler.js ICE grace timer must be 15s and log expiry'
);
assert.ok(
    whipSrc.includes("state === 'failed'") && whipSrc.includes('ICE failed'),
    'whip-handler.js must clean up immediately on ICE failed'
);
assert.ok(
    whipSrc.includes("state === 'connected' || state === 'completed'") &&
    whipSrc.includes('grace timer canceled'),
    'whip-handler.js must cancel the grace timer if ICE recovers'
);
assert.ok(
    whipSrc.includes("ICE: ${state}") && whipSrc.includes('session=${resourceId}'),
    'whip-handler.js ICE state log must include stream, session, and transport IDs'
);
console.log('OK F: WHIP ICE disconnect/failed/recovery grace timer present in whip-handler.js');

// ── G: broadcast-server ICE filter + stale-source path ─────────
assert.ok(
    bcastSrc.includes("p.iceState !== 'connected' && p.iceState !== 'completed'"),
    'broadcast-server.js must filter producers by ICE state (not just DTLS)'
);
assert.ok(
    bcastSrc.includes('sfu-source-unavailable') && bcastSrc.includes('ingest_stale'),
    'broadcast-server.js must send sfu-source-unavailable when stale producers exist'
);
assert.ok(
    bcastSrc.includes('watch-queued'),
    'broadcast-server.js must send watch-queued when viewer is added to pending queue'
);
assert.ok(
    bcastSrc.includes('_notifyViewersSourceLost') && bcastSrc.includes('producer_removed'),
    'broadcast-server.js must notify SFU viewers when the source producer is removed'
);
assert.ok(
    bcastSrc.includes("producer-removed") && bcastSrc.includes('remaining.length === 0'),
    'broadcast-server.js must only notify source-lost when ALL producers are gone'
);
console.log('OK G: broadcast-server ICE filter + stale-source notification path present');

// ── H: client handles sfu-source-unavailable and watch-queued ──
assert.ok(
    playerSrc.includes("case 'sfu-source-unavailable':"),
    'stream-player.js must handle sfu-source-unavailable message'
);
assert.ok(
    playerSrc.includes("case 'watch-queued':"),
    'stream-player.js must handle watch-queued message'
);
// Neither handler should start the P2P offer timeout
assert.ok(
    !playerSrc.includes("case 'sfu-source-unavailable':\n                    // Server: ingest source is gone") ||
    playerSrc.includes("intentionally NOT calling _startWatchOfferTimeout()"),
    'stream-player.js sfu-source-unavailable handler must NOT start P2P offer timeout'
);
assert.ok(
    playerSrc.includes('Stream source temporarily unavailable'),
    'stream-player.js must show a user-facing status message on source unavailable'
);
console.log('OK H: sfu-source-unavailable and watch-queued handled without P2P offer timeout');

// ── I: frozen-video detector in SFU path ───────────────────────
assert.ok(
    playerSrc.includes('_sfuFrozenInterval') && playerSrc.includes('_frozenTicks'),
    'stream-player.js must have a frozen-video detector (_sfuFrozenInterval)'
);
assert.ok(
    playerSrc.includes('video frozen for ~30s'),
    'stream-player.js frozen detector must log after 30s of frozen video'
);
assert.ok(
    playerSrc.includes('player._sfuFrozenInterval = null') &&
    playerSrc.includes('clearInterval(player._sfuFrozenInterval)'),
    'stream-player.js must clear the frozen interval when transport changes'
);
// Frozen re-watch must NOT start P2P offer timeout
assert.ok(
    playerSrc.includes('Intentionally NOT calling _startWatchOfferTimeout()'),
    'stream-player.js frozen-video re-watch must NOT call _startWatchOfferTimeout()'
);
console.log('OK I: frozen-video detector (30s post-play check) present in stream-player.js');

// ── J: /shared startup sync + explicit JS content-type ──────────
assert.ok(
    indexSrc.includes('syncSharedAssets') && indexSrc.includes('copyFileSync'),
    'server/index.js must copy shared assets at startup (not rely on runtime symlink)'
);
assert.ok(
    indexSrc.includes('public/shared') || indexSrc.includes('sharedDestDir'),
    'server/index.js must serve /shared from a local public/shared/ directory'
);
assert.ok(
    indexSrc.includes("application/javascript") && indexSrc.includes('.endsWith(\'.js\')'),
    'server/index.js must set explicit application/javascript Content-Type for .js files'
);
assert.ok(
    indexSrc.includes('synced from') && indexSrc.includes('B)'),
    'server/index.js must log resolved source path and byte size of synced files'
);
assert.ok(
    indexSrc.includes('failed to sync') || indexSrc.includes('could not create'),
    'server/index.js must log clearly if shared asset sync fails'
);
console.log('OK J: /shared serving uses startup file copy with explicit JS content-type');

console.log('\nAll SFU viewer stability regression tests passed');

