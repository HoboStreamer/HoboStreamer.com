const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const config = require('../config');

function _runCommand(args, options = {}) {
    return new Promise((resolve) => {
        const proc = spawn(args[0], args.slice(1), options);
        let stdout = '';
        let stderr = '';
        if (proc.stdout) proc.stdout.on('data', d => stdout += d.toString());
        if (proc.stderr) proc.stderr.on('data', d => stderr += d.toString());
        proc.on('close', (code) => resolve({ code, stdout, stderr }));
        proc.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
        setTimeout(() => {
            try { proc.kill(); } catch {};
        }, options.timeout || 30000);
    });
}

function _normalizeVodFile(vod) {
    return {
        ...vod,
        file_path: vod.file_path || vod.filePath || null,
    };
}

function getDiagnosticsDir() {
    const dir = path.resolve(config.vod.path, 'diagnostics');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function writeDiagnostics(vodId, streamId, name, content) {
    const dir = getDiagnosticsDir();
    const filename = `vod-${vodId}-stream-${streamId}.${name}`;
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

function probeMediaInfo(filePath) {
    return new Promise((resolve) => {
        const proc = spawn('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath]);
        let out = '';
        proc.stdout.on('data', d => out += d.toString());
        proc.on('close', () => {
            try {
                const info = JSON.parse(out);
                const duration = parseFloat(info.format?.duration || '0');
                resolve({
                    ok: true,
                    duration: Number.isFinite(duration) ? duration : 0,
                    format: info.format || {},
                    streams: info.streams || [],
                });
            } catch {
                resolve({ ok: false, duration: 0, format: null, streams: [] });
            }
        });
        proc.on('error', () => resolve({ ok: false, duration: 0, format: null, streams: [] }));
        setTimeout(() => { try { proc.kill(); } catch {} }, 10000);
    });
}

function decodeVodFile(filePath) {
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', ['-v', 'warning', '-xerror', '-i', filePath, '-map', '0:v:0', '-f', 'null', '-']);
        let stderr = '';
        proc.stderr.on('data', d => stderr += d.toString());
        proc.on('close', (code) => {
            const warnings = stderr.split('\n').filter(line => /error|warn|corrupt|invalid|timestamp|RTP|concealing|Non-monotonous DTS/i.test(line));
            resolve({ code, stderr, warnings, ok: code === 0 });
        });
        proc.on('error', () => resolve({ code: -1, stderr: '', warnings: [], ok: false }));
        setTimeout(() => { try { proc.kill(); } catch {} }, 60000);
    });
}

function remuxForSeeking(filePath) {
    return new Promise((resolve) => {
        const tmpPath = `${filePath}.remux.tmp.webm`;
        const proc = spawn('ffmpeg', ['-y', '-i', filePath, '-c', 'copy', '-fflags', '+genpts', tmpPath]);
        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(tmpPath)) {
                try {
                    fs.renameSync(tmpPath, filePath);
                    resolve({ ok: true });
                } catch (err) {
                    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                    resolve({ ok: false, error: err.message });
                }
            } else {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                resolve({ ok: false, error: `ffmpeg remux failed code ${code}` });
            }
        });
        proc.on('error', (err) => {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            resolve({ ok: false, error: err.message });
        });
        setTimeout(() => { try { proc.kill(); } catch {} }, 30000);
    });
}

function extractThumbnails(filePath, outputDir, duration) {
    const offsets = [0.05, 0.5, 0.95].map(r => Math.max(0.1, Math.min(duration * r, duration - 0.1)));
    const files = [];
    for (let i = 0; i < offsets.length; i += 1) {
        const offset = offsets[i];
        const outPath = path.join(outputDir, `thumbnail-${i + 1}.jpg`);
        const args = ['-y', '-ss', `${offset}`, '-i', filePath, '-frames:v', '1', '-q:v', '8', outPath];
        const result = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'ignore'] });
        files.push({ outPath, process: result });
    }
    return Promise.all(files.map(({ process, outPath }) => new Promise((resolve) => {
        process.on('close', (code) => resolve({ ok: code === 0 && fs.existsSync(outPath), outPath, code }));
        process.on('error', () => resolve({ ok: false, outPath, code: -1 }));
        setTimeout(() => { try { process.kill(); } catch {} }, 30000);
    })));
}

