// Bad Pitches — offline cache builder.
//
// Run this ONCE while you still have internet (at home before a camping trip):
//     node bb-cache-build.js
//
// It downloads every break in the catalog below (audio + the shared cover art) into
// public/bb-cache/ with filenames the server looks up by hash. After this runs,
// `npm start` auto-detects public/bb-cache/manifest.json and Bad Pitches deals crates
// fully offline. Re-runnable — already-downloaded files are skipped.
//
// ~36 tracks × ~3-4MB ≈ 130MB total.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const OUT   = path.join(__dirname, 'public', 'bb-cache');
const AUDIO = path.join(OUT, 'audio');
const THUMB = path.join(OUT, 'thumb');
fs.mkdirSync(AUDIO, { recursive: true });
fs.mkdirSync(THUMB, { recursive: true });

const bbHash = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

// Break-beat mp3s live inside this subfolder of the Archive.org item (matches index.js).
const BB_BREAKS_DIR = 'BreakBeat Lou Flores - Ultimate Breaks and Beats - The Complete Collection';
const bbBreakUrl = (file) =>
    `https://archive.org/download/ultimate-break-beats-complete/${`${BB_BREAKS_DIR}/${file}`.split('/').map(encodeURIComponent).join('/')}`;

// Keep this in sync with BB_BREAK_CATALOG in index.js.
const BB_BREAK_CATALOG = [
    { title: 'Amen Brother',                 artist: 'The Winstons',            file: '501.3 Amen Brother.mp3' },
    { title: 'Apache',                       artist: 'Incredible Bongo Band',   file: '503.2 Apache.mp3' },
    { title: 'Funky Drummer',                artist: 'James Brown',             file: '512.2 Funky Drummer.mp3' },
    { title: 'Impeach The President',        artist: 'The Honey Drippers',      file: '511.1 Impeach The President.mp3' },
    { title: 'Synthetic Substitution',       artist: 'Melvin Bliss',            file: '505.4 Synthetic Substitution.mp3' },
    { title: 'Think (About It)',             artist: 'Lyn Collins',             file: '516.5 Think (About It).mp3' },
    { title: "It's Just Begun",              artist: 'The Jimmy Castor Bunch',  file: "518.4 It's Just Begun.mp3" },
    { title: "Ashley's Roachclip",           artist: 'The Soul Searchers',      file: "512.6 Ashley's Roachclip.mp3" },
    { title: 'The Champ',                    artist: 'The Mohawks',             file: '512.3 The Champ.mp3' },
    { title: 'Cold Sweat',                   artist: 'James Brown',             file: '506.2 Cold Sweat.mp3' },
    { title: 'Funky President',              artist: 'James Brown',             file: '510.1 Funky President.mp3' },
    { title: 'Blind Alley',                  artist: 'The Emotions',            file: '524.4 Blind Alley.mp3' },
    { title: 'Long Red',                     artist: 'Mountain',                file: '509.5 Long Red.mp3' },
    { title: 'Big Beat',                     artist: 'Billy Squier',            file: '509.3 Big Beat.mp3' },
    { title: 'Seven Minutes Of Funk',        artist: 'The Whole Darn Family',   file: '509.6 Seven Minutes Of Funk.mp3' },
    { title: 'Hand Clapping Song',           artist: 'The Meters',              file: '508.5 Hand Clapping Song.mp3' },
    { title: "Dance To The Drummer's Beat",  artist: 'Herman Kelly & Life',     file: "503.3 Dance To The Drummer's Beat.mp3" },
    { title: 'Bongo Rock',                   artist: 'Incredible Bongo Band',   file: '503.4 Bongo Rock.mp3' },
    { title: 'Different Strokes',            artist: 'Syl Johnson',             file: '504.1 Different Strokes.mp3' },
    { title: 'Give It Up Or Turn It Loose',  artist: 'James Brown',             file: '507.1 Give It Up Or Turn It Loose.mp3' },
    { title: 'N.T.',                         artist: 'Kool & The Gang',         file: '517.5 N.T..mp3' },
    { title: 'The Grunt Pt. 1',              artist: "The J.B.'s",              file: '522.4 The Grunt Pt. 1.mp3' },
    { title: 'Blow Your Head',               artist: "Fred Wesley & The J.B.'s", file: '514.6 Blow Your Head.mp3' },
    { title: 'Get Out My Life Woman',        artist: 'Lee Dorsey',              file: '523.4 Get Out My Life Woman.mp3' },
    { title: 'Hook And Sling Pt. 1',         artist: 'Eddie Bo',                file: '520.6 Hook And Sling Pt. 1.mp3' },
    { title: 'Kissing My Love',              artist: 'Bill Withers',            file: '520.7 Kissing My Love.mp3' },
    { title: 'Soul Pride',                   artist: 'James Brown',             file: '521.5 Soul Pride.mp3' },
    { title: "Scratchin'",                   artist: 'Magic Disco Machine',     file: "506.5 Scratchin'.mp3" },
    { title: 'Shack Up',                     artist: 'Banbarra',                file: '505.7 Shack Up.mp3' },
    { title: 'I Know You Got Soul',          artist: 'Bobby Byrd',              file: '504.2 I Know You Got Soul.mp3' },
    { title: 'Misdemeanor',                  artist: 'Foster Sylvers',          file: '519.4 Misdemeanor.mp3' },
    { title: 'The Payback',                  artist: 'James Brown',             file: '525.7 The Payback.mp3' },
    { title: 'The Mexican',                  artist: 'Babe Ruth',               file: '508.1 The Mexican.mp3' },
    { title: 'T Plays It Cool',              artist: 'Marvin Gaye',             file: '516.4 T Plays It Cool.mp3' },
    { title: 'Rock Creek Park',              artist: 'The Blackbyrds',          file: '519.1 Rock Creek Park.mp3' },
    { title: 'Catch A Groove',               artist: 'Juice',                   file: '502.2 Catch A Groove.mp3' },
];

const bbAudioFile = (audioUrl) => path.join(AUDIO, bbHash(audioUrl) + '.mp3');
const bbThumbFile = (id)       => path.join(THUMB, bbHash(id) + '.jpg');

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
    console.log(`\n[BB cache] downloading ${BB_BREAK_CATALOG.length} breaks…`);
    for (const b of BB_BREAK_CATALOG) {
        const audioUrl = bbBreakUrl(b.file);
        try { bytes += await download(audioUrl, bbAudioFile(audioUrl), b.title); ok++; }
        catch (e) { console.log(`  ✗ ${b.title}: ${e.message}`); fail++; }
    }
    // one shared cover for the whole break-beats collection
    try { bytes += await download('https://archive.org/services/img/ultimate-break-beats-complete', bbThumbFile('ultimate-break-beats-complete'), 'art'); }
    catch (e) { console.log('  (no art)'); }

    // manifest.json is what flips the server into BB_OFFLINE mode; the server decides what's
    // dealable by checking which audio files actually exist on disk, not by reading this list.
    const manifest = { builtAt: new Date().toISOString(), drums: BB_BREAK_CATALOG };
    fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));

    console.log(`\n[BB cache] DONE — ${ok} ok, ${fail} failed, ${(bytes/1e6).toFixed(0)} MB total.`);
    console.log('[BB cache] Now run `npm start` to deal crates fully offline.\n');
})();
