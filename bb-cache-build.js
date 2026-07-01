// Bad Pitches — offline cache builder.
//
// Run this ONCE while you still have internet (at home before a camping trip):
//     node bb-cache-build.js            # ~20 jazz samples + 8 drum breaks
//     JAZZ_COUNT=30 node bb-cache-build.js
//
// It downloads the audio + cover art Bad Pitches needs into public/bb-cache/ with
// filenames the server looks up by hash. After this runs, `npm start` auto-detects
// public/bb-cache/manifest.json and plays Bad Pitches fully offline. Re-run to add
// more (already-downloaded files are skipped).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT   = path.join(__dirname, 'public', 'bb-cache');
const AUDIO = path.join(OUT, 'audio');
const THUMB = path.join(OUT, 'thumb');
fs.mkdirSync(AUDIO, { recursive: true });
fs.mkdirSync(THUMB, { recursive: true });

const JAZZ_COUNT   = Number(process.env.JAZZ_COUNT) || 20;
const MAX_ATTEMPTS = Number(process.env.JAZZ_ATTEMPTS) || 25;

// Keep this in sync with BB_DRUM_BREAKS in index.js.
const BB_DRUM_BREAKS = [
    { title: 'Apache',                      artist: 'Incredible Bongo Band', file: '503.2 Apache.mp3',                     breakAt: 0  },
    { title: "Dance To The Drummer's Beat", artist: 'Herman Kelly & Life',   file: "503.3 Dance To The Drummer's Beat.mp3", breakAt: 0  },
    { title: 'Synthetic Substitution',      artist: 'Melvin Bliss',          file: '505.4 Synthetic Substitution.mp3',     breakAt: 0  },
    { title: 'Amen Brother',                artist: 'The Winstons',          file: '501.3 Amen Brother.mp3',               breakAt: 83 },
    { title: 'Different Strokes',           artist: 'Syl Johnson',           file: '504.1 Different Strokes.mp3',          breakAt: 0  },
    { title: 'Bongo Rock',                  artist: 'Incredible Bongo Band', file: '503.4 Bongo Rock.mp3',                 breakAt: 0  },
    { title: 'Cold Sweat',                  artist: 'James Brown',           file: '506.2 Cold Sweat.mp3',                 breakAt: 0  },
    { title: 'Give It Up Or Turn It Loose', artist: 'James Brown',           file: '507.1 Give It Up Or Turn It Loose.mp3', breakAt: 24 },
];

const bbHash = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

// Break-beat mp3s live inside this subfolder of the Archive.org item (matches index.js).
const BB_BREAKS_DIR = 'BreakBeat Lou Flores - Ultimate Breaks and Beats - The Complete Collection';
const bbBreakUrl = (file) =>
    `https://archive.org/download/ultimate-break-beats-complete/${`${BB_BREAKS_DIR}/${file}`.split('/').map(encodeURIComponent).join('/')}`;

function parseDuration(len) {
    if (!len) return 0;
    const s = String(len);
    if (s.includes(':')) {
        const p = s.split(':').map(Number);
        return p.length === 3 ? p[0]*3600 + p[1]*60 + p[2] : p[0]*60 + (p[1]||0);
    }
    return parseFloat(s) || 0;
}