async function scanVod(vod, options = {}) {
    const normalizedVod = _normalizeVodFile(vod);
    const filePath = normalizedVod.file_path;
    const result = {
        vodId: normalizedVod.id,
        streamId: normalizedVod.stream_id,
        filePath,
        status: 'unknown',
        issues: [],
        probe: null,
        decode: null,
        remux: null,
        thumbnails: null,
        durationMatch: false,
    };

    if (!filePath || !fs.existsSync(filePath)) {
        result.status = 'missing_file';
        result.issues.push('missing_file');
        return result;
    }

    let stat;
    try {
        stat = fs.statSync(filePath);
        if (stat.size <= 0) {
            result.status = 'zero_byte';
            result.issues.push('zero_byte');
            return result;
        }
    } catch (err) {
        result.status = 'missing_file';
        result.issues.push('stat_error');
        return result;
    }

    const probeInfo = await probeMediaInfo(filePath);
    result.probe = probeInfo;
    if (!probeInfo.ok) {
        result.status = 'needs_review';
        result.issues.push('probe_failed');
    } else {
        if (!probeInfo.duration || probeInfo.duration <= 0) {
            result.status = 'needs_review';
            result.issues.push('invalid_duration');
        }
        if (normalizedVod.duration_seconds <= 0 && probeInfo.duration > 0) {
            result.durationMatch = false;
            result.issues.push('duration_repair_available');
        } else if (Math.abs((normalizedVod.duration_seconds || 0) - probeInfo.duration) > 2) {
            result.durationMatch = false;
            result.issues.push('duration_mismatch');
        } else {
            result.durationMatch = true;
        }
    }

    if (options.decode && probeInfo.ok && probeInfo.duration > 0) {
        const decodeResult = await decodeVodFile(filePath);
        result.decode = decodeResult;
        if (!decodeResult.ok) {
            result.issues.push('decode_failed');
        }
        if (decodeResult.warnings.length > 0) {
            result.issues.push(...decodeResult.warnings.map(w => w.trim()).filter(Boolean));
        }
    }

    if (options.thumbnails && probeInfo.ok && probeInfo.duration > 0) {
        const diagDir = path.resolve(getDiagnosticsDir(), `vod-${normalizedVod.id}-stream-${normalizedVod.stream_id}-thumbs`);
        if (!fs.existsSync(diagDir)) fs.mkdirSync(diagDir, { recursive: true });
        result.thumbnails = await extractThumbnails(filePath, diagDir, probeInfo.duration);
    }

    if (options.remux && probeInfo.ok) {
        result.remux = await remuxForSeeking(filePath);
        if (!result.remux.ok) {
            result.issues.push('remux_failed');
        }
    }

    if (result.issues.length === 0) {
        result.status = 'ok';
    } else if (result.status === 'unknown') {
        result.status = result.issues.includes('decode_failed') || result.issues.some(i => /invalid|corrupt|failed/.test(i))
            ? 'corrupt'
            : 'needs_review';
    }

    if (options.repairDuration && probeInfo.ok && probeInfo.duration > 0 && (normalizedVod.duration_seconds || 0) <= 0) {
        result.repair = db.repairVodDuration(normalizedVod.id, Math.round(probeInfo.duration), stat.size);
        result.issues.push('duration_repaired');
        result.status = 'duration_repaired';
    }

    if (options.quarantineBad && ['corrupt', 'missing_file', 'zero_byte'].includes(result.status)) {
        db.updateVodHealth(normalizedVod.id, {
            status: result.status,
            issues: result.issues,
            probeDuration: probeInfo.duration,
            probeFormat: probeInfo.format,
            quarantine: true,
        });
    }

    if (options.saveDiagnostics) {
        writeDiagnostics(normalizedVod.id, normalizedVod.stream_id, 'scan.json', JSON.stringify(result, null, 2));
    }

    return result;
}

function selectVods({ vodId, user, since, all, limit }) {
    if (vodId) {
        const vod = db.getVodById(vodId);
        return vod ? [vod] : [];
    }
    if (user) {
        const u = db.get('SELECT id FROM users WHERE LOWER(username)=LOWER(?)', [user]);
        if (!u) return [];
        return db.getVodsByUser(u.id, true, limit || 200, 0);
    }
    if (all) {
        return db.getPublicVods(limit || 200, 0, {});
    }
    if (since) {
        if (/^\d{4}-\d{2}-\d{2}/.test(since)) {
            return db.getVodScanCandidates({ limit: limit || 200, since });
        }
        return db.getVodScanCandidates({ limit: limit || 200, since: `now, ${since}` });
    }
    return [];
}

module.exports = {
    probeMediaInfo,
    decodeVodFile,
    remuxForSeeking,
    extractThumbnails,
    scanVod,
    selectVods,
};
