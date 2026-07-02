const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 }); // 8MB cap per message (was 50MB — DoS surface)

app.use(express.static('public'));

// ─── Bad Pitches offline cache ────────────────────────────────────────────────
// When public/bb-cache/manifest.json exists (built by `node bb-cache-build.js`),
// Bad Pitches serves pre-downloaded audio + art from disk and never touches the
// network — so it works over a hotspot with no internet. On Render (no cache dir)
// nothing changes. Set BB_OFFLINE=0 to force the live behaviour even with a cache.
const BB_CACHE_DIR = path.join(__dirname, 'public', 'bb-cache');
function bbHash(str) { return crypto.createHash('md5').update(String(str)).digest('hex'); }
function bbAudioCacheFile(audioUrl) { return path.join(BB_CACHE_DIR, 'audio', bbHash(audioUrl) + '.mp3'); }
let bbManifest = null;
try { bbManifest = JSON.parse(fs.readFileSync(path.join(BB_CACHE_DIR, 'manifest.json'), 'utf8')); } catch (_) {}
const BB_OFFLINE = process.env.BB_OFFLINE === '0' ? false : !!bbManifest;
if (BB_OFFLINE) console.log('[BB] OFFLINE cache active — serving pre-downloaded breaks from disk');

// ─── LAN address (for the scan-to-join QR when hosting over a hotspot) ─────────
// Picks the best local IPv4 to advertise. Only used as a fallback when the host
// opened the page via localhost; normally the client uses its own page origin.
// Gated behind JC_LOCAL_MODE so this never activates on Render or plain local dev
// testing — only when explicitly launched for real offline/hotspot play (Termux
// camping sets this env var; Spawnpoint's embedded launcher sets it itself).
const JC_LOCAL_MODE = process.env.JC_LOCAL_MODE === '1' || process.env.JC_LOCAL_MODE === 'true';
function jcLanIp() {
    const ifaces = os.networkInterfaces();
    let best = '127.0.0.1', bestScore = -1;
    for (const name of Object.keys(ifaces)) {
        for (const net of ifaces[name] || []) {
            if (net.family !== 'IPv4' || net.internal) continue;
            let s = 0;
            if (/^(ap|wlan1|swlan|softap|rndis|usb|tether)/i.test(name)) s += 4;
            if (net.address.endsWith('.1')) s += 3;
            if (net.address.startsWith('192.168.')) s += 2;
            else if (net.address.startsWith('10.') || net.address.startsWith('172.')) s += 1;
            if (s > bestScore) { bestScore = s; best = net.address; }
        }
    }
    return best;
}
app.get('/api/lan-ip', (req, res) => res.json({ ip: JC_LOCAL_MODE ? jcLanIp() : null }));

// ─── Input sanitation (XSS + oversized-upload hardening) ───────────────────────
// Player-controlled fields are the attack surface: names/colors get rendered and
// media gets stored in RAM. Clamp everything at the trust boundary (here) so the
// rest of the server — and every client render site — can treat them as safe.
function sanitizeName(raw) {
    let out = '';
    for (const ch of String(raw ?? '')) {
        const code = ch.codePointAt(0);
        if (code < 0x20 || code === 0x7f) continue;                 // drop control chars
        if (ch === '<' || ch === '>' || ch === '"' || ch === '`') continue; // drop HTML-danger chars
        if (ch === '[' || ch === ']') continue; // drop bracket chars — Bad Pitches uses [TOKEN] template syntax
        out += ch;
    }
    return out.trim().slice(0, 16) || 'Player';
}
const COLOR_RE = /^(#[0-9a-f]{3,8}|rgb\(\s*\d{1,3}(\s*,\s*\d{1,3}){2}\s*\)|hsl\(\s*\d{1,3}(\.\d+)?\s*,\s*\d{1,3}(\.\d+)?%\s*,\s*\d{1,3}(\.\d+)?%\s*\))$/i;
function validColor(c, fallback = '#8ab4f8') {
    return (typeof c === 'string' && COLOR_RE.test(c.trim())) ? c.trim() : fallback;
}
// dataURL guard: correct MIME family + within a hard byte ceiling (string length ≈ bytes).
function validDataUrl(s, kind, maxBytes) {
    return typeof s === 'string' && s.startsWith(`data:${kind}/`) && s.length <= maxBytes;
}
// Coerce a drawing stroke to safe primitives (finite coords, clamped brush, valid color).
function sanitizeStroke(stroke, socketId) {
    const n = v => (Number.isFinite(v) ? v : 0);
    return {
        socketId, x1: n(stroke.x1), y1: n(stroke.y1), x2: n(stroke.x2), y2: n(stroke.y2),
        color: validColor(stroke.color, '#000'),
        size: Math.min(Math.max(Number(stroke.size) || 2, 1), 80),
        t: Date.now(), gid: stroke.gid || 0,
    };
}
const STROKE_CAP = 6000; // max strokes retained per drawing surface (spam/DoS guard)

// ─── Bad Pitches audio proxies ────────────────────────────────────────────────
// getCache/setCache let callers point at either a flat room-level buffer or a per-player one,
// without bbProxyAudio itself needing to know which shape the room's state is in.
async function bbProxyAudio(audioUrl, getCache, setCache, res) {
    // Offline disk cache — serve pre-downloaded bytes without touching the network.
    if (audioUrl) {
        const f = bbAudioCacheFile(audioUrl);
        if (fs.existsSync(f)) {
            const buf = fs.readFileSync(f);
            res.setHeader('Content-Type', 'audio/mpeg');
            res.setHeader('Content-Length', buf.length);
            return res.send(buf);
        }
    }
    const cached = getCache();
    if (cached) {
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Length', cached.length);
        return res.send(cached);
    }
    try {
        const upstream = await fetch(audioUrl);
        if (!upstream.ok) return res.status(502).end();
        res.setHeader('Content-Type', 'audio/mpeg');
        const chunks = [];
        const reader = upstream.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const buf = Buffer.from(value);
            chunks.push(buf); res.write(buf);
        }
        res.end();
        setCache(Buffer.concat(chunks));
    } catch(e) {
        console.error('bb-audio proxy error:', e.message);
        if (!res.headersSent) res.status(502).end(); else res.end();
    }
}
// Break audio by catalog index (v4: the dig crate is a fixed catalog of legendary breaks,
// not per-room Archive.org search results — so audio is served by catalog position and the
// in-RAM byte cache is global, shared by every room and every player previewing the same break).
const bbBreakBytes = {}; // catalog idx -> Buffer
app.get('/api/bb-break/:idx', async (req, res) => {
    const idx = Number(req.params.idx);
    const brk = BB_BREAK_CATALOG[idx];
    if (!brk) return res.status(404).end();
    await bbProxyAudio(
        brk.audioUrl,
        () => bbBreakBytes[idx],
        (buf) => { bbBreakBytes[idx] = buf; },
        res
    );
});

// ─── Room registry ────────────────────────────────────────────────────────────

const rooms = {};   // code -> room object

const MAX_PLAYERS_PER_ROOM = 12;   // cap per room
const MAX_ACTIVE_ROOMS     = 300;  // global safety cap
const CREATE_WINDOW_MS     = 30000; // room-spam window
const CREATE_MAX_IN_WINDOW = 5;     // max createRoom calls per socket per window

function makeCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = Array.from({ length: 4 }, () => chars[Math.random() * chars.length | 0]).join(''); }
    while (rooms[code]);
    return code;
}

function makeRoom(code) {
    return {
        code,
        players: {},          // socket.id -> player
        scores: {},           // name -> { name, survivals, catches }
        avatars: {},          // socket.id -> painted canvas dataUrl
        feedMaps: {},         // feedIndex -> dataUrl
        feedNames: {},        // feedIndex -> name
        playerState: {},      // token -> { isDead }
        lastReactionTimes: {},
        hostSocketId: null,
        hostToken: null,
        seekerSocketId: null,   // initial seeker (compat)
        seekerToken: null,
        seekerSocketIds: [],    // all current seekers (grows via snowball)
        seekerTokens: [],       // tokens of all seekers (survives reconnects)
        seekerPokes: {},        // socketId -> remaining pokes
        seekerPokesByToken: {}, // token -> remaining pokes (survives reconnects)
        seekerPokesLeft: 0,     // legacy field kept for compat
        infection: true,        // caught hiders become seekers (snowball) vs eliminated
        seekerCameras: {},      // socketId -> { x, y, scale, screenW, screenH, name, color }
        viewportPoints: {},     // socketId -> accumulated points
        viewportTick: null,
        gamePhase: 'LOBBY',   // LOBBY | HIDING | SEEKING | REVEAL
        selectedGame: null,   // 'tacostealth' | 'strokeoff'
        strokePainting: null, // selected PAINTINGS entry
        timeLeft: 0,
        lastHideTime: 45,
        lastSeekTime: 120,
        gameTimer: null,
        gameVotes: {},      // socketId -> gameId (lobby preference votes)
        // Stroke Off state
        strokePrompt: null,
        strokeTheme: null,
        strokeFakeId: null,
        strokeHistory: [],
        strokeVotes: {},        // voterId -> suspectId
        strokePlayerParts: {},  // socketId -> part string
        strokePhase: 'LOBBY',
        soScores: {},           // name -> { name, correct, fakeWins }
        revealTimer: null,
        // Stroke Off (squiggle) state
        sqRound: 0,
        sqPhase: 'LOBBY',
        sqSquiggles: {},        // socketId -> [{x,y}×4]
        sqMatchups: [],         // [{p1Id,p2Id,prompt,pointValue,winner,p1Votes,p2Votes}]
        sqCurrentMatchup: 0,
        sqHistories: {},        // socketId -> stroke array
        sqScores: {},           // socketId -> accumulated points
        sqVotes: {},            // socketId -> 'p1'|'p2'
        sqByeId: null,
        sqTimer: null,
        sqTimeLeft: 0,
        // PikPic state
        ppPhase: 'LOBBY',
        ppPlayerPhotos: {},
        ppReady: {},
        ppDeck: [],
        ppHands: {},
        ppRound: 0,
        ppStorytellerId: null,
        ppStorytellerIds: [],
        ppClue: null,
        ppTable: [],
        ppVotes: {},
        ppSubUsed: {},
        ppScores: {},
        ppTimer: null,
        ppTimeLeft: 0,
        // Rizz or Roast state
        rrPhase: 'LOBBY',
        rrTemplate: null,
        rrPlayerFills: {},
        rrFillReady: {},
        rrPlayerRecordings: {},
        rrRecordReady: {},
        rrBattles: [],
        rrCurrentBattle: 0,
        rrScores: {},
        rrTimer: null,
        rrTimeLeft: 0,
        suggestedPhotos: [],  // non-host photo suggestions queued for host review
        // Split Crew state
        scPhase: 'LOBBY',
        scTeams: [],
        scLap: 0,
        scPyroId: null,
        scTimer: null,
        scTimeLeft: 0,
        // Bad Pitches state (v3 — round-based 1v1 rap battles: Dig/Chop/Spit then Battle)
        bbPhase: 'LOBBY',
        bbRound: 0,
        bbTotalRounds: 3,
        bbMatchups: [],
        bbCurrentMatchup: 0,
        bbByeId: null,
        bbSamples: {},              // playerId -> picked break (catalog entry)
        bbDigOptions: {},           // playerId -> [catalog idx] dealt this round
        bbChops: {},                // playerId -> {start, end, hitCount, rate}
        bbSpitFills: {},            // playerId -> [fill strings]
        bbFlowPreset: {},           // playerId -> 'chipmunk'|'villain'|'straight'|'autotune'
        bbAdlibs: {},               // playerId -> {type:'recorded',dataUrl} | {type:'stock',id} | null
        bbVotes: {},
        bbRoundScores: {},
        bbCumScores: {},
        bbUsedIds: new Set(),
        bbTimer: null,
        bbTimeLeft: 0,
    };
}

function getRoom(code) { return rooms[code] || null; }

// Deferred eviction: socketId -> setTimeout handle (cancelled if player reconnects in time)
const disconnectTimers = {};

// Shared cleanup called on full eviction (leaveRoom, kickPlayer, or after 30s grace)
function evictPlayer(room, id) {
    if (!room.players[id]) return;
    const name = room.players[id].name || '?';
    delete room.players[id];
    delete room.avatars[id];
    delete room.lastReactionTimes[id];
    if (id === room.seekerSocketId) room.seekerSocketId = null;
    room.seekerSocketIds = room.seekerSocketIds.filter(x => x !== id);
    delete room.seekerPokes[id]; delete room.seekerCameras[id];
    broadcastRoom(room, 'updatePlayers', room.players);
    if (room.gamePhase === 'SEEKING') ts_checkReveal(room);
    pp_recheckProgress(room);
    transferHostIfNeeded(room);
    broadcastGameState(room);
    console.log(`👋 ${name} evicted from ${room.code}`);
    if (Object.keys(room.players).length === 0) clearAndDeleteRoom(room);
}

function clearAndDeleteRoom(room) {
    clearInterval(room.gameTimer); clearTimeout(room.revealTimer);
    clearInterval(room.sqTimer);   clearTimeout(room.sqTimer);
    clearInterval(room.ppTimer);   clearTimeout(room.ppTimer);
    clearInterval(room.rrTimer);   clearTimeout(room.rrTimer);
    clearInterval(room.scTimer);   clearTimeout(room.scTimer);
    clearInterval(room.bbTimer);   clearTimeout(room.bbTimer);
    delete rooms[room.code];
    console.log(`🗑️  Room ${room.code} removed`);
}

function socketRoom(socket) {
    for (const code of socket.rooms) {
        if (code !== socket.id && rooms[code]) return rooms[code];
    }
    return null;
}

function broadcastRoom(room, event, data) {
    io.to(room.code).emit(event, data);
}

function broadcastGameState(room) {
    broadcastRoom(room, 'gameState', {
        phase: room.gamePhase,
        timeLeft: room.timeLeft,
        seekerSocketId: room.seekerSocketId,
        seekerSocketIds: room.seekerSocketIds,
        hostSocketId: room.hostSocketId,
        pokesLeft: room.seekerPokesLeft,
        selectedGame: room.selectedGame,
    });
}

function broadcastScores(room) {
    broadcastRoom(room, 'updateScores', Object.values(room.scores));
}

function isHost(room, socket) {
    if (!room.hostSocketId) {
        room.hostSocketId = socket.id;
        room.hostToken = (room.players[socket.id] && room.players[socket.id].token) || socket.id;
    }
    return socket.id === room.hostSocketId;
}

function transferHostIfNeeded(room) {
    if (room.hostSocketId) return; // still has a host
    const next = Object.entries(room.players).find(([, p]) => !p.disconnected)?.[0];
    if (!next) return;
    room.hostSocketId = next;
    room.hostToken = room.players[next]?.token || next;
    broadcastRoom(room, 'hostChanged', { hostSocketId: next });
    console.log(`👑 Host transferred to ${room.players[next]?.name} in room ${room.code}`);
}

// ─── Reconnect support ────────────────────────────────────────────────────────

// When a player gets a new socket.id on reconnect, any per-game state keyed by
// their old socket.id is orphaned. This re-points every known map/field.
// Must run BEFORE the old id's records are deleted.
function rekeySocketState(room, oldId, newId) {
    if (!oldId || oldId === newId) return;
    const maps = [
        'avatars', 'lastReactionTimes', 'seekerPokes', 'seekerCameras', 'viewportPoints',
        'ppPlayerPhotos', 'ppReady', 'ppHands', 'ppVotes', 'ppSubUsed',
        'sqSquiggles', 'sqHistories', 'sqVotes', 'sqScores',
        'rrPlayerFills', 'rrFillReady', 'rrPlayerRecordings', 'rrRecordReady',
        'bbSamples', 'bbDigOptions', 'bbChops', 'bbSpitFills', 'bbFlowPreset',
        'bbAdlibs', 'bbVotes', 'bbRoundScores', 'bbCumScores',
    ];
    maps.forEach(key => {
        if (room[key] && Object.prototype.hasOwnProperty.call(room[key], oldId)) {
            room[key][newId] = room[key][oldId];
            delete room[key][oldId];
        }
    });
    if (room.ppStorytellerId === oldId) room.ppStorytellerId = newId;
    if (Array.isArray(room.ppStorytellerIds)) {
        room.ppStorytellerIds = room.ppStorytellerIds.map(id => id === oldId ? newId : id);
    }
    if (Array.isArray(room.ppTable)) {
        room.ppTable.forEach(c => { if (c.submitterId === oldId) c.submitterId = newId; });
    }
    if (room.sqByeId === oldId) room.sqByeId = newId;
    if (Array.isArray(room.sqMatchups)) {
        room.sqMatchups.forEach(m => {
            if (m.p1Id === oldId) m.p1Id = newId;
            if (m.p2Id === oldId) m.p2Id = newId;
        });
    }
    if (room.bbByeId === oldId) room.bbByeId = newId;
    if (Array.isArray(room.bbMatchups)) {
        room.bbMatchups.forEach(m => {
            if (m.p1Id === oldId) m.p1Id = newId;
            if (m.p2Id === oldId) m.p2Id = newId;
        });
    }
    if (Array.isArray(room.scTeams)) {
        room.scTeams.forEach(t => {
            if (t.executorId === oldId) t.executorId = newId;
            if (t.instructorId === oldId) t.instructorId = newId;
        });
    }
    if (Array.isArray(room.rrBattles)) {
        room.rrBattles.forEach(b => {
            if (b.p1 === oldId) b.p1 = newId;
            if (b.p2 === oldId) b.p2 = newId;
            if (b.votes && Object.prototype.hasOwnProperty.call(b.votes, oldId)) {
                b.votes[newId] = b.votes[oldId];
                delete b.votes[oldId];
            }
        });
    }
    if (room.scPyroId === oldId) room.scPyroId = newId;
}