async function fetchJazz(target, exclude = new Set()) {
    const api = 'https://archive.org/advancedsearch.php';
    const q = encodeURIComponent('collection:georgeblood AND mediatype:audio');
    const out = [];
    const seen = new Set(exclude);
    for (let attempt = 0; attempt < MAX_ATTEMPTS && out.length < target; attempt++) {
        try {
            const r = await fetch(`${api}?q=${q}&fl[]=identifier,title,creator,date,subject&rows=10&sort[]=random&output=json`,
                { signal: AbortSignal.timeout(25000) });
            const { response: { docs } } = await r.json();
            for (const doc of docs || []) {
                if (out.length >= target) break;
                if (seen.has(doc.identifier)) continue;
                seen.add(doc.identifier);
                const subj = [].concat(doc.subject || []).join(' ').toLowerCase();
                if (/speech|spoken|comedy|lecture|interview/.test(subj)) continue;
                try {
                    const meta = await (await fetch(`https://archive.org/metadata/${doc.identifier}`,
                        { signal: AbortSignal.timeout(20000) })).json();
                    const mp3 = (meta.files || []).find(f =>
                        /mp3/i.test(f.format || '') &&
                        (f.name || '').toLowerCase().endsWith('.mp3') &&
                        parseDuration(f.length) > 60);
                    if (!mp3) continue;
                    const creator = Array.isArray(doc.creator) ? doc.creator[0] : (doc.creator || 'Unknown Artist');
                    out.push({
                        identifier: doc.identifier,
                        title: doc.title || 'Unknown Track',
                        creator, date: (doc.date || '').slice(0, 4),
                        audioUrl: `https://archive.org/download/${doc.identifier}/${encodeURIComponent(mp3.name)}`,
                        thumbUrl: `https://archive.org/services/img/${doc.identifier}`,
                        duration: parseDuration(mp3.length),
                    });
                    console.log(`  ♪ found (${out.length}/${target}): ${doc.title}`);
                } catch (e) { /* skip bad item */ }
            }
        } catch (e) { console.log(`  search attempt ${attempt + 1} failed: ${e.message}`); }
    }
    return out;
}

async function download(url, dest, label) {
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { console.log(`  = cached ${label}`); return fs.statSync(dest).size; }
    const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(dest, buf);
    console.log(`  ↓ ${label} (${(buf.length/1e6).toFixed(1)} MB)`);
    return buf.length;
}

(async () => {
    let bytes = 0, ok = 0, fail = 0;

    // Resume: keep jazz already listed in a previous manifest, only fetch the shortfall.
    let existing = [];
    try { existing = (JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')).jazz) || []; } catch (_) {}
    const have = new Set(existing.map(s => s.identifier));
    const need = Math.max(0, JAZZ_COUNT - existing.length);
    console.log(`\n[BB cache] ${existing.length} jazz already cached; fetching ${need} more (target ${JAZZ_COUNT})…`);
    const fresh = need ? await fetchJazz(need, have) : [];
    const jazz = existing.concat(fresh);
    console.log(`[BB cache] downloading audio + art for ${jazz.length} jazz samples…`);
    for (const s of jazz) {
        try {
            bytes += await download(s.audioUrl, bbAudioFile(s.audioUrl), `audio ${s.title}`);
            try { bytes += await download(`https://archive.org/services/img/${s.identifier}`, bbThumbFile(s.identifier), `art ${s.identifier}`); }
            catch (e) { console.log(`  (no art for ${s.identifier})`); }
            ok++;
        } catch (e) { console.log(`  ✗ ${s.title}: ${e.message}`); fail++; }
    }

    console.log(`\n[BB cache] downloading ${BB_DRUM_BREAKS.length} drum breaks…`);
    for (const d of BB_DRUM_BREAKS) {
        const audioUrl = bbBreakUrl(d.file);
        try { bytes += await download(audioUrl, bbAudioFile(audioUrl), `drum ${d.title}`); ok++; }
        catch (e) { console.log(`  ✗ ${d.title}: ${e.message}`); fail++; }
    }
    // one shared cover for the whole break-beats collection
    try { bytes += await download('https://archive.org/services/img/ultimate-break-beats-complete', bbThumbFile('ultimate-break-beats-complete'), 'art drum-breaks'); }
    catch (e) { console.log('  (no drum-break art)'); }

    const manifest = { builtAt: new Date().toISOString(), jazz, drums: BB_DRUM_BREAKS };
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

    console.log(`\n[BB cache] DONE — ${ok} ok, ${fail} failed, ${(bytes/1e6).toFixed(0)} MB total.`);
    console.log('[BB cache] manifest -> public/bb-cache/manifest.json');
    console.log('[BB cache] Now run `npm start` (or BB_OFFLINE=1 npm start) to play offline.\n');
})();

function bbAudioFile(audioUrl) { return path.join(AUDIO, bbHash(audioUrl) + '.mp3'); }
function bbThumbFile(id)        { return path.join(THUMB, bbHash(id) + '.jpg'); }
