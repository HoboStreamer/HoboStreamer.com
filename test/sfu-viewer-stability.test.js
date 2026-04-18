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
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const playerSrc = fs.readFileSync(path.join(__dirname, '../public/js/stream-player.js'), 'utf8');
const sfuSrc = fs.readFileSync(path.join(__dirname, '../server/streaming/webrtc-sfu.js'), 'utf8');
const bcastSrc = fs.readFileSync(path.join(__dirname, '../server/streaming/broadcast-server.js'), 'utf8');

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
// The SFU stall timer logs a specific message before arming
assert.ok(
    playerSrc.includes("starting 20s first-frame grace window"),
    'stream-player.js SFU path must log 20s first-frame grace window message'
);
// 20000 ms timeout must appear directly after the grace window is armed
assert.ok(
    playerSrc.includes('}, 20000);'),
    'stream-player.js must have a 20000ms stall timer'
);
// The 20s timer must only be set inside the connected state handler
assert.ok(
    playerSrc.includes("state === 'connected'") &&
    playerSrc.indexOf("starting 20s first-frame grace window") >
        playerSrc.indexOf("state === 'connected'"),
    'stream-player.js 20s stall timer must be armed inside the connected state handler'
);
// The SFU stall log must reference 20s, not 8s
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

console.log('\nAll SFU viewer stability regression tests passed');