// Builds a snapshot of where this player is in the active round.
// Sent on every (re)join so the client can restore the correct screen.
function buildFullSnapshot(room, socket) {
    const base = { gamePhase: room.gamePhase, selectedGame: room.selectedGame, timeLeft: room.timeLeft };
    switch (room.selectedGame) {
        case 'tacostealth':
            return { ...base, ts: {
                isSeeker: room.seekerSocketIds.includes(socket.id),
                isDead: !!(room.players[socket.id] && room.players[socket.id].isDead),
                pokesLeft: room.seekerPokes[socket.id] ?? room.seekerPokesLeft,
            }};
        case 'strokeoff':
            return { ...base, so: {
                phase: room.strokePhase,
                theme: room.strokeTheme,
                painting: room.strokePainting,
                myPart: room.strokePlayerParts[socket.id] || null,
                hasVoted: !!room.strokeVotes[socket.id],
            }};
        case 'squiggle': {
            const matchup = (room.sqMatchups || [])[room.sqCurrentMatchup] || null;
            return { ...base, sq: {
                phase: room.sqPhase, round: room.sqRound, matchup,
                myHistory: room.sqHistories[socket.id] || [],
                mySquiggle: room.sqSquiggles[socket.id] || null,
                hasVoted: !!room.sqVotes[socket.id],
                timeLeft: room.sqTimeLeft,
            }};
        }
        case 'pikpic':
            return { ...base, pp: {
                phase: room.ppPhase, round: room.ppRound,
                storytellerId: room.ppStorytellerId,
                storytellerIds: room.ppStorytellerIds,
                isStoryteller: socket.id === room.ppStorytellerId,
                clue: room.ppClue,
                table: room.ppTable,
                hand: room.ppHands[socket.id] || [],
                hasSubmitted: (room.ppTable || []).some(c => c.submitterId === socket.id),
                hasVoted: !!room.ppVotes[socket.id],
                timeLeft: room.ppTimeLeft,
            }};
        case 'rizzorroast': {
            const battle = (room.rrBattles || [])[room.rrCurrentBattle] || null;
            return { ...base, rr: {
                phase: room.rrPhase, template: room.rrTemplate,
                myFills: room.rrPlayerFills[socket.id] || null,
                fillReady: !!room.rrFillReady[socket.id],
                recordReady: !!room.rrRecordReady[socket.id],
                battle,
                hasVoted: !!(battle && battle.votes && battle.votes[socket.id]),
                timeLeft: room.rrTimeLeft,
            }};
        }
        case 'splitcrew': {
            const myTeam = (room.scTeams || []).find(t => t.executorId === socket.id || t.instructorId === socket.id) || null;
            return { ...base, sc: {
                phase: room.scPhase, lap: room.scLap,
                isPyro: socket.id === room.scPyroId,
                role: myTeam ? (myTeam.executorId === socket.id ? 'executor' : 'instructor') : null,
                team: myTeam, timeLeft: room.scTimeLeft,
            }};
        }
        case 'beatbattle':
            return { ...base, bb: { phase: room.bbPhase, timeLeft: room.bbTimeLeft } };
        default:
            return base;
    }
}

// ─── Taco Stealth game logic ──────────────────────────────────────────────────

function ts_tallyScores(room) {
    const hiders = Object.values(room.players).filter(p => !room.seekerSocketIds.includes(p.id));
    hiders.filter(p => !p.isDead).forEach(p => {
        if (!room.scores[p.name]) room.scores[p.name] = { name: p.name, survivals: 0, catches: 0, spotlight: 0 };
        room.scores[p.name].survivals += 1;
    });
    // Fold "spotlight" viewport points (being watched without being found) into scores
    Object.entries(room.viewportPoints || {}).forEach(([sid, pts]) => {
        const pl = room.players[sid]; if (!pl) return;
        if (!room.scores[pl.name]) room.scores[pl.name] = { name: pl.name, survivals: 0, catches: 0, spotlight: 0 };
        room.scores[pl.name].spotlight = (room.scores[pl.name].spotlight || 0) + (pts || 0);
    });
    broadcastScores(room);
}

function ts_enterReveal(room) {
    clearInterval(room.gameTimer);
    clearInterval(room.viewportTick); room.viewportTick = null;
    room.gamePhase = 'REVEAL';
    ts_tallyScores(room);
    room.timeLeft = 15;
    broadcastGameState(room);
    room.gameTimer = setInterval(() => {
        room.timeLeft--;
        if (room.timeLeft <= 0) { clearInterval(room.gameTimer); ts_returnToLobby(room); return; }
        broadcastGameState(room);
    }, 1000);
}

function ts_returnToLobby(room) {
    clearInterval(room.gameTimer);
    clearInterval(room.viewportTick); room.viewportTick = null;
    room.gamePhase = 'LOBBY';
    room.timeLeft = 0;
    room.seekerSocketId = null;
    room.seekerToken = null;
    room.seekerSocketIds = [];
    room.seekerPokes = {};
    room.seekerPokesLeft = 0;
    room.seekerCameras = {};
    room.viewportPoints = {};
    Object.values(room.players).forEach(p => { p.isDead = false; });
    for (const t in room.playerState) delete room.playerState[t];
    broadcastRoom(room, 'updatePlayers', room.players);
    broadcastGameState(room);
}

function ts_checkReveal(room) {
    const hiders = Object.values(room.players).filter(p => !room.seekerSocketIds.includes(p.id) && !p.disconnected);
    if (hiders.length === 0 || hiders.every(p => p.isDead)) ts_enterReveal(room);
}

// Transition HIDING → SEEKING (from the hide timer or an early all-locked-in)
function ts_startSeeking(room) {
    if (room.gamePhase === 'SEEKING') return;
    clearInterval(room.gameTimer);
    room.gamePhase = 'SEEKING';
    room.timeLeft = room.lastSeekTime;
    broadcastGameState(room);

    clearInterval(room.viewportTick);
    room.viewportTick = setInterval(() => {
        if (room.gamePhase !== 'SEEKING') { clearInterval(room.viewportTick); return; }
        const cams = Object.values(room.seekerCameras);
        if (!cams.length) return;
        const gains = {};
        Object.values(room.players).forEach(h => {
            if (room.seekerSocketIds.includes(h.id) || h.isDead) return;
            const cx = (h.x || 0) + 37, cy = (h.y || 0) + 37;
            let gain = 0, watchers = 0;
            cams.forEach(cam => {
                if (!cam.scale || !cam.screenW) return;
                const wx = -cam.x / cam.scale, wy = -cam.y / cam.scale;
                const ww = cam.screenW / cam.scale, wh = cam.screenH / cam.scale;
                if (cx >= wx && cx <= wx + ww && cy >= wy && cy <= wy + wh) {
                    watchers++;
                    gain += Math.max(1, Math.round(cam.scale * 5));
                }
            });
            if (watchers > 1) gain = Math.round(gain * (1 + 0.5 * (watchers - 1)));
            if (gain > 0) {
                if (!room.viewportPoints[h.id]) room.viewportPoints[h.id] = 0;
                room.viewportPoints[h.id] += gain;
                gains[h.id] = gain;
            }
        });
        broadcastRoom(room, 'viewportPoints', { totals: room.viewportPoints, gains });
    }, 350);

    room.gameTimer = setInterval(() => {
        room.timeLeft--;
        if (room.timeLeft <= 0) { ts_enterReveal(room); return; }
        broadcastGameState(room);
    }, 1000);
}

// ─── Stroke Off game logic ────────────────────────────────────────────────────

// All images are local files under public/memes/ (committed to the repo — small enough that a
// gitignored cache-build step like Bad Pitches' audio isn't needed). Previously these were live
// hotlinks to i.imgflip.com; one (This Is Fine) had already gone dead (404 via Cloudflare) by the
// time this was checked, silently breaking that meme in-game with no error surfaced anywhere.
// Local files fix reliability, rendering consistency, AND offline/Spawnpoint play in one move.
const PAINTINGS = [
    { title: 'Distracted Boyfriend', artist: 'Antonio Guillem · 2017', imageUrl: '/memes/distracted-boyfriend.jpg' },
    { title: 'Drake Approving / Disapproving', artist: 'Hotline Bling · 2016', imageUrl: '/memes/drake.jpg' },
    { title: 'Woman Yelling at Cat', artist: 'Real Housewives · 2019', imageUrl: '/memes/woman-yelling-at-cat.jpg' },
    { title: 'This Is Fine', artist: 'K.C. Green · 2013', imageUrl: '/memes/this-is-fine.jpg' },
    { title: 'Two Buttons', artist: 'Jake Clark · 2016', imageUrl: '/memes/two-buttons.jpg' },
    { title: 'Spider-Man Pointing', artist: 'Spider-Man TV · 1967', imageUrl: '/memes/spiderman-pointing.jpg' },
    { title: 'Change My Mind', artist: 'Steven Crowder · 2018', imageUrl: '/memes/change-my-mind.jpg' },
    { title: 'Surprised Pikachu', artist: 'Pokémon Anime · 2018', imageUrl: '/memes/surprised-pikachu.jpg' },
    { title: 'Gru\'s Plan', artist: 'Despicable Me · 2010', imageUrl: '/memes/grus-plan.jpg' },
    { title: 'Expanding Brain', artist: 'Internet · 2017', imageUrl: '/memes/expanding-brain.jpg' },
    { title: 'Disaster Girl', artist: 'Dave Roth · 2007', imageUrl: '/memes/disaster-girl.jpg' },
    { title: 'Doge', artist: 'Kabosu the Shiba · 2013', imageUrl: '/memes/doge.jpg' },
    { title: 'One Does Not Simply', artist: 'Lord of the Rings · 2001', imageUrl: '/memes/one-does-not-simply.jpg' },
    { title: 'Success Kid', artist: 'Sammy Griner · 2007', imageUrl: '/memes/success-kid.jpg' },
    { title: 'Bad Luck Brian', artist: 'Kyle Craven · 2012', imageUrl: '/memes/bad-luck-brian.jpg' },
    { title: 'That Would Be Great', artist: 'Office Space · 1999', imageUrl: '/memes/that-would-be-great.jpg' },
    { title: 'Roll Safe', artist: 'Ted Kalidis · 2015', imageUrl: '/memes/roll-safe.jpg' },
    { title: 'Hide the Pain Harold', artist: 'András Arató · 2011', imageUrl: '/memes/hide-the-pain-harold.jpg' },
    { title: 'Mocking SpongeBob', artist: 'SpongeBob SquarePants · 2017', imageUrl: '/memes/mocking-spongebob.jpg' },
    { title: 'Ancient Aliens Guy', artist: 'Ancient Aliens (History Channel) · 2010', imageUrl: '/memes/ancient-aliens.jpg' },
    { title: 'Is This a Pigeon', artist: 'The Brave Police: Patlabor · 2018', imageUrl: '/memes/is-this-a-pigeon.jpg' },
    { title: 'Y U No', artist: 'Internet · 2011', imageUrl: '/memes/y-u-no.jpg' },
    { title: 'Grumpy Cat', artist: 'Tardar Sauce · 2012', imageUrl: '/memes/grumpy-cat.jpg' },
    { title: 'Philosoraptor', artist: 'Internet · 2008', imageUrl: '/memes/philosoraptor.jpg' },
    { title: 'Epic Handshake', artist: 'Internet · 2013', imageUrl: '/memes/epic-handshake.jpg' },
    { title: 'Waiting Skeleton', artist: 'Internet · 2013', imageUrl: '/memes/waiting-skeleton.jpg' },
    { title: 'First World Problems', artist: 'Internet · 2012', imageUrl: '/memes/first-world-problems.jpg' },
    { title: 'Unsettled Tom', artist: 'Tom and Jerry · 2020', imageUrl: '/memes/unsettled-tom.jpg' },
];

const MEMORIZE_SECONDS = 20;
const DRAW_SECONDS = 75;

// Divides the image into just enough grid cells for `n` real players — never fewer than needed,
// so no two players are ever assigned the same fragment (the old hardcoded-8-parts array used to
// wrap via modulo past 8 players, silently handing out duplicate fragments and breaking the
// deception mechanic). Cell fractions (0-1) are resolution-independent; the client multiplies by
// whatever size the image actually renders at.
function so_computeGrid(n) {
    n = Math.max(1, n);
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    const cells = [];
    for (let r = 0; r < rows && cells.length < n; r++) {
        for (let c = 0; c < cols && cells.length < n; c++) {
            cells.push({ x: c / cols, y: r / rows, w: 1 / cols, h: 1 / rows, label: so_cellLabel(r, c, rows, cols) });
        }
    }
    return cells;
}
function so_cellLabel(r, c, rows, cols) {
    const v = rows <= 1 ? '' : r === 0 ? 'top' : r === rows - 1 ? 'bottom' : 'middle';
    const h = cols <= 1 ? '' : c === 0 ? 'left' : c === cols - 1 ? 'right' : 'center';
    return [v, h].filter(Boolean).join('-') || 'center';
}

function so_startDrawing(room, fakeId) {
    const painting = PAINTINGS[Math.random() * PAINTINGS.length | 0];
    room.strokePainting = painting;
    room.strokePrompt = painting.title;
    room.strokeTheme = { emoji: '🤣', theme: painting.title };
    room.strokeFakeId = fakeId;
    room.strokeHistory = [];
    room.strokeVotes = {};
    room.strokePhase = 'MEMORIZE';
    room.strokePlayerParts = {};

    // One grid cell per real player — always enough cells, so fragments never repeat.
    const realIds = Object.keys(room.players).filter(sid => sid !== fakeId);
    const grid = so_computeGrid(realIds.length);
    realIds.forEach((sid, i) => { room.strokePlayerParts[sid] = grid[i]; });

    // The fake gets the exact same UI treatment (a highlighted fragment to study and draw) so
    // there's no "blank prompt" tell in the interface itself — but their fragment is silently
    // pulled from a DIFFERENT, randomly chosen meme. They confidently draw something plausible
    // that just won't quite match anything in the real image once everyone's work is compared
    // during voting — a real (if subtle) mismatch to catch, instead of an obvious empty slot.
    if (fakeId) {
        const decoyPool = PAINTINGS.filter(p => p !== painting);
        const decoyPainting = decoyPool.length ? decoyPool[Math.random() * decoyPool.length | 0] : painting;
        const decoyGrid = so_computeGrid(Math.max(1, realIds.length));
        const decoyCell = decoyGrid[Math.random() * decoyGrid.length | 0];
        room.strokePlayerParts[fakeId] = { ...decoyCell, decoyImageUrl: decoyPainting.imageUrl, isFake: true };
    }

    // Send painting + individual part to each player (the fake's imageUrl points at the decoy)
    Object.keys(room.players).forEach(sid => {
        const part = room.strokePlayerParts[sid];
        io.to(sid).emit('soShowPainting', {
            imageUrl: (part && part.isFake) ? part.decoyImageUrl : painting.imageUrl,
            title: painting.title,
            artist: painting.artist,
            yourPart: part || null,
            memorizeSeconds: MEMORIZE_SECONDS,
        });
    });

    // After memorize window, start the actual drawing phase
    room.revealTimer = setTimeout(() => so_beginDrawing(room), MEMORIZE_SECONDS * 1000);
}

function so_beginDrawing(room) {
    clearTimeout(room.revealTimer);
    room.strokePhase = 'DRAWING';
    room.timeLeft = DRAW_SECONDS;

    Object.keys(room.players).forEach(sid => {
        io.to(sid).emit('soBeginDrawing', {
            prompt: room.strokePrompt,
            part: room.strokePlayerParts[sid] || null,
        });
    });

    broadcastRoom(room, 'strokePhaseChange', { phase: 'DRAWING', timeLeft: DRAW_SECONDS });
    room.gameTimer = setInterval(() => {
        room.timeLeft--;
        broadcastRoom(room, 'strokePhaseChange', { phase: 'DRAWING', timeLeft: room.timeLeft });
        if (room.timeLeft <= 0) { clearInterval(room.gameTimer); so_startReveal(room); }
    }, 1000);
}

const SO_REVEAL_MS = 4500; // per-player reveal window

function so_startReveal(room) {
    clearInterval(room.gameTimer);
    clearTimeout(room.revealTimer);
    room.strokePhase = 'REVEAL';

    const players = Object.values(room.players).map(p => ({ id: p.id, name: p.name, token: p.token }));
    broadcastRoom(room, 'soRevealBegin', {
        history: room.strokeHistory,
        players,
        prompt: room.strokePrompt,
        emoji: room.strokeTheme ? room.strokeTheme.emoji : '',
    });

    let idx = 0;
    function sendNext() {
        if (idx >= players.length) { so_openVoting(room); return; }
        broadcastRoom(room, 'soRevealNext', { player: players[idx], idx, total: players.length });
        idx++;
        room.revealTimer = setTimeout(sendNext, SO_REVEAL_MS);
    }
    room.revealTimer = setTimeout(sendNext, 700);
}

const SO_VOTE_DURATION = 20;

function so_openVoting(room) {
    clearTimeout(room.revealTimer);
    room.strokePhase = 'VOTE';
    room.strokeVotes = {};
    room.timeLeft = SO_VOTE_DURATION;

    const players = Object.values(room.players).map(p => ({ id: p.id, name: p.name, token: p.token }));
    broadcastRoom(room, 'soVoteOpen', { players, prompt: room.strokePrompt, emoji: room.strokeTheme ? room.strokeTheme.emoji : '', timeLeft: SO_VOTE_DURATION });

    room.gameTimer = setInterval(() => {
        room.timeLeft--;
        broadcastRoom(room, 'strokePhaseChange', { phase: 'VOTE', timeLeft: room.timeLeft });
        if (room.timeLeft <= 0) { clearInterval(room.gameTimer); so_resolveVotes(room); }
    }, 1000);
}

function so_resolveVotes(room) {
    clearInterval(room.gameTimer);
    clearTimeout(room.revealTimer);
    room.strokePhase = 'RESULT';

    const tallies = {};
    Object.values(room.strokeVotes).forEach(id => { tallies[id] = (tallies[id] || 0) + 1; });

    let maxVotes = 0, mostVotedId = null;
    Object.entries(tallies).forEach(([id, count]) => { if (count > maxVotes) { maxVotes = count; mostVotedId = id; } });

    const fakeId = room.strokeFakeId;
    const fakeCaught = mostVotedId === fakeId && maxVotes > 0;

    // Update persistent SO scores
    Object.values(room.players).forEach(p => {
        if (!room.soScores[p.name]) room.soScores[p.name] = { name: p.name, correct: 0, fakeWins: 0 };
        if (p.id === fakeId) {
            if (!fakeCaught) room.soScores[p.name].fakeWins++;
        } else {
            if (room.strokeVotes[p.id] === fakeId) room.soScores[p.name].correct++;
        }
    });

    const players = Object.values(room.players).map(p => ({ id: p.id, name: p.name, token: p.token }));
    broadcastRoom(room, 'soVoteResult', {
        fakeId,
        fakeName: room.players[fakeId] ? room.players[fakeId].name : '???',
        fakeCaught,
        tallies,
        players,
        soScores: Object.values(room.soScores),
    });

    room.revealTimer = setTimeout(() => so_returnToLobby(room), 9000);
}

function so_returnToLobby(room) {
    clearTimeout(room.revealTimer);
    clearInterval(room.gameTimer);
    room.strokePhase = 'LOBBY';
    room.strokePrompt = null;
    room.strokeTheme = null;
    room.strokeFakeId = null;
    room.strokePainting = null;
    room.strokeHistory = [];
    room.strokeVotes = {};
    room.strokePlayerParts = {};
    room.gamePhase = 'LOBBY';
    broadcastGameState(room);
    if (Object.keys(room.soScores).length > 0) {
        broadcastRoom(room, 'updateSoScores', Object.values(room.soScores));
    }
}

// ─── Stroke Off (squiggle) game logic ─────────────────────────────────────────

const SQ_DRAW_SECONDS = 75;

