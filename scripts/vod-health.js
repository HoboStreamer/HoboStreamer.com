'use strict';
const path = require('path');
const { scanVod, selectVods } = require('../server/vod/health-scanner');

function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        vodId: null,
        user: null,
        since: null,
        all: false,
        limit: 100,
        repairDuration: false,
        remux: false,
        quarantineBad: false,
        json: false,
        debug: false,
    };
    for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (arg === '--vod-id' && args[i + 1]) { opts.vodId = parseInt(args[++i], 10); }
        else if (arg === '--user' && args[i + 1]) { opts.user = args[++i]; }
        else if (arg === '--since' && args[i + 1]) { opts.since = args[++i]; }
        else if (arg === '--all') { opts.all = true; }
        else if (arg === '--limit' && args[i + 1]) { opts.limit = parseInt(args[++i], 10) || 100; }
        else if (arg === '--repair-duration') { opts.repairDuration = true; }
        else if (arg === '--remux') { opts.remux = true; }
        else if (arg === '--quarantine-bad') { opts.quarantineBad = true; }
        else if (arg === '--json') { opts.json = true; }
        else if (arg === '--debug') { opts.debug = true; }
    }
    return opts;
}

async function run() {
    const opts = parseArgs();
    const vods = selectVods({ vodId: opts.vodId, user: opts.user, since: opts.since, all: opts.all, limit: opts.limit });
    if (!vods.length) {
        console.log('No VODs found for the requested criteria.');
        process.exit(0);
    }

    const results = [];
    for (const vod of vods) {
        console.log(`Scanning VOD ${vod.id} (stream ${vod.stream_id}) ${vod.file_path}`);
        const scan = await scanVod(vod, {
            decode: opts.debug,
            thumbnails: opts.debug,
            remux: opts.remux,
            repairDuration: opts.repairDuration,
            quarantineBad: opts.quarantineBad,
            saveDiagnostics: opts.debug,
        });
        results.push(scan);
        if (!opts.json) {
            console.log(JSON.stringify(scan, null, 2));
        }
    }

    if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
    }
}

run().catch(err => {
    console.error('VOD health scanner failed:', err.message || err);
    process.exit(1);
});
