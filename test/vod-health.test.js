'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const child = require('child_process');

// Verify code-level behavior in existing modules
const sfuSrc = fs.readFileSync(path.join(__dirname, '../server/streaming/webrtc-sfu.js'), 'utf8');
const recorderSrc = fs.readFileSync(path.join(__dirname, '../server/vod/recorder.js'), 'utf8');
assert.ok(sfuSrc.includes('consumer.requestKeyFrame()'), 'webrtc-sfu.js must request a keyframe for PlainRTP video consumers');
assert.ok(sfuSrc.includes('scheduleKeyframe(0, 1)') && sfuSrc.includes('scheduleKeyframe(3000, 4)'), 'webrtc-sfu.js must schedule repeated keyframe requests for recording consumers');
assert.ok(recorderSrc.includes('a=rtcp:') && recorderSrc.includes('a=rtcp-fb:'), 'recorder.js must emit explicit RTCP port and feedback lines in the generated RTP SDP');
assert.ok(recorderSrc.includes('VOD_DEBUG') || recorderSrc.includes('VOD_DIAGNOSTICS'), 'recorder.js must read debug diagnostics env settings');

// Run a minimal health scan against a real generated VOD file.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hobostreamer-vod-health-'));
const dbPath = path.join(tmpDir, 'hobostreamer.db');
process.env.DB_PATH = dbPath;
process.env.VOD_PATH = tmpDir;

const db = require('../server/db/database');
const { scanVod } = require('../server/vod/health-scanner');

if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
db.initDb();

const userRes = db.createUser({ username: 'testuser', email: 'test@example.com', password_hash: 'hash' });
assert.ok(userRes.lastInsertRowid, 'Could not create test user');

const videoFile = path.join(tmpDir, 'test-video.webm');
child.execSync(`ffmpeg -y -hide_banner -loglevel error -f lavfi -i testsrc=duration=1:size=160x120:rate=15 -f lavfi -i sine=frequency=1000:duration=1 -c:v libvpx -c:a libopus -b:v 200k -b:a 64k ${videoFile}`);
assert.ok(fs.existsSync(videoFile), 'Failed to generate test VOD file');

const vodRecord = db.createVod({
    stream_id: null,
    user_id: userRes.lastInsertRowid,
    title: 'Health scan test',
    description: 'Test VOD',
    file_path: videoFile,
    file_size: 0,
    duration_seconds: 0,
});
const vodId = vodRecord.lastInsertRowid;
assert.ok(vodId, 'Failed to create VOD record for health test');

(async () => {
    const vod = db.getVodById(vodId);
    const result = await scanVod(vod, { repairDuration: true, saveDiagnostics: false });
    assert.ok(result.status === 'duration_repaired' || result.status === 'ok', `Expected duration repair or ok, got ${result.status}`);
    const updatedVod = db.getVodById(vodId);
    assert.ok(updatedVod.duration_seconds > 0, 'Expected DB duration_seconds to be repaired from probe');
    console.log('OK: VOD health scanner repairs zero-duration records and preserves diagnostics model');
})();