const SQ_PROMPTS = [
    "The world's worst pet",
    "Something you'd find under a couch",
    "A vehicle that should not exist",
    "What aliens think humans do for fun",
    "The worst superhero power",
    "Something that woke you up at 3am",
    "Your spirit animal (but ugly)",
    "A food that sounds fake but isn't",
    "The most suspicious cloud",
    "Something you'd regret ordering online",
    "A creature from the deep sea (make one up)",
    "The worst possible birthday cake",
    "Something you'd find in grandma's attic",
    "A sport that deserves to be banned",
    "The saddest thing at a carnival",
    "A machine that solves a problem nobody has",
    "What's inside a piñata from the dollar store",
    "The last thing you'd want to find in your shoe",
    "A logo for a business that will definitely fail",
    "Something that would terrify a medieval peasant",
    "The world's worst warning label",
    "A pet that is technically legal but shouldn't be",
    "Something you'd find in a wizard's trash can",
    "The most dangerous fruit",
    "What ghosts do when nobody's watching",
    "A gym built for ghosts",
    "The world's most confused robot",
    "A snack that betrayed your trust",
    "What your car thinks about your driving",
    "A dating profile picture gone wrong",
    "The friend group's designated gremlin",
    "A weather pattern that shouldn't exist",
    "Something a toddler would trade you for candy",
    "The final boss of laundry day",
    "A houseplant with a chip on its shoulder",
    "What lives in the office break room fridge",
    "A superhero whose only power is mild inconvenience",
    "The instruction manual's final warning, illustrated",
    "Something that escaped from a middle school science fair",
    "A rejected cartoon mascot",
    "The thing that goes bump in the night (it's actually dumb)",
    "A mascot for a company that is definitely a scam",
    "What your search history looks like as a creature",
    "A vacation destination nobody asked for",
    "The last cookie in the jar, having feelings about it",
    "A gadget that solves a problem nobody has",
    "Something a raccoon would 100% steal from you",
    "The world's least trustworthy lifeguard",
    "A holiday that got cancelled for a very good reason",
    "What your GPS is thinking right now",
    "A knockoff version of a famous cartoon character",
    "The group chat's most unhinged member, as an animal",
    "A wizard's Yelp review",
    "Two rocks in a committed relationship",
    "A sneeze, caught mid-sneeze",
    "The forbidden button nobody should press",
    "A staring contest between a cat and a vacuum",
    "Grandma's secret weapon",
    "A hug between mortal enemies",
    "The last slice of pizza, having feelings about it",
    "A traffic cone living its best life",
    "Two socks that lost their match, years later",
    "A snowman's summer vacation photo",
    "The bravest squirrel in recorded history",
    "A handshake that has gone on way too long",
    "Your alarm clock, plotting its revenge",
    "A tiny, personal apocalypse",
    "The tooth fairy's side hustle",
    "A cloud filing a formal complaint",
    "Two strangers who just made unbearable eye contact",
    "A doorbell that regrets its life choices",
    "The world's least convincing disguise",
    "A fork that has simply given up",
    "Someone's houseplant staging a coup",
    "A pigeon with a business plan",
    "The last balloon at the party, alone",
    "A high-five gone horribly wrong",
];

// Canvas is a tall portrait rect (450x800) — the renderer (sqDrawSquiggle in public/index.html)
// draws a smooth bezier through exactly 4 points, or a straight connect-the-dots polyline for any
// other point count. Picking a random archetype (instead of always the same jittered wave) gives
// genuinely different shapes to draw around round to round, not just different jitter on one shape.
function sqWave() {
    const pts = [];
    for (let i = 0; i < 4; i++) {
        pts.push({ x: i * 0.28 + 0.08 + Math.random() * 0.08, y: 0.22 + Math.random() * 0.56 });
    }
    return pts;
}
function sqZigzag() {
    const n = 5 + Math.floor(Math.random() * 2); // 5 or 6 points -> straight segments, not bezier
    const pts = [];
    let high = Math.random() < 0.5;
    for (let i = 0; i < n; i++) {
        pts.push({
            x: 0.1 + (i / (n - 1)) * 0.8,
            y: high ? 0.16 + Math.random() * 0.14 : 0.7 + Math.random() * 0.14,
        });
        high = !high;
    }
    return pts;
}
function sqSpiral() {
    const n = 7;
    const pts = [];
    const cx = 0.4 + Math.random() * 0.2, cy = 0.4 + Math.random() * 0.2;
    const dir = Math.random() < 0.5 ? 1 : -1;
    for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        const angle = dir * t * Math.PI * 2.3;
        const r = 0.04 + t * 0.16;
        // x is scaled up (not just r*1.6) to counter the tall/narrow 450x800 canvas so the spiral
        // reads as round rather than a tall oval; clamped afterward as a hard safety net.
        pts.push({
            x: Math.max(0.06, Math.min(0.94, cx + Math.cos(angle) * r * 1.6)),
            y: Math.max(0.14, Math.min(0.86, cy + Math.sin(angle) * r)),
        });
    }
    return pts;
}
function sqSwoop() {
    const flip = Math.random() < 0.5;
    const y0 = flip ? 0.78 : 0.2, y3 = flip ? 0.2 : 0.78;
    return [
        { x: 0.1 + Math.random() * 0.06, y: y0 + (Math.random() - 0.5) * 0.1 },
        { x: 0.34 + Math.random() * 0.1, y: 0.5 + (Math.random() - 0.5) * 0.35 },
        { x: 0.6 + Math.random() * 0.1, y: 0.5 + (Math.random() - 0.5) * 0.35 },
        { x: 0.86 + Math.random() * 0.06, y: y3 + (Math.random() - 0.5) * 0.1 },
    ];
}
function sqScribble() {
    const n = 6 + Math.floor(Math.random() * 3); // 6-8 points -> straight segments
    const pts = [];
    let x = 0.1, y = 0.25 + Math.random() * 0.5;
    for (let i = 0; i < n; i++) {
        pts.push({ x: Math.max(0.06, Math.min(0.94, x)), y: Math.max(0.14, Math.min(0.86, y)) });
        x += 0.78 / n + (Math.random() - 0.3) * 0.08;
        y += (Math.random() - 0.5) * 0.32;
    }
    return pts;
}
function sqHook() {
    const corners = [{ x: 0.14, y: 0.18 }, { x: 0.86, y: 0.18 }, { x: 0.14, y: 0.82 }, { x: 0.86, y: 0.82 }];
    const c = corners[Math.floor(Math.random() * corners.length)];
    return [
        { x: 0.5 + (Math.random() - 0.5) * 0.2, y: 0.5 + (Math.random() - 0.5) * 0.15 },
        { x: 0.5 + (c.x - 0.5) * 0.55, y: 0.5 + (c.y - 0.5) * 0.55 },
        { x: c.x + (Math.random() - 0.5) * 0.06, y: c.y + (Math.random() - 0.5) * 0.06 },
    ];
}
const SQ_ARCHETYPES = [sqWave, sqZigzag, sqSpiral, sqSwoop, sqScribble, sqHook];
function generateSquiggle() {
    return SQ_ARCHETYPES[Math.floor(Math.random() * SQ_ARCHETYPES.length)]();
}

function sq_seedMatchups(room) {
    const pids = Object.keys(room.players).sort(() => Math.random() - 0.5);
    const matchups = [];
    for (let i = 0; i + 1 < pids.length; i += 2)
        matchups.push({ p1Id: pids[i], p2Id: pids[i+1], winner: null, p1Votes: 0, p2Votes: 0 });
    return { matchups, byeId: pids.length % 2 === 1 ? pids[pids.length-1] : null };
}

function sq_startRound(room, round) {
    room.sqRound = round;
    room.sqHistories = {};
    room.sqVotes = {};
    room.sqCurrentMatchup = 0;
    room.sqPhase = 'DRAW';
    room.sqSquiggles = {};
    const { matchups, byeId } = sq_seedMatchups(room);
    room.sqByeId = byeId;
    const pointValue = round;

    if (round === 1) {
        const prompt = SQ_PROMPTS[Math.floor(Math.random() * SQ_PROMPTS.length)];
        Object.keys(room.players).forEach(id => { room.sqSquiggles[id] = generateSquiggle(); });
        room.sqMatchups = matchups.map(m => ({ ...m, prompt, pointValue }));
        Object.keys(room.players).forEach(id => {
            io.to(id).emit('sqBeginDraw', { round, prompt, squiggle: room.sqSquiggles[id], timeLeft: SQ_DRAW_SECONDS, byeThisRound: id === byeId });
        });
    } else if (round === 2) {
        const usedPrompts = new Set();
        room.sqMatchups = matchups.map(m => {
            let prompt;
            do { prompt = SQ_PROMPTS[Math.floor(Math.random() * SQ_PROMPTS.length)]; }
            while (usedPrompts.has(prompt) && usedPrompts.size < SQ_PROMPTS.length);
            usedPrompts.add(prompt);
            const sq = generateSquiggle();
            room.sqSquiggles[m.p1Id] = sq;
            room.sqSquiggles[m.p2Id] = sq;
            return { ...m, prompt, pointValue };
        });
        if (byeId) room.sqSquiggles[byeId] = generateSquiggle();
        Object.keys(room.players).forEach(id => {
            const m = room.sqMatchups.find(m => m.p1Id === id || m.p2Id === id);
            io.to(id).emit('sqBeginDraw', { round, prompt: m ? m.prompt : SQ_PROMPTS[0], squiggle: room.sqSquiggles[id], timeLeft: SQ_DRAW_SECONDS, byeThisRound: id === byeId });
        });
    } else {
        const prompt = SQ_PROMPTS[Math.floor(Math.random() * SQ_PROMPTS.length)];
        const sq = generateSquiggle();
        Object.keys(room.players).forEach(id => { room.sqSquiggles[id] = sq; });
        room.sqMatchups = matchups.map(m => ({ ...m, prompt, pointValue }));
        broadcastRoom(room, 'sqBeginDraw', { round, prompt, squiggle: sq, timeLeft: SQ_DRAW_SECONDS, byeThisRound: false });
    }

    if (byeId) room.sqScores[byeId] = (room.sqScores[byeId] || 0) + pointValue;

    room.sqTimeLeft = SQ_DRAW_SECONDS;
    room.sqTimer = setInterval(() => {
        room.sqTimeLeft--;
        broadcastRoom(room, 'sqTimer', { timeLeft: room.sqTimeLeft, phase: 'DRAW' });
        if (room.sqTimeLeft <= 0) { clearInterval(room.sqTimer); sq_beginBattle(room); }
    }, 1000);
}

function sq_beginBattle(room) {
    room.sqPhase = 'BATTLE';
    room.sqCurrentMatchup = 0;
    sq_nextMatchup(room);
}

function sq_nextMatchup(room) {
    if (room.sqCurrentMatchup >= room.sqMatchups.length) { sq_endRound(room); return; }
    const m = room.sqMatchups[room.sqCurrentMatchup];
    const p1 = room.players[m.p1Id], p2 = room.players[m.p2Id];
    broadcastRoom(room, 'sqBattleBegin', {
        matchupIdx: room.sqCurrentMatchup,
        round: room.sqRound,
        pointValue: m.pointValue,
        prompt: m.prompt,
        total: room.sqMatchups.length,
        p1: { id: m.p1Id, name: p1 ? p1.name : '?', color: p1 ? p1.color : '#fff', history: room.sqHistories[m.p1Id] || [], squiggle: room.sqSquiggles[m.p1Id] },
        p2: { id: m.p2Id, name: p2 ? p2.name : '?', color: p2 ? p2.color : '#fff', history: room.sqHistories[m.p2Id] || [], squiggle: room.sqSquiggles[m.p2Id] },
    });
    room.sqTimer = setTimeout(() => sq_openVoting(room), 10000);
}

function sq_openVoting(room) {
    room.sqVotes = {};
    let t = 8;
    broadcastRoom(room, 'sqVoteOpen', { timeLeft: t });
    room.sqTimer = setInterval(() => {
        t--;
        broadcastRoom(room, 'sqTimer', { timeLeft: t, phase: 'VOTE' });
        if (t <= 0) { clearInterval(room.sqTimer); sq_resolveMatchup(room); }
    }, 1000);
}

function sq_resolveMatchup(room) {
    clearInterval(room.sqTimer); clearTimeout(room.sqTimer);
    const m = room.sqMatchups[room.sqCurrentMatchup];
    let p1Votes = 0, p2Votes = 0;
    Object.values(room.sqVotes).forEach(v => { if (v === 'p1') p1Votes++; else if (v === 'p2') p2Votes++; });
    m.p1Votes = p1Votes; m.p2Votes = p2Votes;
    let winnerId = null;
    if (p1Votes > p2Votes) { winnerId = m.p1Id; m.winner = 'p1'; }
    else if (p2Votes > p1Votes) { winnerId = m.p2Id; m.winner = 'p2'; }
    if (winnerId) room.sqScores[winnerId] = (room.sqScores[winnerId] || 0) + m.pointValue;
    broadcastRoom(room, 'sqMatchupResult', { matchupIdx: room.sqCurrentMatchup, winnerId, p1Votes, p2Votes, pointValue: m.pointValue, scores: room.sqScores });
    room.sqCurrentMatchup++;
    room.sqTimer = setTimeout(() => sq_nextMatchup(room), 3000);
}

function sq_endRound(room) {
    room.sqPhase = 'ROUND_END';
    const isLast = room.sqRound >= 3;
    const playerMap = {};
    Object.values(room.players).forEach(p => { playerMap[p.id] = { name: p.name, color: p.color }; });
    broadcastRoom(room, 'sqRoundEnd', { round: room.sqRound, scores: room.sqScores, players: playerMap, final: isLast });
    if (isLast) {
        room.sqTimer = setTimeout(() => sq_returnToLobby(room), 12000);
    } else {
        room.sqTimer = setTimeout(() => sq_startRound(room, room.sqRound + 1), 6000);
    }
}

function sq_returnToLobby(room) {
    clearInterval(room.sqTimer); clearTimeout(room.sqTimer);
    room.sqPhase = 'LOBBY'; room.sqRound = 0; room.sqSquiggles = {};
    room.sqMatchups = []; room.sqHistories = {}; room.sqVotes = {};
    room.sqCurrentMatchup = 0; room.sqByeId = null; room.sqTimeLeft = 0;
    room.gamePhase = 'LOBBY';
    broadcastGameState(room);
}

// ─── PikPic game logic ────────────────────────────────────────────────────────────

const PP_CLUE_SECONDS   = 60;
const PP_SUBMIT_SECONDS = 60;
const PP_VOTE_SECONDS   = 30;
const PP_RESULT_SECONDS = 10;

// Reliable picsum.photos images — seed keeps them consistent across sessions
const PP_CURATED = [
    'https://picsum.photos/seed/pp01/400/400',
    'https://picsum.photos/seed/pp02/400/400',
    'https://picsum.photos/seed/pp03/400/400',
    'https://picsum.photos/seed/pp04/400/400',
    'https://picsum.photos/seed/pp05/400/400',
    'https://picsum.photos/seed/pp06/400/400',
    'https://picsum.photos/seed/pp07/400/400',
    'https://picsum.photos/seed/pp08/400/400',
    'https://picsum.photos/seed/pp09/400/400',
    'https://picsum.photos/seed/pp10/400/400',
    'https://picsum.photos/seed/pp11/400/400',
    'https://picsum.photos/seed/pp12/400/400',
    'https://picsum.photos/seed/pp13/400/400',
    'https://picsum.photos/seed/pp14/400/400',
    'https://picsum.photos/seed/pp15/400/400',
    'https://picsum.photos/seed/pp16/400/400',
    'https://picsum.photos/seed/pp17/400/400',
    'https://picsum.photos/seed/pp18/400/400',
    'https://picsum.photos/seed/pp19/400/400',
    'https://picsum.photos/seed/pp20/400/400',
    'https://picsum.photos/seed/pp21/400/400',
    'https://picsum.photos/seed/pp22/400/400',
    'https://picsum.photos/seed/pp23/400/400',
    'https://picsum.photos/seed/pp24/400/400',
    'https://picsum.photos/seed/pp25/400/400',
    'https://picsum.photos/seed/pp26/400/400',
    'https://picsum.photos/seed/pp27/400/400',
    'https://picsum.photos/seed/pp28/400/400',
    'https://picsum.photos/seed/pp29/400/400',
    'https://picsum.photos/seed/pp30/400/400',
];

let ppCardCounter = 0;
function ppMakeCardId() { return 'pp' + (++ppCardCounter) + '_' + Date.now(); }

function pp_startGame(room) {
    room.ppPhase = 'UPLOAD';
    room.ppPlayerPhotos = {}; room.ppReady = {}; room.ppDeck = []; room.ppHands = {};
    room.ppRound = 0; room.ppStorytellerIds = []; room.ppStorytellerId = null;
    room.ppClue = null; room.ppTable = []; room.ppVotes = {};
    room.ppSubUsed = {}; room.ppScores = {};
    room.gamePhase = 'PLAYING'; room.gameVotes = {};
    Object.keys(room.players).forEach(id => {
        room.ppPlayerPhotos[id] = []; room.ppReady[id] = false; room.ppSubUsed[id] = false;
    });
    broadcastRoom(room, 'ppUploadPhase', {
        players: Object.values(room.players).map(p => ({ id: p.id, name: p.name })),
        curatedPhotos: PP_CURATED,
    });
}

function pp_broadcastUploadProgress(room) {
    const readyIds = Object.keys(room.ppReady).filter(id => room.ppReady[id]);
    broadcastRoom(room, 'ppUploadProgress', {
        readyCount: readyIds.length,
        totalCount: Object.keys(room.players).length,
        readyPlayers: readyIds.map(id => room.players[id]?.name).filter(Boolean),
    });
}

function pp_dealCards(room) {
    const seenUrls = new Set();
    const pool = [];
    Object.entries(room.ppPlayerPhotos).forEach(([ownerId, photos]) => {
        photos.forEach(photoUrl => {
            if (!seenUrls.has(photoUrl)) { seenUrls.add(photoUrl); pool.push({ cardId: ppMakeCardId(), photoUrl, ownerId }); }
        });
    });
    for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    const playerIds = Object.keys(room.players);
    room.ppHands = {};
    playerIds.forEach(id => { room.ppHands[id] = []; });
    let idx = 0;
    for (let card = 0; card < 4; card++) {
        playerIds.forEach(id => { if (idx < pool.length) room.ppHands[id].push(pool[idx++]); });
    }
    room.ppDeck = pool.slice(idx);
    const shuffled = [...playerIds].sort(() => Math.random() - 0.5);
    room.ppStorytellerIds = [0, 1, 2].map(i => shuffled[i % shuffled.length]);
    pp_startRound(room, 1);
}

function pp_startRound(room, round) {
    room.ppRound = round; room.ppPhase = 'CLUE';
    room.ppStorytellerId = room.ppStorytellerIds[round - 1];
    room.ppClue = null; room.ppTable = []; room.ppVotes = {};
    clearInterval(room.ppTimer); clearTimeout(room.ppTimer);
    Object.keys(room.players).forEach(id => {
        io.to(id).emit('ppRoundStart', {
            round, totalRounds: 3,
            storytellerId: room.ppStorytellerId,
            storytellerName: room.players[room.ppStorytellerId]?.name || '?',
            hand: room.ppHands[id] || [],
            ppScores: room.ppScores,
            players: Object.values(room.players).map(p => ({ id: p.id, name: p.name })),
            subUsed: room.ppSubUsed[id] || false,
            timeLeft: PP_CLUE_SECONDS,
        });
    });
    room.ppTimeLeft = PP_CLUE_SECONDS;
    room.ppTimer = setInterval(() => {
        room.ppTimeLeft--;
        broadcastRoom(room, 'ppTimer', { timeLeft: room.ppTimeLeft, phase: 'CLUE' });
        if (room.ppTimeLeft <= 0) {
            clearInterval(room.ppTimer);
            const hand = room.ppHands[room.ppStorytellerId] || [];
            if (!room.ppClue && hand.length > 0) pp_receiveClue(room, room.ppStorytellerId, hand[0].cardId, '...');
        }
    }, 1000);
}

function pp_receiveClue(room, socketId, cardId, clue) {
    clearInterval(room.ppTimer);
    room.ppClue = clue;
    const hand = room.ppHands[socketId] || [];
    const cardIdx = hand.findIndex(c => c.cardId === cardId);
    if (cardIdx === -1) return;
    const card = hand.splice(cardIdx, 1)[0];
    room.ppTable.push({ ...card, submitterId: socketId });
    room.ppPhase = 'SUBMIT';
    broadcastRoom(room, 'ppClueSet', {
        clue, storytellerId: room.ppStorytellerId,
        storytellerName: room.players[room.ppStorytellerId]?.name || '?',
    });
    room.ppTimeLeft = PP_SUBMIT_SECONDS;
    room.ppTimer = setInterval(() => {
        room.ppTimeLeft--;
        broadcastRoom(room, 'ppTimer', { timeLeft: room.ppTimeLeft, phase: 'SUBMIT' });
        if (room.ppTimeLeft <= 0) { clearInterval(room.ppTimer); pp_openVoting(room); }
    }, 1000);
}

function pp_submitCard(room, socketId, cardId) {
    if (socketId === room.ppStorytellerId) return;
    if (room.ppTable.some(c => c.submitterId === socketId)) return;
    const hand = room.ppHands[socketId] || [];
    const cardIdx = hand.findIndex(c => c.cardId === cardId);
    if (cardIdx === -1) return;
    const card = hand.splice(cardIdx, 1)[0];
    room.ppTable.push({ ...card, submitterId: socketId });
    const total = Object.keys(room.players).length;
    broadcastRoom(room, 'ppSubmissionCount', { submitted: room.ppTable.length, total });
    if (room.ppTable.length >= total) { clearInterval(room.ppTimer); pp_openVoting(room); }
}

function pp_openVoting(room) {
    clearInterval(room.ppTimer);
    room.ppPhase = 'VOTE'; room.ppVotes = {};
    const shuffled = [...room.ppTable].sort(() => Math.random() - 0.5);
    broadcastRoom(room, 'ppVotePhase', {
        clue: room.ppClue,
        cards: shuffled.map(c => ({ cardId: c.cardId, photoUrl: c.photoUrl })),
        storytellerId: room.ppStorytellerId,
        timeLeft: PP_VOTE_SECONDS,
    });
    room.ppTimeLeft = PP_VOTE_SECONDS;
    room.ppTimer = setInterval(() => {
        room.ppTimeLeft--;
        broadcastRoom(room, 'ppTimer', { timeLeft: room.ppTimeLeft, phase: 'VOTE' });
        if (room.ppTimeLeft <= 0) { clearInterval(room.ppTimer); pp_resolveVotes(room); }
    }, 1000);
}

function pp_resolveVotes(room) {
    clearInterval(room.ppTimer);
    room.ppPhase = 'RESULT';
    const storytellerCard = room.ppTable.find(c => c.submitterId === room.ppStorytellerId);
    const votesPerCard = {};
    Object.entries(room.ppVotes).forEach(([vid, cid]) => {
        if (!votesPerCard[cid]) votesPerCard[cid] = [];
        votesPerCard[cid].push(vid);
    });
    const correctVoters = votesPerCard[storytellerCard?.cardId] || [];
    const nonStorytellers = Object.keys(room.players).filter(id => id !== room.ppStorytellerId);
    const allGuessed = correctVoters.length === nonStorytellers.length;
    const noneGuessed = correctVoters.length === 0;

    const roundScores = {};
    Object.keys(room.players).forEach(id => { roundScores[id] = 0; });
    if (allGuessed || noneGuessed) {
        nonStorytellers.forEach(id => { roundScores[id] = (roundScores[id] || 0) + 2; });
    } else {
        roundScores[room.ppStorytellerId] = (roundScores[room.ppStorytellerId] || 0) + 3;
        correctVoters.forEach(vid => { roundScores[vid] = (roundScores[vid] || 0) + 3; });
    }
    Object.entries(votesPerCard).forEach(([cid, voters]) => {
        if (cid === storytellerCard?.cardId) return;
        const card = room.ppTable.find(c => c.cardId === cid);
        if (card) roundScores[card.submitterId] = (roundScores[card.submitterId] || 0) + voters.length;
    });
    Object.entries(roundScores).forEach(([id, pts]) => {
        const name = room.players[id]?.name; if (!name) return;
        if (!room.ppScores[name]) room.ppScores[name] = 0;
        room.ppScores[name] += pts;
    });
    Object.keys(room.players).forEach(id => {
        if (room.ppDeck.length > 0) {
            if (!room.ppHands[id]) room.ppHands[id] = [];
            room.ppHands[id].push(room.ppDeck.shift());
        }
    });
    const isLastRound = room.ppRound >= 3;
    broadcastRoom(room, 'ppRoundResult', {
        storytellerId: room.ppStorytellerId,
        storytellerCardId: storytellerCard?.cardId,
        clue: room.ppClue, cards: room.ppTable,
        votesPerCard, roundScores, ppScores: room.ppScores,
        players: Object.values(room.players).map(p => ({ id: p.id, name: p.name })),
        allGuessed, noneGuessed, isLastRound,
    });
    if (isLastRound) {
        room.ppTimer = setTimeout(() => pp_returnToLobby(room), 15000);
    } else {
        room.ppTimer = setTimeout(() => pp_startRound(room, room.ppRound + 1), PP_RESULT_SECONDS * 1000);
    }
}

// Re-evaluate a PikPic round after a player leaves so it never hangs waiting
// on someone who's gone. Called from disconnect + leaveRoom.
function pp_recheckProgress(room) {
    if (!room) return;
    const active = ['CLUE', 'SUBMIT', 'VOTE'].includes(room.ppPhase);
    if (!active) return;
    // Count only connected players for progress checks; disconnected ones are skipped
    const activePlayers = Object.entries(room.players).filter(([, p]) => !p.disconnected);
    if (activePlayers.length < 2) { pp_returnToLobby(room); return; }

    if (room.ppPhase === 'CLUE') {
        const stHere = room.players[room.ppStorytellerId] && !room.players[room.ppStorytellerId].disconnected;
        if (!stHere) {
            clearInterval(room.ppTimer); clearTimeout(room.ppTimer);
            if (room.ppRound >= 3) pp_returnToLobby(room);
            else pp_startRound(room, room.ppRound + 1);
        }
    } else if (room.ppPhase === 'SUBMIT') {
        // Advance once all active (non-disconnected) players have submitted
        if (room.ppTable.length >= activePlayers.length) {
            clearInterval(room.ppTimer); pp_openVoting(room);
        }
    } else if (room.ppPhase === 'VOTE') {
        const nonStory = activePlayers.map(([id]) => id).filter(id => id !== room.ppStorytellerId);
        if (Object.keys(room.ppVotes).length >= nonStory.length) {
            clearInterval(room.ppTimer); pp_resolveVotes(room);
        }
    }
}

function pp_returnToLobby(room) {
    clearInterval(room.ppTimer); clearTimeout(room.ppTimer);
    room.ppPhase = 'LOBBY'; room.ppDeck = []; room.ppHands = {}; room.ppRound = 0;
    room.ppStorytellerId = null; room.ppStorytellerIds = [];
    room.ppClue = null; room.ppTable = []; room.ppVotes = {};
    room.ppPlayerPhotos = {}; room.ppReady = {}; room.ppSubUsed = {};
    room.gamePhase = 'LOBBY';
    broadcastGameState(room);
}

// ─── Rizz or Roast ────────────────────────────────────────────────────────────

const RR_FILL_SECONDS   = 60;
const RR_RECORD_SECONDS = 25;
const RR_VOTE_SECONDS   = 22;
const RR_RESULT_SECONDS = 6;
const RR_MAX_AUDIO_BYTES = 2_000_000; // ~1.5MB audio

const RR_TEMPLATES = [
    { id:'rr01', template:"You give off very strong [NOUN] energy.", blanks:['NOUN'] },
    { id:'rr02', template:"If you were a [NOUN], you'd be the [ADJECTIVE] one.", blanks:['NOUN','ADJECTIVE'] },
    { id:'rr03', template:"You have the energy of someone who [VERB]s [NOUN] for fun.", blanks:['VERB','NOUN'] },
    { id:'rr04', template:"History will remember you as the person who [VERB]ed a [NOUN].", blanks:['VERB','NOUN'] },
    { id:'rr05', template:"You're the type of person who brings [NOUN] to a [NOUN].", blanks:['NOUN','NOUN'] },
    { id:'rr06', template:"Your whole thing is [ADJECTIVE] [NOUN] and everyone knows it.", blanks:['ADJECTIVE','NOUN'] },
    { id:'rr07', template:"You remind me of [NOUN] — and that's [ADJECTIVE].", blanks:['NOUN','ADJECTIVE'] },
    { id:'rr08', template:"The vibe you bring to every room is just [ADJECTIVE] [NOUN].", blanks:['ADJECTIVE','NOUN'] },
    { id:'rr09', template:"You look like the kind of person who [VERB]s [NOUN] unironically.", blanks:['VERB','NOUN'] },
    { id:'rr10', template:"Honestly, you have the same energy as [NOUN] at [PLACE].", blanks:['NOUN','PLACE'] },
    { id:'rr11', template:"If there were an award for being [ADJECTIVE], you'd show up in a [NOUN].", blanks:['ADJECTIVE','NOUN'] },
    { id:'rr12', template:"You're basically what happens when [NOUN] meets [NOUN].", blanks:['NOUN','NOUN'] },
    { id:'rr13', template:"The last person this [ADJECTIVE] was [CELEBRITY].", blanks:['ADJECTIVE','CELEBRITY'] },
    { id:'rr14', template:"I've seen [NOUN]s with more [NOUN] than you.", blanks:['NOUN','NOUN'] },
    { id:'rr15', template:"You walk into a room and people think: '[ADJECTIVE] [NOUN].'", blanks:['ADJECTIVE','NOUN'] },
];

function rr_assemble(template, fills) {
    let i = 0;
    return template.replace(/\[[^\]]+\]/g, () => fills[i++] || '____');
}

function rr_startGame(room) {
    room.rrPhase = 'FILL';
    room.rrTemplate = RR_TEMPLATES[Math.floor(Math.random() * RR_TEMPLATES.length)];
    room.rrPlayerFills = {}; room.rrFillReady = {};
    room.rrPlayerRecordings = {}; room.rrRecordReady = {};
    room.rrBattles = []; room.rrCurrentBattle = 0; room.rrScores = {};
    room.gamePhase = 'PLAYING'; room.gameVotes = {};
    Object.keys(room.players).forEach(id => { room.rrScores[room.players[id].name] = 0; });
    clearInterval(room.rrTimer);
    broadcastRoom(room, 'rrFillPhase', { template: room.rrTemplate, timeLeft: RR_FILL_SECONDS });
    room.rrTimeLeft = RR_FILL_SECONDS;
    room.rrTimer = setInterval(() => {
        room.rrTimeLeft--;
        broadcastRoom(room, 'rrTimer', { timeLeft: room.rrTimeLeft, phase: 'FILL' });
        if (room.rrTimeLeft <= 0) { clearInterval(room.rrTimer); rr_startRecordPhase(room); }
    }, 1000);
}

function rr_broadcastFillProgress(room) {
    const readyCount = Object.values(room.rrFillReady).filter(Boolean).length;
    const totalCount = Object.keys(room.players).length;
    broadcastRoom(room, 'rrFillProgress', { readyCount, totalCount });
}

function rr_startRecordPhase(room) {
    clearInterval(room.rrTimer);
    room.rrPhase = 'RECORD'; room.rrRecordReady = {};
    // Fill any missing players with placeholder fills
    Object.keys(room.players).forEach(id => {
        if (!room.rrPlayerFills[id]) room.rrPlayerFills[id] = room.rrTemplate.blanks.map(() => '____');
    });
    // Create pairings NOW so players know their matchup while recording
    const shuffled = Object.keys(room.players).sort(() => Math.random() - 0.5);
    room.rrBattles = [];
    for (let i = 0; i + 1 < shuffled.length; i += 2) {
        room.rrBattles.push({
            p1: shuffled[i], p2: shuffled[i + 1],
            type: Math.random() < 0.5 ? 'RIZZ' : 'ROAST',
            votes: {}, winner: null,
        });
    }
    // Tell each player: their assembled line + who they're up against + battle type
    Object.keys(room.players).forEach(id => {
        const assembled = rr_assemble(room.rrTemplate.template, room.rrPlayerFills[id]);
        const battle = room.rrBattles.find(b => b.p1 === id || b.p2 === id);
        const opponentId = battle ? (battle.p1 === id ? battle.p2 : battle.p1) : null;
        const opponentName = opponentId ? (room.players[opponentId]?.name || '?') : null;
        const battleType = battle?.type || null;
        io.to(id).emit('rrRecordPhase', { assembled, timeLeft: RR_RECORD_SECONDS, opponentName, battleType, bye: !battle });
    });
    room.rrTimeLeft = RR_RECORD_SECONDS;
    room.rrTimer = setInterval(() => {
        room.rrTimeLeft--;
        broadcastRoom(room, 'rrTimer', { timeLeft: room.rrTimeLeft, phase: 'RECORD' });
        if (room.rrTimeLeft <= 0) { clearInterval(room.rrTimer); rr_launchBattles(room); }
    }, 1000);
}

function rr_launchBattles(room) {
    clearInterval(room.rrTimer);
    room.rrPhase = 'BATTLE';
    room.rrCurrentBattle = 0;
    rr_runBattle(room, 0);
}

function rr_runBattle(room, idx) {
    clearInterval(room.rrTimer); clearTimeout(room.rrTimer);
    if (idx >= room.rrBattles.length) { rr_endGame(room); return; }
    room.rrCurrentBattle = idx;
    const battle = room.rrBattles[idx];
    const p1 = room.players[battle.p1], p2 = room.players[battle.p2];
    const payload = {
        battleIndex: idx, totalBattles: room.rrBattles.length,
        type: battle.type,
        p1: { id: battle.p1, name: p1?.name || '?' },
        p2: { id: battle.p2, name: p2?.name || '?' },
        p1audio: room.rrPlayerRecordings[battle.p1] || null,
        p2audio: room.rrPlayerRecordings[battle.p2] || null,
        p1text: rr_assemble(room.rrTemplate.template, room.rrPlayerFills[battle.p1] || []),
        p2text: rr_assemble(room.rrTemplate.template, room.rrPlayerFills[battle.p2] || []),
        timeLeft: RR_VOTE_SECONDS,
    };
    broadcastRoom(room, 'rrBattleStart', payload);
    room.rrTimeLeft = RR_VOTE_SECONDS;
    room.rrTimer = setInterval(() => {
        room.rrTimeLeft--;
        broadcastRoom(room, 'rrTimer', { timeLeft: room.rrTimeLeft, phase: 'VOTE' });
        if (room.rrTimeLeft <= 0) { clearInterval(room.rrTimer); rr_resolveBattle(room, idx); }
    }, 1000);
}

function rr_resolveBattle(room, idx) {
    clearInterval(room.rrTimer);
    const battle = room.rrBattles[idx];
    let p1votes = 0, p2votes = 0;
    Object.entries(battle.votes).forEach(([, pid]) => { if (pid === battle.p1) p1votes++; else p2votes++; });
    battle.winner = p1votes >= p2votes ? battle.p1 : battle.p2;
    // Award points: winner 3, loser 1, tie both get 2
    const p1name = room.players[battle.p1]?.name, p2name = room.players[battle.p2]?.name;
    if (p1votes === p2votes) {
        if (p1name) room.rrScores[p1name] = (room.rrScores[p1name] || 0) + 2;
        if (p2name) room.rrScores[p2name] = (room.rrScores[p2name] || 0) + 2;
    } else if (p1votes > p2votes) {
        if (p1name) room.rrScores[p1name] = (room.rrScores[p1name] || 0) + 3;
        if (p2name) room.rrScores[p2name] = (room.rrScores[p2name] || 0) + 1;
    } else {
        if (p2name) room.rrScores[p2name] = (room.rrScores[p2name] || 0) + 3;
        if (p1name) room.rrScores[p1name] = (room.rrScores[p1name] || 0) + 1;
    }
    broadcastRoom(room, 'rrBattleResult', {
        battleIndex: idx, winner: battle.winner,
        p1votes, p2votes, p1: battle.p1, p2: battle.p2,
        rrScores: room.rrScores,
    });
    room.rrTimer = setTimeout(() => rr_runBattle(room, idx + 1), RR_RESULT_SECONDS * 1000);
}

function rr_endGame(room) {
    room.rrPhase = 'END';
    const sorted = Object.entries(room.rrScores).sort((a, b) => b[1] - a[1]);
    broadcastRoom(room, 'rrGameEnd', { rrScores: room.rrScores, sorted, players: Object.values(room.players).map(p => ({ id: p.id, name: p.name })) });
}

function rr_returnToLobby(room) {
    clearInterval(room.rrTimer); clearTimeout(room.rrTimer);
    room.rrPhase = 'LOBBY'; room.rrTemplate = null;
    room.rrPlayerFills = {}; room.rrFillReady = {};
    room.rrPlayerRecordings = {}; room.rrRecordReady = {};
    room.rrBattles = []; room.rrCurrentBattle = 0; room.rrScores = {};
    room.gamePhase = 'LOBBY';
    broadcastGameState(room);
}

// ─── Bad Pitches v4 — legendary break-beat crate ───────────────────────────────
// The dig source is a fixed catalog of the most-sampled drum breaks in hip-hop history
// (Ultimate Breaks & Beats on Archive.org) instead of random 1940s-50s jazz/blues 78s —
// real playtest feedback was that the old jazz "didn't resonate", and breaks have far
// stronger transients so the snap-to-onset Chop mechanic works better on them too.
// No startup Archive.org search needed anymore: the catalog is static, so boot is
// instant and the online/offline paths only differ in where the bytes come from.

const BB_DIG_SECS  = 30;  // pick a break from your dealt crate
const BB_SCRUB_SECS = 90;
const BB_SPIT_SECS  = 90;  // mad-lib fill + flow pick, before Battle

// Break-beat mp3s live inside this subfolder of the Archive.org item.
const BB_BREAKS_DIR = 'BreakBeat Lou Flores - Ultimate Breaks and Beats - The Complete Collection';
function bb_breakUrl(file) {
    return `https://archive.org/download/ultimate-break-beats-complete/${`${BB_BREAKS_DIR}/${file}`.split('/').map(encodeURIComponent).join('/')}`;
}

// Curated from the real file listing of archive.org/metadata/ultimate-break-beats-complete
// (fetched + verified 2026-07-01 — don't invent filenames, they must match exactly).
// Keep in sync with the copy in bb-cache-build.js. duration = seconds, from archive metadata.
const BB_BREAK_CATALOG = [
    { title: 'Amen Brother',                 artist: 'The Winstons',            file: '501.3 Amen Brother.mp3',                 duration: 155 },
    { title: 'Apache',                       artist: 'Incredible Bongo Band',   file: '503.2 Apache.mp3',                       duration: 291 },
    { title: 'Funky Drummer',                artist: 'James Brown',             file: '512.2 Funky Drummer.mp3',                duration: 175 },
    { title: 'Impeach The President',        artist: 'The Honey Drippers',      file: '511.1 Impeach The President.mp3',        duration: 205 },
    { title: 'Synthetic Substitution',       artist: 'Melvin Bliss',            file: '505.4 Synthetic Substitution.mp3',       duration: 218 },
    { title: 'Think (About It)',             artist: 'Lyn Collins',             file: '516.5 Think (About It).mp3',             duration: 212 },
    { title: "It's Just Begun",              artist: 'The Jimmy Castor Bunch',  file: "518.4 It's Just Begun.mp3",              duration: 227 },
    { title: "Ashley's Roachclip",           artist: 'The Soul Searchers',      file: "512.6 Ashley's Roachclip.mp3",           duration: 331 },
    { title: 'The Champ',                    artist: 'The Mohawks',             file: '512.3 The Champ.mp3',                    duration: 154 },
    { title: 'Cold Sweat',                   artist: 'James Brown',             file: '506.2 Cold Sweat.mp3',                   duration: 445 },
    { title: 'Funky President',              artist: 'James Brown',             file: '510.1 Funky President.mp3',              duration: 239 },
    { title: 'Blind Alley',                  artist: 'The Emotions',            file: '524.4 Blind Alley.mp3',                  duration: 177 },
    { title: 'Long Red',                     artist: 'Mountain',                file: '509.5 Long Red.mp3',                     duration: 352 },
    { title: 'Big Beat',                     artist: 'Billy Squier',            file: '509.3 Big Beat.mp3',                     duration: 213 },
    { title: 'Seven Minutes Of Funk',        artist: 'The Whole Darn Family',   file: '509.6 Seven Minutes Of Funk.mp3',        duration: 418 },
    { title: 'Hand Clapping Song',           artist: 'The Meters',              file: '508.5 Hand Clapping Song.mp3',           duration: 172 },
    { title: "Dance To The Drummer's Beat",  artist: 'Herman Kelly & Life',     file: "503.3 Dance To The Drummer's Beat.mp3",  duration: 249 },
    { title: 'Bongo Rock',                   artist: 'Incredible Bongo Band',   file: '503.4 Bongo Rock.mp3',                   duration: 155 },
    { title: 'Different Strokes',            artist: 'Syl Johnson',             file: '504.1 Different Strokes.mp3',            duration: 154 },
    { title: 'Give It Up Or Turn It Loose',  artist: 'James Brown',             file: '507.1 Give It Up Or Turn It Loose.mp3',  duration: 397 },
    { title: 'N.T.',                         artist: 'Kool & The Gang',         file: '517.5 N.T..mp3',                         duration: 189 },
    { title: 'The Grunt Pt. 1',              artist: "The J.B.'s",              file: '522.4 The Grunt Pt. 1.mp3',              duration: 178 },
    { title: 'Blow Your Head',               artist: "Fred Wesley & The J.B.'s", file: '514.6 Blow Your Head.mp3',              duration: 230 },
    { title: 'Get Out My Life Woman',        artist: 'Lee Dorsey',              file: '523.4 Get Out My Life Woman.mp3',        duration: 198 },
    { title: 'Hook And Sling Pt. 1',         artist: 'Eddie Bo',                file: '520.6 Hook And Sling Pt. 1.mp3',         duration: 156 },
    { title: 'Kissing My Love',              artist: 'Bill Withers',            file: '520.7 Kissing My Love.mp3',              duration: 226 },
    { title: 'Soul Pride',                   artist: 'James Brown',             file: '521.5 Soul Pride.mp3',                   duration: 127 },
    { title: "Scratchin'",                   artist: 'Magic Disco Machine',     file: "506.5 Scratchin'.mp3",                   duration: 164 },
    { title: 'Shack Up',                     artist: 'Banbarra',                file: '505.7 Shack Up.mp3',                     duration: 211 },
    { title: 'I Know You Got Soul',          artist: 'Bobby Byrd',              file: '504.2 I Know You Got Soul.mp3',          duration: 184 },
    { title: 'Misdemeanor',                  artist: 'Foster Sylvers',          file: '519.4 Misdemeanor.mp3',                  duration: 138 },
    { title: 'The Payback',                  artist: 'James Brown',             file: '525.7 The Payback.mp3',                  duration: 475 },
    { title: 'The Mexican',                  artist: 'Babe Ruth',               file: '508.1 The Mexican.mp3',                  duration: 334 },
    { title: 'T Plays It Cool',              artist: 'Marvin Gaye',             file: '516.4 T Plays It Cool.mp3',              duration: 253 },
    { title: 'Rock Creek Park',              artist: 'The Blackbyrds',          file: '519.1 Rock Creek Park.mp3',              duration: 268 },
    { title: 'Catch A Groove',               artist: 'Juice',                   file: '502.2 Catch A Groove.mp3',               duration: 216 },
].map((b, i) => ({ ...b, idx: i, audioUrl: bb_breakUrl(b.file) }));

// Offline: only deal breaks whose audio actually exists in the disk cache (whatever
// bb-cache-build.js managed to download — could be all 36 or just the old 8). A stale
// jazz-era cache (manifest but zero break files) falls back to the full catalog rather
// than dealing empty crates — re-run bb-cache-build.js to make it truly offline-ready.
const bbCachedBreaks = BB_BREAK_CATALOG.filter(b => fs.existsSync(bbAudioCacheFile(b.audioUrl)));
const BB_DEALABLE = (BB_OFFLINE && bbCachedBreaks.length) ? bbCachedBreaks : BB_BREAK_CATALOG;
if (BB_OFFLINE && !bbCachedBreaks.length) console.log('[BB] WARNING: offline cache has no break audio — re-run bb-cache-build.js');
console.log(`[BB] break catalog: ${BB_DEALABLE.length}/${BB_BREAK_CATALOG.length} dealable${BB_OFFLINE && bbCachedBreaks.length ? ' (offline cache)' : ''}`);

// Deal a crate of n distinct breaks, preferring ones this room hasn't been dealt yet.
function bb_dealCrate(room, n) {
    const pool = BB_DEALABLE.filter(b => !room.bbUsedIds.has(b.idx));
    const source = pool.length >= n ? pool : BB_DEALABLE;
    const shuffled = [...source].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(n, shuffled.length)).map(b => b.idx);
}
// 1v1 round-based pairing — direct port of Squiggle's sq_seedMatchups (index.js:967).
// Runs BEFORE Dig starts (not after), since Spit needs to know the opponent's name while writing.
function bb_seedMatchups(room) {
    const pids = Object.keys(room.players).sort(() => Math.random() - 0.5);
    const matchups = [];
    for (let i = 0; i + 1 < pids.length; i += 2)
        matchups.push({ p1Id: pids[i], p2Id: pids[i+1], winner: null, p1Votes: 0, p2Votes: 0 });
    return { matchups, byeId: pids.length % 2 === 1 ? pids[pids.length-1] : null };
}

function bb_startGame(room) {
    room.gamePhase   = 'PLAYING';
    room.bbPhase     = 'LOBBY';
    room.bbRound     = 0;
    room.bbCumScores = {};
    room.bbUsedIds   = new Set(); // identifiers served to this room — no repeats
    Object.keys(room.players).forEach(id => { room.bbCumScores[id] = 0; });
    bb_startRound(room);
}

function bb_startRound(room) {
    room.bbRound++;
    room.bbPhase       = 'DIG';
    room.bbSamples     = {};
    room.bbDigOptions  = {};
    room.bbChops       = {};
    room.bbSpitFills   = {};
    room.bbFlowPreset  = {};
    room.bbAdlibs      = {};
    room.bbVotes       = {};
    room.bbRoundScores = {};
    Object.keys(room.players).forEach(id => { room.bbRoundScores[id] = 0; });

    const { matchups, byeId } = bb_seedMatchups(room);
    room.bbMatchups = matchups.map(m => ({ ...m, pointValue: room.bbRound }));
    room.bbCurrentMatchup = 0;
    room.bbByeId = byeId;
    if (byeId) room.bbCumScores[byeId] = (room.bbCumScores[byeId] || 0) + room.bbRound;

    broadcastRoom(room, 'bbRoundStart', {
        round: room.bbRound, totalRounds: room.bbTotalRounds,
        matchups: room.bbMatchups.map(m => ({
            p1Id: m.p1Id, p1Name: room.players[m.p1Id]?.name || '?',
            p2Id: m.p2Id, p2Name: room.players[m.p2Id]?.name || '?',
            pointValue: m.pointValue,
        })),
        byeId,
    });

    bb_beginDig(room);
}

// DIG — every player gets dealt a crate of 4 breaks, taps to preview, picks one to chop.
// Interactive (real digging agency) instead of the old auto-assigned random sample.
function bb_beginDig(room) {
    room.bbPhase = 'DIG';
    room.bbDigOptions = {};
    room.bbTimeLeft = BB_DIG_SECS;
    Object.keys(room.players).forEach(pid => {
        const dealt = bb_dealCrate(room, 4);
        room.bbDigOptions[pid] = dealt;
        io.to(pid).emit('bbDigPhase', {
            timeLeft: BB_DIG_SECS,
            options: dealt.map(i => {
                const b = BB_BREAK_CATALOG[i];
                return { idx: b.idx, title: b.title, artist: b.artist, duration: b.duration, audioProxyUrl: `/api/bb-break/${b.idx}` };
            }),
        });
    });
    room.bbTimer = setInterval(() => {
        room.bbTimeLeft--;
        broadcastRoom(room, 'bbTimeTick', { timeLeft: room.bbTimeLeft });
        if (room.bbTimeLeft <= 0) { clearInterval(room.bbTimer); room.bbTimer = null; bb_endDig(room); }
    }, 1000);
}

function bb_endDig(room) {
    clearInterval(room.bbTimer); room.bbTimer = null;
    // Anyone who didn't pick gets their crate's first break — nobody stalls the room.
    Object.keys(room.players).forEach(pid => {
        if (!room.bbSamples[pid]) {
            const idx = room.bbDigOptions[pid]?.[0] ?? BB_DEALABLE[0]?.idx ?? 0;
            room.bbSamples[pid] = BB_BREAK_CATALOG[idx];
            room.bbUsedIds.add(idx);
            io.to(pid).emit('bbBreakPicked', { idx });
        }
    });
    bb_beginChop(room);
}

// CHOP — waveform scrub, per-player (each player chops the break they dug).
function bb_beginChop(room) {
    room.bbPhase = 'CHOP';
    room.bbTimeLeft = BB_SCRUB_SECS;
    Object.keys(room.players).forEach(pid => {
        const sample = room.bbSamples[pid];
        io.to(pid).emit('bbChopPhase', {
            timeLeft: BB_SCRUB_SECS,
            audioProxyUrl: sample ? `/api/bb-break/${sample.idx}` : null,
            duration: sample?.duration || 300,
        });
    });
    room.bbTimer = setInterval(() => {
        room.bbTimeLeft--;
        broadcastRoom(room, 'bbTimeTick', { timeLeft: room.bbTimeLeft });
        if (room.bbTimeLeft <= 0) { clearInterval(room.bbTimer); room.bbTimer = null; bb_endChop(room); }
    }, 1000);
}

function bb_endChop(room) {
    clearInterval(room.bbTimer); room.bbTimer = null;
    Object.keys(room.players).forEach(id => {
        if (!room.bbChops[id]) room.bbChops[id] = { start: 5, end: 9, hitCount: 8, rate: 1 };
    });
    bb_beginSpit(room);
}

// SPIT — mad-lib diss verse. One shared template per round (same skeleton for everyone, like
// Rizz or Roast); [OPP] is substituted server-side per-player BEFORE the template is sent, so
// the client's blank-rendering regex only ever sees real [BLANK] tokens.
// Kept deliberately SHORT — 2 lines, 2-3 blanks — after a real playtest found the original
// 3-line/4-blank versions too long and convoluted to fill in under pressure at a party.
const BB_SPIT_TEMPLATES = [
    { id:'bp01', template:"Yo [OPP], you rap like a [ADJECTIVE] [NOUN].\nSit down before I really start.", blanks:['ADJECTIVE','NOUN'] },
    { id:'bp02', template:"[OPP], your bars belong in a [NOUN].\nMine belong at [PLACE].", blanks:['NOUN','PLACE'] },
    { id:'bp03', template:"They call you [OPP]? More like a [ADJECTIVE] [NOUN].\nBoo this person.", blanks:['ADJECTIVE','NOUN'] },
    { id:'bp04', template:"[OPP], your verse was straight [NOUN].\nGo [VERB] yourself a new hobby.", blanks:['NOUN','VERB'] },
    { id:'bp05', template:"Breaking news: [OPP] just got dropped like a [ADJECTIVE] [NOUN].\nBack to you in the studio.", blanks:['ADJECTIVE','NOUN'] },
    { id:'bp06', template:"[OPP], even a [NOUN] could out-rap you.\nStay [ADJECTIVE], champ.", blanks:['NOUN','ADJECTIVE'] },
    { id:'bp07', template:"I'd roast you, [OPP], but you're already [ADJECTIVE].\nNow watch me [VERB] this beat.", blanks:['ADJECTIVE','VERB'] },
    { id:'bp08', template:"[OPP] flows like a [NOUN] stuck in [PLACE].\nI'm the champ, you're the chump.", blanks:['NOUN','PLACE'] },
    { id:'bp09', template:"Last warning, [OPP] — go [VERB] at [PLACE] instead.\nThis stage is mine.", blanks:['VERB','PLACE'] },
    { id:'bp10', template:"[OPP] rhymes so bad, [NOUN]s file complaints.\nCase closed.", blanks:['NOUN'] },
    { id:'bp11', template:"I'm the GOAT — [OPP]'s just a [ADJECTIVE] [NOUN].\nEnd of story.", blanks:['ADJECTIVE','NOUN'] },
    { id:'bp12', template:"[OPP], you sound like a [NOUN] learning to [VERB].\nKeep practicing, baby.", blanks:['NOUN','VERB'] },
];
// Zero-friction ad-lib fallback since no real stinger clips exist yet — synthesized client-side
// via the existing oscillator-synth code. Real recording (adapted from Rizz or Roast) is the
// primary path; this is just the no-mic/no-hassle option.
const BB_CANNED_ADLIBS = ['airhorn', 'laugh', 'scratch', 'boo'];

function bb_oppNameFor(room, pid) {
    if (pid === room.bbByeId) return 'the crowd';
    const matchup = room.bbMatchups.find(m => m.p1Id === pid || m.p2Id === pid);
    const oppId = matchup ? (matchup.p1Id === pid ? matchup.p2Id : matchup.p1Id) : null;
    return room.players[oppId]?.name || 'the crowd';
}

// Fills a template's [BLANK] tokens (in order) with player answers, then splits into lines —
// callers must substitute [OPP] first, since it also matches the generic [...] blank pattern.
function bb_assembleSpit(templateWithOppFilled, fills) {
    let i = 0;
    const filled = templateWithOppFilled.replace(/\[[^\]]+\]/g, () => fills[i++] || '____');
    return filled.split('\n');
}

function bb_beginSpit(room) {
    room.bbPhase = 'SPIT';
    room.bbTimeLeft = BB_SPIT_SECS;
    room.bbSpitTemplate = BB_SPIT_TEMPLATES[Math.floor(Math.random() * BB_SPIT_TEMPLATES.length)];
    Object.keys(room.players).forEach(pid => {
        const oppName = bb_oppNameFor(room, pid);
        const template = room.bbSpitTemplate.template.split('[OPP]').join(oppName);
        io.to(pid).emit('bbSpitPhase', {
            template, blanks: room.bbSpitTemplate.blanks, timeLeft: BB_SPIT_SECS,
            cannedAdlibs: BB_CANNED_ADLIBS,
        });
    });
    room.bbTimer = setInterval(() => {
        room.bbTimeLeft--;
        broadcastRoom(room, 'bbTimeTick', { timeLeft: room.bbTimeLeft });
        if (room.bbTimeLeft <= 0) { clearInterval(room.bbTimer); room.bbTimer = null; bb_endSpit(room); }
    }, 1000);
}

function bb_endSpit(room) {
    clearInterval(room.bbTimer); room.bbTimer = null;
    Object.keys(room.players).forEach(id => {
        if (!room.bbSpitFills[id]) {
            const oppName = bb_oppNameFor(room, id);
            const filledTemplate = room.bbSpitTemplate.template.split('[OPP]').join(oppName);
            const fallbackFills = room.bbSpitTemplate.blanks.map(() => 'nothing');
            room.bbSpitFills[id] = { lines: bb_assembleSpit(filledTemplate, fallbackFills) };
            room.bbFlowPreset[id] = 'straight';
        }
    });
    bb_beginBattle(room);
}

// BATTLE — sequential per-matchup judging, direct port of Stroke Off's
// sq_beginBattle/sq_nextMatchup/sq_openVoting/sq_resolveMatchup/sq_endRound pattern.
const BB_BATTLE_VIEW_SECS = 25; // time to tap-and-listen to both verses before voting opens
const BB_BATTLE_VOTE_SECS = 10;

function bb_beginBattle(room) {
    room.bbPhase = 'BATTLE';
    room.bbCurrentMatchup = 0;
    bb_nextMatchup(room);
}

// The chopped loop is the whole point of Dig/Chop — it plays UNDER the spitter's verse
// during Battle (this was missing pre-v4: beats were made but never heard by anyone).
function bb_beatFor(room, pid) {
    const chop = room.bbChops[pid], sample = room.bbSamples[pid];
    if (!chop || !sample || sample.idx == null) return null;
    return { audioProxyUrl: `/api/bb-break/${sample.idx}`, start: chop.start, end: chop.end, rate: chop.rate };
}

function bb_nextMatchup(room) {
    clearInterval(room.bbTimer); clearTimeout(room.bbTimer);
    if (room.bbCurrentMatchup >= room.bbMatchups.length) { bb_endRound(room); return; }
    const m = room.bbMatchups[room.bbCurrentMatchup];
    const p1 = room.players[m.p1Id], p2 = room.players[m.p2Id];
    broadcastRoom(room, 'bbBattleBegin', {
        matchupIdx: room.bbCurrentMatchup, total: room.bbMatchups.length,
        round: room.bbRound, pointValue: m.pointValue,
        p1: { id: m.p1Id, name: p1 ? p1.name : '?', lines: room.bbSpitFills[m.p1Id]?.lines || [], flowPreset: room.bbFlowPreset[m.p1Id] || 'straight', adlib: room.bbAdlibs[m.p1Id] || null, beat: bb_beatFor(room, m.p1Id) },
        p2: { id: m.p2Id, name: p2 ? p2.name : '?', lines: room.bbSpitFills[m.p2Id]?.lines || [], flowPreset: room.bbFlowPreset[m.p2Id] || 'straight', adlib: room.bbAdlibs[m.p2Id] || null, beat: bb_beatFor(room, m.p2Id) },
    });
    room.bbTimer = setTimeout(() => bb_openVoting(room), BB_BATTLE_VIEW_SECS * 1000);
}

function bb_openVoting(room) {
    room.bbVotes = {};
    let t = BB_BATTLE_VOTE_SECS;
    broadcastRoom(room, 'bbVoteOpen', { timeLeft: t });
    room.bbTimer = setInterval(() => {
        t--;
        broadcastRoom(room, 'bbTimeTick', { timeLeft: t });
        if (t <= 0) { clearInterval(room.bbTimer); bb_resolveMatchup(room); }
    }, 1000);
}

function bb_resolveMatchup(room) {
    clearInterval(room.bbTimer); clearTimeout(room.bbTimer);
    const m = room.bbMatchups[room.bbCurrentMatchup];
    let p1Votes = 0, p2Votes = 0;
    Object.values(room.bbVotes).forEach(v => { if (v === 'p1') p1Votes++; else if (v === 'p2') p2Votes++; });
    m.p1Votes = p1Votes; m.p2Votes = p2Votes;
    let winnerId = null;
    if (p1Votes > p2Votes) { winnerId = m.p1Id; m.winner = 'p1'; }
    else if (p2Votes > p1Votes) { winnerId = m.p2Id; m.winner = 'p2'; }
    if (winnerId) {
        room.bbCumScores[winnerId] = (room.bbCumScores[winnerId] || 0) + m.pointValue;
        room.bbRoundScores[winnerId] = (room.bbRoundScores[winnerId] || 0) + m.pointValue;
    }
    broadcastRoom(room, 'bbMatchupResult', { matchupIdx: room.bbCurrentMatchup, winnerId, p1Votes, p2Votes, pointValue: m.pointValue, scores: room.bbCumScores });
    room.bbCurrentMatchup++;
    room.bbTimer = setTimeout(() => bb_nextMatchup(room), 3000);
}

function bb_endRound(room) {
    room.bbPhase = 'ROUND_END';
    const results = Object.keys(room.players).map(id => {
        const m = room.bbMatchups.find(mm => mm.p1Id === id || mm.p2Id === id);
        const votes = m ? (m.p1Id === id ? m.p1Votes : m.p2Votes) : 0;
        return {
            id, name: room.players[id]?.name || '?',
            votes: votes || 0,
            roundPts: room.bbRoundScores[id] || 0,
            total: room.bbCumScores[id] || 0,
        };
    }).sort((a, b) => b.total - a.total);
    broadcastRoom(room, 'bbRoundResult', { round: room.bbRound, totalRounds: room.bbTotalRounds, results });
    room.bbTimer = setTimeout(() => {
        if (!rooms[room.code]) return;
        if (room.bbRound < room.bbTotalRounds) bb_startRound(room);
        else bb_gameOver(room);
    }, 6000);
}

function bb_gameOver(room) {
    clearInterval(room.bbTimer); clearTimeout(room.bbTimer); room.bbTimer = null;
    room.bbPhase  = 'RESULT';
    room.gamePhase = 'LOBBY';
    const scores = Object.keys(room.players).map(id => ({
        id, name: room.players[id]?.name || '?', score: room.bbCumScores[id] || 0,
    })).sort((a, b) => b.score - a.score);
    broadcastRoom(room, 'bbGameOver', { scores });
}

// ─── Split Crew ────────────────────────────────────────────────────────────────

const SC_PIT_SECONDS    = 28;   // tight — tasks are simple, pressure is the point
const SC_RACE_SECONDS   = 7;    // quick standings flyby
const SC_REVEAL_SECONDS = 5;
const SC_LAPS           = 3;

function sc_ri(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function sc_randStation() {
    const bases = [94, 96, 98, 100, 102, 104, 106, 108];
    return bases[sc_ri(0, bases.length - 1)] + (Math.random() < 0.5 ? '.1' : '.7');
}
function sc_shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

const SC_DRIVERS = [
    { id:'chad',    name:'Chad McSpeed',    emoji:'😎', color:'#e53935', blurb:'Needs constant pampering',          signatureTasks:['coffee','sunscreen','selfie'] },
    { id:'brittney',name:'Brittney Burnout',emoji:'💅', color:'#e91e63', blurb:'High-maintenance party girl',       signatureTasks:['nails','sunglasses','hairspray'] },
    { id:'rico',    name:'Rico Veloso',     emoji:'🙏', color:'#fdd835', blurb:'Deeply superstitious before races', signatureTasks:['holy_cross','champagne','rosary'] },
    { id:'dale',    name:'Dale Danger',     emoji:'🤠', color:'#795548', blurb:'Needs his comfort items',           signatureTasks:['spit_cup','country_radio','beer_cozy'] },
    { id:'yuki',    name:'Yuki Turbō',      emoji:'⚡', color:'#00bcd4', blurb:'Zen speedster. Rituals are sacred', signatureTasks:['energy_drink','meditation_bell','origami'] },
    { id:'fabrice', name:'Fabrice Le Fou',  emoji:'🧑‍🎨', color:'#3f51b5', blurb:'Insufferable Frenchman',            signatureTasks:['beret','croissant','shrug'] },
];

const SC_TASK_DEFS = {
    // ── Car tasks ──
    lug_nuts:        { type:'crank',    car:true,  gen:()=>sc_ri(2,5),     instruct:(t)=>`Crank the wrench exactly ${t} full turn${t>1?'s':''}`,           fail:'Wheel wobbled off mid-corner.' },
    fuel:            { type:'gauge',    car:true,  gen:()=>sc_ri(3,9),     instruct:(t)=>`Fill fuel — hold until level hits ${t}, release right there`,    fail:'Ran dry on the back straight.' },
    air_gun:         { type:'tap',      car:true,  gen:()=>sc_ri(4,8),     instruct:(t)=>`Air gun — hit it exactly ${t} times`,                           fail:'Tires underinflated. Handling gone.' },
    squeegee:        { type:'swipe_seq',car:true,  gen:()=>{ const n=sc_ri(2,3); const s=[]; for(let i=0;i<n*2-1;i++) s.push(i%2===0?'L':'R'); return s; }, instruct:(seq)=>`Squeegee windshield: ${seq.join(' → ')}`, fail:"Driver can't see. Swerving wildly." },
    // ── Diva tasks ──
    coffee:          { type:'gauge',    car:false, gen:()=>sc_ri(5,9),     instruct:(t)=>`Fill his coffee to level ${t} — not a drop more`,               fail:'Cold coffee. Driver furious. Speed penalty.' },
    nails:           { type:'tap',      car:false, gen:()=>5,              instruct:()=>'Clip all 5 nails — tap 5 times left to right',                   fail:'Clipped wrong finger. Drama ensued.' },
    holy_cross:      { type:'swipe_seq',car:false, gen:()=>['U','L','R','D'], instruct:()=>'Holy cross: swipe UP → LEFT → RIGHT → DOWN',                 fail:"God isn't watching now. Rico is rattled." },
    sunglasses:      { type:'angle',    car:false, gen:()=>sc_ri(-2,3)*15, instruct:(t)=>`Tilt sunglasses ${t===0?'perfectly straight':Math.abs(t)+'° to the '+(t>0?'right':'left')}`, fail:'Crooked shades. Absolutely unacceptable.' },
    selfie:          { type:'timing',   car:false, gen:()=>null,           instruct:()=>'Hold pose — tap EXACTLY when the flash fires',                   fail:"Missed the shot. Instagram ruined." },
    energy_drink:    { type:'gauge',    car:false, gen:()=>sc_ri(6,10),    instruct:(t)=>`Energy drink — fill to level ${t}`,                            fail:'Too little energy. Yuki feels mortal.' },
    meditation_bell: { type:'timing',   car:false, gen:()=>null,           instruct:()=>'Ring the bell — tap when the circle touches the ring',           fail:"Wrong frequency. Yuki's vibes are ruined." },
    spit_cup:        { type:'gauge',    car:false, gen:()=>sc_ri(4,7),     instruct:(t)=>`Spit cup to level ${t} — do NOT overflow`,                     fail:'Overflowed. Dale is disgusted with everyone.' },
    country_radio:   { type:'dial',     car:false, gen:()=>sc_randStation(), instruct:(t)=>`Tune the radio to ${t} FM`,                                  fail:'Heard jazz. Dale cannot function on jazz.' },
    beret:           { type:'angle',    car:false, gen:()=>sc_ri(-2,2)*15, instruct:(t)=>`Tilt the beret ${t===0?'perfectly straight':Math.abs(t)+'° to the '+(t>0?'right':'left')}`, fail:"Wrong angle. Fabrice won't leave the pit." },
    champagne:       { type:'tap',      car:false, gen:()=>sc_ri(3,6),     instruct:(t)=>`Shake the champagne bottle exactly ${t} times`,                fail:"Flat champagne. Rico's curse activated." },
    beer_cozy:       { type:'swipe_seq',car:false, gen:()=>['U'],          instruct:()=>'Slide the beer cozy UP over the can',                           fail:"Beer got warm. Dale's focus is gone." },
    shrug:           { type:'swipe_seq',car:false, gen:()=>['U','U'],      instruct:()=>'Dramatic shrug — swipe UP, UP',                                 fail:"Not dramatic enough. Fabrice is sulking." },
    origami:         { type:'swipe_seq',car:false, gen:()=>['R','D','L','U'], instruct:()=>'Fold origami: RIGHT → DOWN → LEFT → UP',                    fail:"Bad luck origami. Yuki feels cursed." },
    rosary:          { type:'tap',      car:false, gen:()=>10,             instruct:()=>'Count 10 rosary beads — tap 10 times',                          fail:"Skipped beads. Rico's prayers unanswered." },
    sunscreen:       { type:'swipe_seq',car:false, gen:()=>['L','R','L'],  instruct:()=>'Apply sunscreen: LEFT → RIGHT → LEFT',                          fail:'Chad is burning. He is NOT happy.' },
    hairspray:       { type:'timing',   car:false, gen:()=>null,           instruct:()=>'Hairspray — tap when the bar hits the sweet spot',              fail:"Helmet-hair catastrophe. Chad is devastated." },
    croissant:       { type:'timing',   car:false, gen:()=>null,           instruct:()=>"Hand him the croissant — tap when he opens his mouth",          fail:"Missed his mouth. Fabrice is appalled." },
};

function sc_generateTasks(driver, lap) {
    const carPool = sc_shuffle(['lug_nuts', 'fuel', 'air_gun', 'squeegee']);
    const sigPool = sc_shuffle([...driver.signatureTasks]);
    const carCount = lap === 1 ? 1 : 2;
    const divaCount = lap === 1 ? 1 : 2;
    const picked = sc_shuffle([...carPool.slice(0, carCount), ...sigPool.slice(0, divaCount)]);
    return picked.map((taskId, idx) => {
        const def = SC_TASK_DEFS[taskId];
        const target = def.gen();
        return {
            id: `${taskId}_${idx}`,
            taskId,
            type: def.type,
            car: def.car,
            target,
            instructorLabel: def.instruct(target),
            driverLabel: taskId.replace(/_/g, ' ').toUpperCase(),
            completed: false,
            quality: 0,
        };
    });
}

function sc_calcQuality(type, target, result) {
    switch (type) {
        case 'crank': {
            const diff = Math.abs((result.rotations || 0) - target);
            return diff <= 0.3 ? 1.0 : Math.max(0, 1 - diff * 0.4);
        }
        case 'gauge': {
            const diff = Math.abs((result.level || 0) - target);
            return diff <= 0.5 ? 1.0 : Math.max(0, 1 - diff * 0.15);
        }
        case 'tap': {
            const diff = Math.abs((result.count || 0) - target);
            return diff === 0 ? 1.0 : diff === 1 ? 0.65 : diff === 2 ? 0.3 : 0;
        }
        case 'swipe_seq': {
            if (!Array.isArray(result.sequence) || !Array.isArray(target)) return 0;
            if (result.sequence.length !== target.length) return 0;
            return result.sequence.every((v, i) => v === target[i]) ? 1.0 : 0;
        }
        case 'timing': {
            return typeof result.accuracy === 'number' ? Math.max(0, Math.min(1, result.accuracy)) : 0;
        }
        case 'angle': {
            const diff = Math.abs((result.degrees || 0) - target);
            return diff <= 10 ? 1.0 : diff <= 20 ? 0.6 : Math.max(0, 1 - diff / 90);
        }
        case 'dial': {
            return String(result.value) === String(target) ? 1.0 : 0.1;
        }
        default: return 0.5;
    }
}

function sc_calcLapResult(team) {
    const carTasks  = team.currentTasks.filter(t => t.car);
    const divaTasks = team.currentTasks.filter(t => !t.car);
    const carAvg  = carTasks.length  ? carTasks.reduce((s, t)  => s + t.quality, 0) / carTasks.length  : 1;
    const divaAvg = divaTasks.length ? divaTasks.reduce((s, t) => s + t.quality, 0) / divaTasks.length : 1;
    const speed = Math.round(60 + carAvg * 60 + divaAvg * 30);
    const damages = team.currentTasks
        .filter(t => t.quality < 0.4)
        .map(t => ({ taskId: t.taskId, msg: SC_TASK_DEFS[t.taskId]?.fail || 'Something went wrong.' }));
    const newDamageTotal = (team.totalDamage || 0) + damages.length;
    const crashed = newDamageTotal >= 4 && damages.length >= 2;
    return { speed, damages, crashed, newDamageTotal };
}

function sc_assignTeams(room) {
    const shuffled = sc_shuffle(Object.keys(room.players));
    const driverPool = sc_shuffle([...SC_DRIVERS]);
    room.scTeams = [];
    room.scPyroId = null;
    const teamCount = Math.floor(shuffled.length / 2);
    for (let i = 0; i < teamCount; i++) {
        const driver = driverPool[i % driverPool.length];
        const tasksByLap = [1, 2, 3].map(lap => sc_generateTasks(driver, lap));
        room.scTeams.push({
            teamIdx: i,
            instructorId: shuffled[i * 2],
            executorId: shuffled[i * 2 + 1],
            driver,
            tasksByLap,
            currentTasks: [],
            lapSpeeds: [],
            totalDamage: 0,
            allDamages: [],
            crashed: false,
            crashedOnLap: null,
        });
    }
    if (shuffled.length % 2 === 1) room.scPyroId = shuffled[shuffled.length - 1];
}

function sc_startGame(room) {
    room.scPhase = 'ASSIGNING';
    room.scLap = 0;
    room.gamePhase = 'PLAYING';
    room.gameVotes = {};
    sc_assignTeams(room);

    room.scTeams.forEach(team => {
        const instrName = room.players[team.instructorId]?.name || '?';
        const execName  = room.players[team.executorId]?.name  || '?';
        io.to(team.instructorId).emit('scYourRole', { role:'instructor', partner:execName,  driver:team.driver });
        io.to(team.executorId).emit('scYourRole',   { role:'executor',   partner:instrName, driver:team.driver });
    });
    if (room.scPyroId) io.to(room.scPyroId).emit('scYourRole', { role:'pyro', driver:null });

    const teamSummary = room.scTeams.map(t => ({
        teamIdx: t.teamIdx, driver: t.driver,
        instructorName: room.players[t.instructorId]?.name || '?',
        executorName:   room.players[t.executorId]?.name   || '?',
        lapSpeeds: [], crashed: false,
    }));
    broadcastRoom(room, 'scTeamsAssigned', {
        teams: teamSummary,
        pyroName: room.scPyroId ? (room.players[room.scPyroId]?.name || '?') : null,
    });

    setTimeout(() => sc_startPit(room), 4000);
}

function sc_startPit(room) {
    room.scPhase = 'PIT';
    room.scLap++;
    room.scTimeLeft = SC_PIT_SECONDS;

    room.scTeams.forEach(team => {
        if (team.crashed) {
            team.currentTasks = [];
            const crashMsg = { role:'crashed', lap: room.scLap, timeLeft: SC_PIT_SECONDS, driver: team.driver };
            io.to(team.instructorId).emit('scPitStart', crashMsg);
            io.to(team.executorId).emit('scPitStart', crashMsg);
            return;
        }
        team.currentTasks = team.tasksByLap[room.scLap - 1].map(t => ({ ...t, completed: false, quality: 0 }));

        io.to(team.instructorId).emit('scPitStart', {
            role: 'instructor', lap: room.scLap, timeLeft: SC_PIT_SECONDS,
            driver: team.driver,
            tasks: team.currentTasks.map(t => ({
                id: t.id, instructorLabel: t.instructorLabel, driverLabel: t.driverLabel,
                car: t.car, type: t.type, completed: false,
            })),
        });
        io.to(team.executorId).emit('scPitStart', {
            role: 'executor', lap: room.scLap, timeLeft: SC_PIT_SECONDS,
            driver: team.driver,
            tasks: team.currentTasks.map(t => ({
                id: t.id, type: t.type, driverLabel: t.driverLabel, car: t.car, completed: false,
            })),
        });
    });
    if (room.scPyroId) {
        io.to(room.scPyroId).emit('scPitStart', { role:'pyro', lap: room.scLap, timeLeft: SC_PIT_SECONDS });
    }

    room.scTimer = setInterval(() => {
        room.scTimeLeft--;
        broadcastRoom(room, 'scTimer', { phase:'PIT', timeLeft: room.scTimeLeft, lap: room.scLap });
        if (room.scTimeLeft <= 0) { clearInterval(room.scTimer); sc_resolvePit(room); }
    }, 1000);
}

function sc_resolvePit(room) {
    room.scPhase = 'REVEAL';

    const results = room.scTeams.map(team => {
        let speed = 0, damages = [], crashed = team.crashed;
        if (!team.crashed) {
            const r = sc_calcLapResult(team);
            speed = r.speed; damages = r.damages;
            team.lapSpeeds.push(speed);
            team.allDamages.push(...damages);
            team.totalDamage = r.newDamageTotal;
            if (r.crashed) { team.crashed = true; team.crashedOnLap = room.scLap; crashed = true; }
        } else {
            team.lapSpeeds.push(0);
        }
        return {
            teamIdx: team.teamIdx,
            driverName: team.driver.name, driverEmoji: team.driver.emoji, driverId: team.driver.id,
            instructorName: room.players[team.instructorId]?.name || '?',
            executorName:   room.players[team.executorId]?.name   || '?',
            tasks: team.currentTasks.map(t => ({
                driverLabel: t.driverLabel, instructorLabel: t.instructorLabel,
                quality: t.quality, completed: t.completed,
                fail: t.quality < 0.4 ? (SC_TASK_DEFS[t.taskId]?.fail || null) : null,
            })),
            speed, damages, crashed, crashedOnLap: team.crashedOnLap,
        };
    });

    broadcastRoom(room, 'scPitReveal', { lap: room.scLap, results });
    setTimeout(() => sc_startRace(room), SC_REVEAL_SECONDS * 1000);
}

function sc_startRace(room) {
    room.scPhase = 'RACE';
    room.scTimeLeft = SC_RACE_SECONDS;

    const teamSpeeds = room.scTeams.map(t => ({
        teamIdx: t.teamIdx,
        speed: t.lapSpeeds[t.lapSpeeds.length - 1] || 0,
        crashed: t.crashed,
        driver: t.driver,
        instructorName: room.players[t.instructorId]?.name || '?',
        executorName:   room.players[t.executorId]?.name   || '?',
    }));

    broadcastRoom(room, 'scRaceStart', { lap: room.scLap, timeLeft: SC_RACE_SECONDS, teams: teamSpeeds });

    // Send next pit preview to instructors (they see upcoming tasks while car drives)
    if (room.scLap < SC_LAPS) {
        room.scTeams.forEach(team => {
            const nextTasks = team.tasksByLap[room.scLap]; // room.scLap is current, next is +1 (0-indexed)
            if (nextTasks) {
                io.to(team.instructorId).emit('scNextPitPreview', {
                    tasks: nextTasks.map(t => ({ instructorLabel: t.instructorLabel, car: t.car, type: t.type })),
                });
            }
        });
    }

    room.scTimer = setInterval(() => {
        room.scTimeLeft--;
        broadcastRoom(room, 'scTimer', { phase:'RACE', timeLeft: room.scTimeLeft, lap: room.scLap });
        if (room.scTimeLeft <= 0) {
            clearInterval(room.scTimer);
            if (room.scLap >= SC_LAPS) sc_endGame(room); else sc_startPit(room);
        }
    }, 1000);
}

function sc_endGame(room) {
    room.scPhase = 'END';
    room.gamePhase = 'END';
    const standings = room.scTeams
        .map(t => ({
            teamIdx: t.teamIdx,
            driver: t.driver,
            instructorName: room.players[t.instructorId]?.name || '?',
            executorName:   room.players[t.executorId]?.name   || '?',
            totalSpeed: t.lapSpeeds.reduce((s, v) => s + v, 0),
            lapSpeeds: t.lapSpeeds,
            crashed: t.crashed,
            crashedOnLap: t.crashedOnLap,
            allDamages: t.allDamages,
        }))
        .sort((a, b) => {
            if (a.crashed && !b.crashed) return 1;
            if (!a.crashed && b.crashed) return -1;
            return b.totalSpeed - a.totalSpeed;
        });
    broadcastRoom(room, 'scGameEnd', { standings });
}

function sc_returnToLobby(room) {
    clearInterval(room.scTimer); clearTimeout(room.scTimer);
    room.scPhase = 'LOBBY'; room.scTeams = []; room.scLap = 0;
    room.scPyroId = null; room.scTimeLeft = 0; room.gamePhase = 'LOBBY';
    broadcastGameState(room);
}

// ─── Socket connections ────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log('🟢 Connected:', socket.id);

    // ── Hub: room management ──────────────────────────────────────────────────

    socket.on('createRoom', () => {
        // Global cap so memory can't be exhausted by room spam
        if (Object.keys(rooms).length >= MAX_ACTIVE_ROOMS) {
            socket.emit('joinError', { message: 'Server is busy — too many active rooms. Try again shortly.' });
            return;
        }
        // Per-socket rate limit
        const now = Date.now();
        socket.data.createTimes = (socket.data.createTimes || []).filter(t => now - t < CREATE_WINDOW_MS);
        if (socket.data.createTimes.length >= CREATE_MAX_IN_WINDOW) {
            socket.emit('joinError', { message: 'Slow down — you\'re creating rooms too fast.' });
            return;
        }
        socket.data.createTimes.push(now);

        const code = makeCode();
        rooms[code] = makeRoom(code);
        socket.join(code);
        socket.emit('roomCreated', { code });
        console.log(`🏠 Room created: ${code} (${Object.keys(rooms).length} active)`);
    });

    socket.on('joinRoom', ({ code, playerData }) => {
        code = (code || '').toUpperCase().trim();
        const room = getRoom(code);
        if (!room) { socket.emit('joinError', { message: 'Room not found.' }); return; }

        const token = playerData.token || socket.id;

        // Player cap — but never block a returning player (reconnect / refresh)
        const isReturning = Object.values(room.players).some(p => p.token === token)
            || room.seekerToken === token || room.hostToken === token || !!room.playerState[token];
        if (!isReturning && Object.keys(room.players).length >= MAX_PLAYERS_PER_ROOM) {
            socket.emit('joinError', { message: `Room is full (max ${MAX_PLAYERS_PER_ROOM} players).` });
            return;
        }

        // Evict any stale socket sharing this token (page refresh / duplicate tab / reconnect)
        const staleId = Object.keys(room.players).find(id => room.players[id].token === token && id !== socket.id);
        if (staleId) {
            // Cancel pending 30s eviction timer — player came back in time
            if (disconnectTimers[staleId]) {
                clearTimeout(disconnectTimers[staleId]);
                delete disconnectTimers[staleId];
            }
            const staleSock = io.sockets.sockets.get(staleId);
            if (staleSock) { staleSock.leave(code); staleSock.emit('kicked', { reason: 'reconnected' }); }
            // Rekey per-game state (ppHands, ppVotes, sqMatchups, etc.) to the new id
            // BEFORE deleting old records so nothing is orphaned
            rekeySocketState(room, staleId, socket.id);
            delete room.players[staleId];
            delete room.avatars[staleId];
            delete room.lastReactionTimes[staleId];
            if (room.hostSocketId === staleId) room.hostSocketId = socket.id;
            if (room.seekerSocketId === staleId) room.seekerSocketId = socket.id;
            if (room.seekerSocketIds.includes(staleId)) {
                room.seekerSocketIds = room.seekerSocketIds.map(id => id === staleId ? socket.id : id);
            } else {
                room.seekerSocketIds = room.seekerSocketIds.filter(id => id !== staleId);
            }
            delete room.seekerPokes[staleId]; delete room.seekerCameras[staleId];
            console.log(`🔄 Evicted stale session for ${playerData.name} (${staleId} → ${socket.id})`);
        }

        socket.join(code);
        const restored = room.playerState[token] || { isDead: false };

        room.players[socket.id] = {
            id: socket.id, token,
            name: sanitizeName(playerData.name),
            x: typeof playerData.x === 'number' ? playerData.x : 500,
            y: typeof playerData.y === 'number' ? playerData.y : 279,
            color: validColor(playerData.color),
            pose: playerData.pose,
            isDead: restored.isDead,
        };
        room.playerState[token] = { isDead: restored.isDead };

        if (room.seekerToken === token) room.seekerSocketId = socket.id;
        // Restore seeker status across a reconnect (was the bug where a seeker
        // who backgrounded the browser came back as a hider and broke the round)
        if (room.seekerTokens && room.seekerTokens.includes(token)) {
            if (!room.seekerSocketIds.includes(socket.id)) room.seekerSocketIds.push(socket.id);
            room.seekerPokes[socket.id] = room.seekerPokesByToken[token] ?? room.seekerPokesLeft ?? 5;
        }
        if (room.hostToken === token) room.hostSocketId = socket.id;
        isHost(room, socket); // auto-assigns host to first joiner if none set yet

        console.log(`👤 ${playerData.name} joined room ${code}`);

        // Catch late-joiners up
        Object.entries(room.feedMaps).forEach(([fi, dataUrl]) => {
            socket.emit('loadMap', { feedIndex: Number(fi), dataUrl, name: room.feedNames[fi] });
        });
        Object.entries(room.avatars).forEach(([id, avatar]) => {
            socket.emit('playerAvatar', { id, avatar });
        });

        socket.emit('selfState', { isDead: room.players[socket.id].isDead });
        broadcastRoom(room, 'updatePlayers', room.players);
        broadcastGameState(room);
        broadcastScores(room);
        if (Object.keys(room.soScores).length > 0) {
            socket.emit('updateSoScores', Object.values(room.soScores));
        }
        if (Object.keys(room.gameVotes).length > 0) {
            socket.emit('gameVotes', { votes: room.gameVotes, players: room.players });
        }
        // Send full game state snapshot so reconnecting clients restore the right screen
        socket.emit('stateSnapshot', buildFullSnapshot(room, socket));
        // (Bad Pitches reconnect: client shows a toast and waits for the next phase broadcast —
        // see the beatbattle case in the client's stateSnapshot handler. A prior per-phase
        // catch-up block here referenced an undefined BB_ROLES_V2 and threw on reconnect during
        // BUILD/LISTEN/VOTE; removed rather than fixed since the whole phase machine is being
        // reworked and the client's generic fallback already handles this fine.)

        room.lastActivity = Date.now();
    });

    socket.on('selectGame', (gameId) => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        room.selectedGame = gameId;
        broadcastGameState(room);
        console.log(`🎮 Room ${room.code} selected game: ${gameId}`);
    });

    socket.on('gameVote', (gameId) => {
        const room = socketRoom(socket);
        if (!room) return;
        room.gameVotes[socket.id] = gameId;
        if (isHost(room, socket)) {
            room.selectedGame = gameId;
            broadcastGameState(room);
        }
        broadcastRoom(room, 'gameVotes', { votes: room.gameVotes, players: room.players });
    });

    // ── Shared player events ──────────────────────────────────────────────────

    socket.on('playerUpdate', (data) => {
        const room = socketRoom(socket);
        if (!room || !room.players[socket.id]) return;
        if (typeof data.x === 'number') room.players[socket.id].x = data.x;
        if (typeof data.y === 'number') room.players[socket.id].y = data.y;
        room.players[socket.id].pose = data.pose;
        room.players[socket.id].color = validColor(data.color, room.players[socket.id].color);
        socket.broadcast.to(room.code).emit('updatePlayers', room.players);
    });

    socket.on('avatarUpdate', ({ avatar }) => {
        const room = socketRoom(socket);
        if (!room || !room.players[socket.id] || !validDataUrl(avatar, 'image', 1.5 * 1024 * 1024)) return;
        room.avatars[socket.id] = avatar;
        socket.broadcast.to(room.code).emit('playerAvatar', { id: socket.id, avatar });
    });

    socket.on('emojiReaction', (data) => {
        const room = socketRoom(socket);
        if (!room) return;
        const now = Date.now();
        if (room.lastReactionTimes[socket.id] && now - room.lastReactionTimes[socket.id] < 2500) return;
        room.lastReactionTimes[socket.id] = now;
        // Broadcast the SERVER-stored name, never the client-sent one (XSS side channel).
        broadcastRoom(room, 'emojiReaction', { emoji: String(data.emoji || '').slice(0, 32), name: room.players[socket.id]?.name || 'Someone' });
    });

    socket.on('claimHost', (token) => {
        const room = socketRoom(socket);
        if (!room) return;
        token = token || (room.players[socket.id] && room.players[socket.id].token) || socket.id;
        if (!room.hostSocketId || room.hostSocketId === socket.id || room.hostToken === token) {
            room.hostSocketId = socket.id; room.hostToken = token;
            socket.emit('hostStatus', { ok: true });
        } else {
            socket.emit('hostStatus', { ok: false, host: (room.players[room.hostSocketId] && room.players[room.hostSocketId].name) || 'another player' });
        }
        broadcastGameState(room);
    });

    socket.on('volunteerSeeker', (data) => {
        const room = socketRoom(socket);
        if (!room) return;
        broadcastRoom(room, 'seekerVolunteer', { name: room.players[socket.id]?.name || 'Someone' });
    });

    // ── Taco Stealth events ───────────────────────────────────────────────────

    socket.on('hostMap', ({ feedIndex, dataUrl, name }) => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        if (!validDataUrl(dataUrl, 'image', 4 * 1024 * 1024)) return;
        room.feedMaps[feedIndex] = dataUrl;
        if (name) room.feedNames[feedIndex] = sanitizeName(name);
        socket.broadcast.to(room.code).emit('loadMap', { feedIndex, dataUrl, name: room.feedNames[feedIndex] });
    });

    socket.on('suggestPhoto', ({ dataUrl, from }) => {
        const room = socketRoom(socket);
        if (!room || room.gamePhase !== 'LOBBY') return;
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/') || dataUrl.length > 2.5 * 1024 * 1024) return;
        const entry = { dataUrl, from: (from || 'Someone').slice(0, 16) };
        room.suggestedPhotos.push(entry);
        if (room.suggestedPhotos.length > 4) room.suggestedPhotos.shift();
        const hostSock = io.sockets.sockets.get(room.hostSocketId);
        if (hostSock) hostSock.emit('photoSuggested', { from: entry.from, dataUrl: entry.dataUrl });
    });

    socket.on('startGame', (data) => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        clearInterval(room.gameTimer);

        const pokeCount = data.pokeCount || 5;
        const allIds = Object.keys(room.players);
        const seekerCount = Math.max(1, Math.min(data.seekerCount || 1, Math.max(1, allIds.length - 1)));
        room.infection = data.infection !== false; // default ON

        // Build the seeker list: start with the chosen one (or random), then fill
        // up to seekerCount with random distinct players.
        const seekerIds = [];
        const chosen = room.players[data.seekerId];
        if (chosen) seekerIds.push(chosen.id);
        const pool = allIds.filter(id => !seekerIds.includes(id));
        while (seekerIds.length < seekerCount && pool.length) {
            seekerIds.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
        }
        if (seekerIds.length === 0 && allIds.length) seekerIds.push(allIds[Math.floor(Math.random() * allIds.length)]);

        room.seekerSocketIds = seekerIds;
        room.seekerSocketId = seekerIds[0] || null;
        room.seekerToken = seekerIds[0] ? room.players[seekerIds[0]].token : null;
        room.seekerTokens = seekerIds.map(id => room.players[id].token);
        room.seekerPokes = {}; room.seekerPokesByToken = {};
        seekerIds.forEach(id => {
            room.seekerPokes[id] = pokeCount;
            room.seekerPokesByToken[room.players[id].token] = pokeCount;
        });
        room.seekerPokesLeft = pokeCount;
        room.seekerCameras = {};
        room.viewportPoints = {};
        room.lastHideTime = data.hideTime || 45;
        room.lastSeekTime = data.seekTime || 120;

        Object.values(room.players).forEach(p => { p.isDead = false; });
        for (const t in room.playerState) delete room.playerState[t];
        broadcastRoom(room, 'updatePlayers', room.players);

        room.gamePhase = 'HIDING';
        room.timeLeft = room.lastHideTime;
        broadcastGameState(room);

        room.lockedSockets = {};
        room.gameTimer = setInterval(() => {
            room.timeLeft--;
            if (room.timeLeft <= 0) { ts_startSeeking(room); return; }
            broadcastGameState(room);
        }, 1000);
    });

    socket.on('tsLockIn', ({ locked }) => {
        const room = socketRoom(socket);
        if (!room || room.gamePhase !== 'HIDING') return;
        if (!room.lockedSockets) room.lockedSockets = {};
        if (locked) room.lockedSockets[socket.id] = true; else delete room.lockedSockets[socket.id];
        // If every hider has locked in, start the seek phase early (don't reveal
        // who's locked — that would pressure people to rush).
        const hiders = Object.values(room.players).filter(p => !room.seekerSocketIds.includes(p.id));
        if (hiders.length > 0 && hiders.every(p => room.lockedSockets[p.id])) {
            ts_startSeeking(room);
        }
    });

    socket.on('resetGame', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        clearInterval(room.gameTimer);
        ts_returnToLobby(room);
        broadcastScores(room);
    });

    socket.on('pokeAt', ({ targetId }) => {
        const room = socketRoom(socket);
        if (!room || !room.seekerSocketIds.includes(socket.id) || room.gamePhase !== 'SEEKING') return;
        const best = (targetId && room.players[targetId]) ? room.players[targetId] : null;
        const validHit = best && !room.seekerSocketIds.includes(best.id) && !best.isDead;
        const myPokes = room.seekerPokes[socket.id] ?? 0;

        if (validHit) {
            // Caught! Play the pickle slide-off.
            best.isDead = true;
            if (best.token) room.playerState[best.token] = { isDead: true };
            const catcher = room.players[socket.id];
            if (catcher) {
                if (!room.scores[catcher.name]) room.scores[catcher.name] = { name: catcher.name, survivals: 0, catches: 0 };
                room.scores[catcher.name].catches += 1;
            }
            broadcastRoom(room, 'updatePlayers', room.players); // others see the slide via isDead
            io.to(best.id).emit('triggerPickleSlide');          // caught player slides off
            io.to(socket.id).emit('pokeResult', { hit: true, name: best.name, pokesLeft: myPokes });
            broadcastScores(room);

            if (!room.infection) {
                // Infection OFF: caught hider is eliminated for good.
                ts_checkReveal(room);
            } else {
                // Infection ON: after the slide, the caught hider becomes a seeker.
                const caughtId = best.id, caughtToken = best.token;
                const nextPokes = Math.max(1, Math.ceil(myPokes / 2));
                setTimeout(() => {
                    const p = room.players[caughtId];
                    if (!p || room.gamePhase !== 'SEEKING') return;
                    p.isDead = false;
                    if (p.token) room.playerState[p.token] = { isDead: false };
                    if (!room.seekerSocketIds.includes(caughtId)) room.seekerSocketIds.push(caughtId);
                    if (caughtToken && !room.seekerTokens.includes(caughtToken)) room.seekerTokens.push(caughtToken);
                    room.seekerPokes[caughtId] = nextPokes;
                    if (caughtToken) room.seekerPokesByToken[caughtToken] = nextPokes;
                    broadcastRoom(room, 'updatePlayers', room.players);
                    broadcastGameState(room); // sends updated seekerSocketIds
                    io.to(caughtId).emit('nowSeeker', { pokesLeft: nextPokes });
                    ts_checkReveal(room);
                }, 1400);
            }
        } else {
            if (myPokes <= 0) { io.to(socket.id).emit('pokeResult', { hit: false, pokesLeft: 0, out: true }); return; }
            room.seekerPokes[socket.id] = myPokes - 1;
            io.to(socket.id).emit('pokeResult', { hit: false, pokesLeft: myPokes - 1 });
        }
    });

    socket.on('seekerCamUpdate', (cam) => {
        const room = socketRoom(socket);
        if (!room || !room.seekerSocketIds.includes(socket.id) || room.gamePhase !== 'SEEKING') return;
        const p = room.players[socket.id];
        room.seekerCameras[socket.id] = { ...cam, name: p?.name || '?', color: p?.color || '#fff' };
        broadcastRoom(room, 'viewportMap', room.seekerCameras);
    });

    // ── Stroke Off events ─────────────────────────────────────────────────────

    socket.on('soStartGame', ({ fakeId }) => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        room.selectedGame = 'strokeoff';
        room.gamePhase = 'PLAYING';
        room.gameVotes = {};
        so_startDrawing(room, fakeId);
    });

    socket.on('soStroke', (stroke) => {
        const room = socketRoom(socket);
        if (!room || room.strokePhase !== 'DRAWING') return;
        if (room.strokeHistory.length >= STROKE_CAP) return;
        const s = sanitizeStroke(stroke, socket.id);
        room.strokeHistory.push(s);
        socket.broadcast.to(room.code).emit('soStroke', s);
    });

    socket.on('soUndo', ({ gid }) => {
        const room = socketRoom(socket);
        if (!room || room.strokePhase !== 'DRAWING') return;
        const prev = room.strokeHistory.length;
        room.strokeHistory = room.strokeHistory.filter(s => !(s.socketId === socket.id && s.gid === gid));
        if (room.strokeHistory.length < prev) {
            broadcastRoom(room, 'soRedraw', { history: room.strokeHistory });
        }
    });

    socket.on('soVote', ({ suspectId }) => {
        const room = socketRoom(socket);
        if (!room || room.strokePhase !== 'VOTE') return;
        if (room.strokeVotes[socket.id]) return; // already voted
        room.strokeVotes[socket.id] = suspectId;

        const voterNames = Object.keys(room.strokeVotes)
            .map(id => room.players[id] ? room.players[id].name : null)
            .filter(Boolean);
        broadcastRoom(room, 'soVoterUpdate', { voterNames });

        if (Object.keys(room.strokeVotes).length >= Object.keys(room.players).length) {
            clearInterval(room.gameTimer);
            so_resolveVotes(room);
        }
    });

    socket.on('soReturnToLobby', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        so_returnToLobby(room);
    });

    // ── Stroke Off (squiggle) events ──────────────────────────────────────────

    socket.on('sqStartGame', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        room.selectedGame = 'squiggle';
        room.gamePhase = 'PLAYING';
        room.gameVotes = {};
        room.sqScores = {};
        sq_startRound(room, 1);
    });

    socket.on('sqStroke', (stroke) => {
        const room = socketRoom(socket);
        if (!room || room.sqPhase !== 'DRAW') return;
        if (!room.sqHistories[socket.id]) room.sqHistories[socket.id] = [];
        if (room.sqHistories[socket.id].length >= STROKE_CAP) return;
        const s = sanitizeStroke(stroke, socket.id);
        room.sqHistories[socket.id].push(s);
    });

    socket.on('sqUndo', ({ gid }) => {
        const room = socketRoom(socket);
        if (!room || room.sqPhase !== 'DRAW' || !room.sqHistories[socket.id]) return;
        room.sqHistories[socket.id] = room.sqHistories[socket.id].filter(s => s.gid !== gid);
        io.to(socket.id).emit('sqRedraw', { history: room.sqHistories[socket.id], squiggle: room.sqSquiggles[socket.id] });
    });

    socket.on('sqVote', ({ matchupIdx, choice }) => {
        const room = socketRoom(socket);
        if (!room || room.sqPhase !== 'BATTLE' || room.sqVotes[socket.id]) return;
        if (matchupIdx !== room.sqCurrentMatchup) return;
        if (choice !== 'p1' && choice !== 'p2') return;
        room.sqVotes[socket.id] = choice;
        if (Object.keys(room.sqVotes).length >= Object.keys(room.players).length) {
            clearInterval(room.sqTimer); clearTimeout(room.sqTimer);
            sq_resolveMatchup(room);
        }
    });

    socket.on('sqReturnToLobby', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        sq_returnToLobby(room);
    });

    // ── PikPic events ─────────────────────────────────────────────────────────

    socket.on('ppStartGame', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        room.selectedGame = 'pikpic';
        pp_startGame(room);
    });

    socket.on('ppUploadPhotos', ({ photos }) => {
        const room = socketRoom(socket);
        if (!room || room.ppPhase !== 'UPLOAD') return;
        if (!Array.isArray(photos) || photos.length === 0) {
            io.to(socket.id).emit('ppUploadError', { msg: 'No photos received — try again.' });
            return;
        }
        let finalPhotos = photos.filter(p => validDataUrl(p, 'image', 800 * 1024)).slice(0, 7);
        while (finalPhotos.length < 7) {
            finalPhotos.push(PP_CURATED[Math.floor(Math.random() * PP_CURATED.length)]);
        }
        room.ppPlayerPhotos[socket.id] = finalPhotos;
        room.ppReady[socket.id] = true;
        pp_broadcastUploadProgress(room);
        const totalCount = Object.keys(room.players).length;
        const readyCount = Object.values(room.ppReady).filter(Boolean).length;
        if (readyCount >= totalCount) pp_dealCards(room);
    });

    socket.on('ppHostDeal', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket) || room.ppPhase !== 'UPLOAD') return;
        Object.keys(room.players).forEach(id => {
            if (!room.ppReady[id]) {
                const needed = 7 - (room.ppPlayerPhotos[id]?.length || 0);
                if (!room.ppPlayerPhotos[id]) room.ppPlayerPhotos[id] = [];
                for (let i = 0; i < needed; i++) {
                    room.ppPlayerPhotos[id].push(PP_CURATED[Math.floor(Math.random() * PP_CURATED.length)]);
                }
                room.ppReady[id] = true;
            }
        });
        pp_dealCards(room);
    });

    socket.on('ppSetClue', ({ cardId, clue }) => {
        const room = socketRoom(socket);
        if (!room || room.ppPhase !== 'CLUE' || socket.id !== room.ppStorytellerId) return;
        if (!clue || !clue.trim()) return;
        pp_receiveClue(room, socket.id, cardId, clue.trim().slice(0, 120));
    });

    socket.on('ppSubmitCard', ({ cardId }) => {
        const room = socketRoom(socket);
        if (!room || room.ppPhase !== 'SUBMIT') return;
        pp_submitCard(room, socket.id, cardId);
    });

    socket.on('ppSwapCard', ({ cardId }) => {
        const room = socketRoom(socket);
        if (!room || room.ppPhase !== 'SUBMIT' || room.ppSubUsed[socket.id]) return;
        if (socket.id === room.ppStorytellerId || room.ppDeck.length === 0) return;
        const hand = room.ppHands[socket.id] || [];
        const cardIdx = hand.findIndex(c => c.cardId === cardId);
        if (cardIdx === -1) return;
        const [removed] = hand.splice(cardIdx, 1);
        room.ppDeck.push(removed);
        hand.push(room.ppDeck.shift());
        room.ppSubUsed[socket.id] = true;
        room.ppHands[socket.id] = hand;
        io.to(socket.id).emit('ppHandUpdate', { hand, subUsed: true });
    });

    socket.on('ppVote', ({ cardId }) => {
        const room = socketRoom(socket);
        if (!room || room.ppPhase !== 'VOTE') return;
        if (socket.id === room.ppStorytellerId || room.ppVotes[socket.id]) return;
        const ownCard = room.ppTable.find(c => c.submitterId === socket.id);
        if (ownCard && ownCard.cardId === cardId) return;
        room.ppVotes[socket.id] = cardId;
        const voterNames = Object.keys(room.ppVotes).map(id => room.players[id]?.name).filter(Boolean);
        broadcastRoom(room, 'ppVoterUpdate', { voterNames });
        const nonStorytellers = Object.keys(room.players).filter(id => id !== room.ppStorytellerId);
        if (Object.keys(room.ppVotes).length >= nonStorytellers.length) {
            clearInterval(room.ppTimer); pp_resolveVotes(room);
        }
    });

    socket.on('ppReturnToLobby', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        pp_returnToLobby(room);
    });

    // ── Rizz or Roast events ──────────────────────────────────────────────────

    socket.on('rrStartGame', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        room.selectedGame = 'rizzorroast';
        rr_startGame(room);
    });

    socket.on('rrSubmitFills', ({ fills }) => {
        const room = socketRoom(socket);
        if (!room || room.rrPhase !== 'FILL') return;
        if (!Array.isArray(fills) || fills.length !== room.rrTemplate.blanks.length) return;
        room.rrPlayerFills[socket.id] = fills.map(f => String(f).slice(0, 30).trim() || '____');
        room.rrFillReady[socket.id] = true;
        rr_broadcastFillProgress(room);
        const total = Object.keys(room.players).length;
        if (Object.values(room.rrFillReady).filter(Boolean).length >= total) {
            clearInterval(room.rrTimer); rr_startRecordPhase(room);
        }
    });

    socket.on('rrSubmitRecording', ({ audio }) => {
        const room = socketRoom(socket);
        if (!room || room.rrPhase !== 'RECORD') return;
        if (typeof audio === 'string' && audio.length < RR_MAX_AUDIO_BYTES) {
            room.rrPlayerRecordings[socket.id] = audio;
        }
        room.rrRecordReady[socket.id] = true;
        const total = Object.keys(room.players).length;
        const readyCount = Object.values(room.rrRecordReady).filter(Boolean).length;
        broadcastRoom(room, 'rrRecordProgress', { readyCount, totalCount: total });
        if (readyCount >= total) { clearInterval(room.rrTimer); rr_launchBattles(room); }
    });

    socket.on('rrVote', ({ votedForId }) => {
        const room = socketRoom(socket);
        if (!room || room.rrPhase !== 'BATTLE') return;
        const battle = room.rrBattles[room.rrCurrentBattle];
        if (!battle) return;
        if (socket.id === battle.p1 || socket.id === battle.p2) return; // can't vote for yourself
        if (battle.votes[socket.id]) return; // already voted
        if (votedForId !== battle.p1 && votedForId !== battle.p2) return;
        battle.votes[socket.id] = votedForId;
        const voters = Object.keys(battle.votes).map(id => room.players[id]?.name).filter(Boolean);
        broadcastRoom(room, 'rrVoteUpdate', { voterCount: voters.length, voterNames: voters });
        const eligible = Object.keys(room.players).filter(id => id !== battle.p1 && id !== battle.p2);
        if (Object.keys(battle.votes).length >= eligible.length) {
            clearInterval(room.rrTimer); rr_resolveBattle(room, room.rrCurrentBattle);
        }
    });

    socket.on('rrNextBattle', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        clearInterval(room.rrTimer); clearTimeout(room.rrTimer);
        room.rrCurrentBattle++;
        rr_runBattle(room, room.rrCurrentBattle);
    });

    socket.on('rrReturnToLobby', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        rr_returnToLobby(room);
    });

    // ── Bad Pitches events ────────────────────────────────────────────────────

    socket.on('bbStartGame', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        room.selectedGame = 'beatbattle';
        bb_startGame(room);
    });

    socket.on('bbPickBreak', ({ idx }) => {
        const room = socketRoom(socket);
        if (!room || room.bbPhase !== 'DIG') return;
        if (room.bbSamples[socket.id]) return; // already picked
        if (!room.bbDigOptions[socket.id]?.includes(idx)) return; // not in your dealt crate
        room.bbSamples[socket.id] = BB_BREAK_CATALOG[idx];
        room.bbUsedIds.add(idx);
        socket.emit('bbBreakPicked', { idx });
        const ids = Object.keys(room.players);
        if (ids.every(id => room.bbSamples[id])) bb_endDig(room);
    });

    // Loop bounds come from the client snapping to its own onset-detected hits, so duration is
    // musical (varies by track tempo/section) rather than a fixed second count — sanity-clamp
    // instead of a tight range. hitCount itself is just metadata (8 or 16) for display/relock.
    socket.on('bbLockChop', ({ start, end, hitCount, rate }) => {
        const room = socketRoom(socket);
        if (!room || room.bbPhase !== 'CHOP') return;
        const dur0 = room.bbSamples[socket.id]?.duration || 180;
        const s = Math.max(0, Math.min(start, dur0));
        const e = Math.max(s + 0.3, Math.min(end, dur0));
        const dur = e - s;
        if (dur < 0.3 || dur > 30) return;
        const hc = [8, 16].includes(hitCount) ? hitCount : 8;
        const r = [0.75, 1, 1.33].includes(rate) ? rate : 1;
        room.bbChops[socket.id] = { start: s, end: e, hitCount: hc, rate: r };
        socket.emit('bbChopLocked', { start: s, end: e, hitCount: hc, rate: r });
        const ids = Object.keys(room.players);
        if (ids.every(id => room.bbChops[id])) {
            clearInterval(room.bbTimer); room.bbTimer = null;
            bb_endChop(room);
        }
    });

    socket.on('bbSubmitSpit', ({ fills, flowPreset, adlib }) => {
        const room = socketRoom(socket);
        if (!room || room.bbPhase !== 'SPIT') return;
        const template = room.bbSpitTemplate;
        if (!template || !Array.isArray(fills) || fills.length !== template.blanks.length) return;
        const cleanFills = fills.map(f => String(f ?? '').trim().slice(0, 30) || '____');
        const oppName = bb_oppNameFor(room, socket.id);
        const filledTemplate = template.template.split('[OPP]').join(oppName);
        room.bbSpitFills[socket.id] = { lines: bb_assembleSpit(filledTemplate, cleanFills) };
        room.bbFlowPreset[socket.id] = ['chipmunk', 'villain', 'straight', 'autotune'].includes(flowPreset) ? flowPreset : 'straight';

        if (adlib && adlib.type === 'recorded' && validDataUrl(adlib.dataUrl, 'audio', RR_MAX_AUDIO_BYTES)) {
            room.bbAdlibs[socket.id] = { type: 'recorded', dataUrl: adlib.dataUrl };
        } else if (adlib && adlib.type === 'canned' && BB_CANNED_ADLIBS.includes(adlib.id)) {
            room.bbAdlibs[socket.id] = { type: 'canned', id: adlib.id };
        } else {
            room.bbAdlibs[socket.id] = null;
        }

        socket.emit('bbSpitLocked');
        const ids = Object.keys(room.players);
        if (ids.every(id => room.bbSpitFills[id])) {
            clearInterval(room.bbTimer); room.bbTimer = null;
            bb_endSpit(room);
        }
    });

    // Direct port of sqVote's gating: no explicit "voting is open" flag needed since a vote
    // arriving during the pre-vote listening window is harmless — matches Stroke Off's behavior.
    socket.on('bbVote', ({ matchupIdx, choice }) => {
        const room = socketRoom(socket);
        if (!room || room.bbPhase !== 'BATTLE' || room.bbVotes[socket.id]) return;
        if (matchupIdx !== room.bbCurrentMatchup) return;
        if (choice !== 'p1' && choice !== 'p2') return;
        room.bbVotes[socket.id] = choice;
        if (Object.keys(room.bbVotes).length >= Object.keys(room.players).length) {
            clearInterval(room.bbTimer); clearTimeout(room.bbTimer);
            bb_resolveMatchup(room);
        }
    });

    socket.on('bbReturnToLobby', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        clearInterval(room.bbTimer); clearTimeout(room.bbTimer); room.bbTimer = null;
        room.bbPhase = 'LOBBY'; room.gamePhase = 'LOBBY'; room.bbRound = 0;
        room.bbMatchups = []; room.bbCurrentMatchup = 0; room.bbByeId = null;
        room.bbSamples = {}; room.bbDigOptions = {}; room.bbChops = {};
        room.bbSpitFills = {}; room.bbFlowPreset = {}; room.bbAdlibs = {};
        room.bbVotes = {}; room.bbRoundScores = {}; room.bbCumScores = {};
        room.bbUsedIds = new Set();
        broadcastRoom(room, 'bbLobby', {});
        broadcastGameState(room);
    });

    // ── Split Crew events ─────────────────────────────────────────────────────

    socket.on('scStartGame', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        room.selectedGame = 'splitcrew';
        sc_startGame(room);
    });

    socket.on('scCompleteTask', ({ taskId, result }) => {
        const room = socketRoom(socket);
        if (!room || room.scPhase !== 'PIT') return;
        const team = room.scTeams.find(t => t.executorId === socket.id);
        if (!team) return;
        const task = team.currentTasks.find(t => t.id === taskId);
        if (!task || task.completed) return;
        const def = SC_TASK_DEFS[task.taskId];
        if (!def) return;
        task.quality = sc_calcQuality(def.type, task.target, result || {});
        task.completed = true;
        const ql = task.quality >= 0.9 ? '✅ Perfect' : task.quality >= 0.6 ? '⚠️ Okay' : '❌ Bad';
        io.to(team.instructorId).emit('scTaskUpdate', { taskId, quality: task.quality, completed: true, qualityLabel: ql });
        io.to(socket.id).emit('scTaskAck', { taskId, quality: task.quality });
    });

    socket.on('scReturnToLobby', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        sc_returnToLobby(room);
    });

    // ── Kick / leave ──────────────────────────────────────────────────────────

    socket.on('kickPlayer', ({ targetId }) => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        if (!room.players[targetId]) return;
        if (disconnectTimers[targetId]) { clearTimeout(disconnectTimers[targetId]); delete disconnectTimers[targetId]; }
        const targetSock = io.sockets.sockets.get(targetId);
        if (targetSock) { targetSock.leave(room.code); targetSock.emit('kicked', { reason: 'removed by host' }); }
        console.log(`🦵 Host kicked ${room.players[targetId].name} from room ${room.code}`);
        evictPlayer(room, targetId);
    });

    socket.on('leaveRoom', () => {
        const room = socketRoom(socket);
        if (!room) return;
        if (disconnectTimers[socket.id]) { clearTimeout(disconnectTimers[socket.id]); delete disconnectTimers[socket.id]; }
        socket.leave(room.code);
        evictPlayer(room, socket.id);
    });

    socket.on('passHost', ({ targetId }) => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        if (!room.players[targetId] || room.players[targetId].disconnected) return;
        room.hostSocketId = targetId;
        room.hostToken = room.players[targetId].token;
        broadcastRoom(room, 'hostChanged', { hostSocketId: targetId });
        console.log(`👑 Host passed to ${room.players[targetId].name} in ${room.code}`);
    });

    socket.on('closeRoom', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        broadcastRoom(room, 'roomClosed', {});
        Object.keys(room.players).forEach(id => {
            if (disconnectTimers[id]) { clearTimeout(disconnectTimers[id]); delete disconnectTimers[id]; }
            const s = io.sockets.sockets.get(id);
            if (s) s.leave(room.code);
        });
        clearAndDeleteRoom(room);
        console.log(`🚪 Room ${room.code} closed by host`);
    });

    // ── Disconnect ────────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
        const room = socketRoom(socket);
        if (!room || !room.players[socket.id]) return;
        const player = room.players[socket.id];
        player.disconnected = true;
        broadcastRoom(room, 'updatePlayers', room.players);
        if (room.gamePhase === 'SEEKING') ts_checkReveal(room);
        pp_recheckProgress(room);
        if (socket.id === room.hostSocketId) { room.hostSocketId = null; transferHostIfNeeded(room); }
        broadcastGameState(room);
        console.log(`🟡 ${player.name} disconnected (grace 30s) from ${room.code}`);
        disconnectTimers[socket.id] = setTimeout(() => {
            delete disconnectTimers[socket.id];
            if (!rooms[room.code]) return;
            evictPlayer(room, socket.id);
        }, 30_000);
    });
});

// ─── Periodic room GC ─────────────────────────────────────────────────────────
// Sweep rooms where all players are disconnected and no activity in 5 minutes.
// Backstop for any disconnect timer that was cancelled or missed.
setInterval(() => {
    const cutoff = Date.now() - 5 * 60 * 1000;
    Object.entries(rooms).forEach(([code, room]) => {
        const hasConnected = Object.values(room.players).some(p => !p.disconnected);
        if (!hasConnected && (room.lastActivity || 0) < cutoff) {
            clearAndDeleteRoom(room);
            console.log(`🗑️  GC swept idle room ${code}`);
        }
    });
}, 3 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 JakeCrate running on port ${PORT}`));

// Exported so a host wrapper (Spawnpoint) can read io for a live player count.
module.exports = { app, server, io };
