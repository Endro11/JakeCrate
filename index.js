const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e7 }); // 50MB for photo uploads

app.use(express.static('public'));

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
        // Bad Pitches state
        bbPhase: 'LOBBY',
        bbRecordings: {},
        bbPool: [],
        bbHands: {},
        bbBeats: {},
        bbMatchups: [],
        bbCurrentMatchup: -1,
        bbScores: {},
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
        'bbRecordings', 'bbHands', 'bbBeats', 'bbScores',
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

const PAINTINGS = [
    {
        title: 'Distracted Boyfriend', artist: 'Antonio Guillem · 2017',
        imageUrl: 'https://i.imgflip.com/1ur9b0.jpg',
        parts: ['the boyfriend turning his head to look','his girlfriend\'s horrified expression beside him','the attractive woman he\'s looking at','the boyfriend\'s outstretched arm','the woman\'s red outfit','the background street and parked cars','the girlfriend\'s hand on her hip','the boyfriend\'s blue t-shirt'],
    },
    {
        title: 'Drake Approving / Disapproving', artist: 'Hotline Bling · 2016',
        imageUrl: 'https://i.imgflip.com/30b1gx.jpg',
        parts: ['top panel: Drake\'s dismissive hand wave','top panel: Drake\'s disgusted side-eye','bottom panel: Drake\'s pointing finger','bottom panel: Drake\'s approving smile','Drake\'s turtleneck and chain','the warm yellow-brown background','the horizontal dividing line between panels','Drake\'s relaxed body language (bottom)'],
    },
    {
        title: 'Woman Yelling at Cat', artist: 'Real Housewives · 2019',
        imageUrl: 'https://i.imgflip.com/345v97.jpg',
        parts: ['the blonde woman pointing and yelling','the woman behind her gesturing','the white cat sitting at the dinner table','the cat\'s flat unimpressed face','the salad plate in front of the cat','the split-screen dividing line','the women\'s dramatic expressions','the cat\'s small front paws on the table'],
    },
    {
        title: 'This Is Fine', artist: 'K.C. Green · 2013',
        imageUrl: 'https://i.imgflip.com/wx5xt.jpg',
        parts: ['the dog sitting calmly at the table','the coffee mug in the dog\'s hand/paw','the orange flames surrounding the room','the burning chair the dog sits on','the dog\'s little hat','the dog\'s calm smiling face','the room\'s flaming walls and ceiling','the open window with fire outside'],
    },
    {
        title: 'Two Buttons', artist: 'Jake Clark · 2016',
        imageUrl: 'https://i.imgflip.com/1g8my4.jpg',
        parts: ['the sweating man\'s panicked face','the left red button','the right red button','the man\'s hovering uncertain hand','the sweat dripping down his forehead','the man\'s wide stressed eyes','the button panel and controls','the man\'s collared shirt'],
    },
    {
        title: 'Spider-Man Pointing', artist: 'Spider-Man TV · 1967',
        imageUrl: 'https://i.imgflip.com/1yxkcp.jpg',
        parts: ['left Spider-Man pointing to the right','right Spider-Man pointing to the left','the web-shooter on left Spidey\'s wrist','the web-shooter on right Spidey\'s wrist','the two pointing index fingers','the red-and-blue costumes','the background setting','both Spideys\' face lenses'],
    },
    {
        title: 'Change My Mind', artist: 'Steven Crowder · 2018',
        imageUrl: 'https://i.imgflip.com/24y43o.jpg',
        parts: ['the man sitting at the folding table','the printed sign on the table','the man\'s crossed arms','the man\'s baseball cap','the outdoor street background','the folding table metal legs','the coffee cup to the side','the man\'s challenging expression'],
    },
    {
        title: 'Surprised Pikachu', artist: 'Pokémon Anime · 2018',
        imageUrl: 'https://i.imgflip.com/3oevdk.jpg',
        parts: ['Pikachu\'s wide-open O-shaped mouth','Pikachu\'s huge round black eyes','the red circle cheek patches','the yellow pointed ears with black tips','Pikachu\'s small stubby arms raised','the pudgy yellow body','the brown stripe markings on back','the blank background'],
    },
    {
        title: 'Gru\'s Plan', artist: 'Despicable Me · 2010',
        imageUrl: 'https://i.imgflip.com/26am.jpg',
        parts: ['Gru pointing approvingly at panel 1','Gru pointing approvingly at panel 2','Gru\'s confused stare at panel 3 (same as panel 1)','the plan board with written steps','Gru\'s yellow scarf','Gru\'s long bald elongated head','Gru\'s overalls and boots','the four-panel grid layout'],
    },
    {
        title: 'Expanding Brain', artist: 'Internet · 2017',
        imageUrl: 'https://i.imgflip.com/1jwhww.jpg',
        parts: ['the small dim brain in panel 1','the slightly glowing brain in panel 2','the brightly lit brain in panel 3','the massive galaxy-filled brain in panel 4','the glowing light halo effects','the panel borders and layout','the text area beside each brain','the increasing radiance from top to bottom'],
    },
    {
        title: 'Disaster Girl', artist: 'Dave Roth · 2007',
        imageUrl: 'https://i.imgflip.com/23ls.jpg',
        parts: ['the young girl\'s evil sideways smirk','the girl looking directly at the camera','the burning house in the background','the firefighters battling the blaze','the fire hose and water stream','the orange flames on the house','the suburban street setting','the girl\'s braided pigtails'],
    },
    {
        title: 'Doge', artist: 'Kabosu the Shiba · 2013',
        imageUrl: 'https://upload.wikimedia.org/wikipedia/en/5/5f/Original_Doge_meme.jpg',
        parts: ['the dog\'s iconic sideways glance','the dog\'s fluffy ruff around the face','the multicolored Comic Sans text floating around','the dog\'s perky pointed ears','the blurry couch/furniture background','the dog\'s visible front paws','the dog\'s small black nose and snout','the dog\'s fluffy body and coat'],
    },
    {
        title: 'One Does Not Simply', artist: 'Lord of the Rings · 2001',
        imageUrl: 'https://i.imgflip.com/1bij.jpg',
        parts: ['Boromir\'s serious stern face','his hand raised in a cautionary gesture','his dark wavy hair','his chainmail and armor','his brown travel cloak','his beard and facial features','the dark stone background of Rivendell','his wide-set earnest eyes'],
    },
    {
        title: 'Success Kid', artist: 'Sammy Griner · 2007',
        imageUrl: 'https://i.imgflip.com/1bhf.jpg',
        parts: ['the baby\'s triumphant raised fist','the sand clenched in his little fist','the baby\'s determined scrunched expression','his furrowed chubby brow','the beach sand in the background','the ocean water behind him','the baby\'s round chubby cheeks','his tiny clenched fingers'],
    },
    {
        title: 'Bad Luck Brian', artist: 'Kyle Craven · 2012',
        imageUrl: 'https://i.imgflip.com/1bik.jpg',
        parts: ['Brian\'s awkward wide forced smile','his large gap-toothed grin','his plaid vest over a collared shirt','his wild reddish hair','his thick-rimmed glasses','the school photo blue background','his braces visible in the smile','his overall dorky yearbook expression'],
    },
    {
        title: 'That Would Be Great', artist: 'Office Space · 1999',
        imageUrl: 'https://i.imgflip.com/1bh8.jpg',
        parts: ['Bill\'s passive-aggressive smug grin','his steepled fingers pressed together','his glasses pushed up on his nose','his business casual striped tie','his blue collared shirt','the office cubicle wall background','his eyebrows raised expectantly','his coffee mug held in one hand'],
    },
];

const MEMORIZE_SECONDS = 20;
const DRAW_SECONDS = 75;

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

    // Assign one part per real player; wrap if more players than parts
    let partIndex = 0;
    Object.keys(room.players).forEach(sid => {
        if (sid === fakeId) { room.strokePlayerParts[sid] = '???'; }
        else { room.strokePlayerParts[sid] = painting.parts[partIndex++ % painting.parts.length]; }
    });

    // Send painting + individual part to each player
    Object.keys(room.players).forEach(sid => {
        io.to(sid).emit('soShowPainting', {
            imageUrl: painting.imageUrl,
            title: painting.title,
            artist: painting.artist,
            yourPart: room.strokePlayerParts[sid],
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
            part: room.strokePlayerParts[sid] || '???',
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
];

function generateSquiggle() {
    const pts = [];
    for (let i = 0; i < 4; i++) {
        pts.push({ x: i * 0.28 + 0.08 + Math.random() * 0.08, y: 0.28 + Math.random() * 0.44 });
    }
    return pts;
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

// ─── Bad Pitches ───────────────────────────────────────────────────────────────

const BB_ROLES = ['kick','snare','hihat','synth','bass','sfx'];
const BB_STEPS = 16;
const BB_TEMPO = 88;
const BB_RECORD_SECS = 60;
const BB_BUILD_SECS = 60;
const BB_BATTLE_SECS = 50; // auto-advance if not all votes in within 50s

function bb_shuffle(arr) { return [...arr].sort(() => Math.random() - 0.5); }

function bb_startGame(room) {
    room.gamePhase = 'PLAYING';
    room.bbPhase = 'RECORD';
    room.bbRecordings = {}; room.bbPool = []; room.bbHands = {};
    room.bbBeats = {}; room.bbMatchups = []; room.bbCurrentMatchup = -1;
    room.bbScores = {};
    const ids = Object.keys(room.players);
    ids.forEach(id => { room.bbScores[id] = 0; });
    room.bbTimeLeft = BB_RECORD_SECS;
    broadcastRoom(room, 'bbRecordPhase', { timeLeft: BB_RECORD_SECS, playerCount: ids.length });
    room.bbTimer = setInterval(() => {
        room.bbTimeLeft--;
        broadcastRoom(room, 'bbTimeTick', { timeLeft: room.bbTimeLeft });
        if (room.bbTimeLeft <= 0) { clearInterval(room.bbTimer); bb_endRecord(room); }
    }, 1000);
}

function bb_endRecord(room) {
    clearInterval(room.bbTimer);
    room.bbPhase = 'BUILD';
    const ids = Object.keys(room.players);
    room.bbPool = [];
    ids.forEach(id => {
        const recs = room.bbRecordings[id] || {};
        BB_ROLES.forEach(role => {
            room.bbPool.push({ id: `${id}_${role}`, ownerId: id, ownerName: room.players[id]?.name || '?', role, dataUrl: recs[role] || null });
        });
    });
    room.bbHands = {};
    ids.forEach(id => {
        const hand = [];
        BB_ROLES.forEach(role => {
            const opts = bb_shuffle(room.bbPool.filter(s => s.role === role));
            if (opts.length) hand.push(opts[0]);
        });
        const dealtIds = new Set(hand.map(s => s.id));
        const extras = bb_shuffle(room.bbPool.filter(s => !dealtIds.has(s.id)));
        for (let i = 0; i < 2 && i < extras.length; i++) hand.push(extras[i]);
        room.bbHands[id] = hand;
    });
    room.bbTimeLeft = BB_BUILD_SECS;
    ids.forEach(id => {
        io.to(id).emit('bbBuildPhase', { hand: room.bbHands[id], timeLeft: BB_BUILD_SECS, tempo: BB_TEMPO });
    });
    room.bbTimer = setInterval(() => {
        room.bbTimeLeft--;
        broadcastRoom(room, 'bbTimeTick', { timeLeft: room.bbTimeLeft });
        if (room.bbTimeLeft <= 0) { clearInterval(room.bbTimer); bb_endBuild(room); }
    }, 1000);
}

function bb_endBuild(room) {
    clearInterval(room.bbTimer);
    room.bbPhase = 'BATTLE';
    const ids = Object.keys(room.players);
    room.bbMatchups = [];
    for (let i = 0; i < ids.length; i++)
        for (let j = i + 1; j < ids.length; j++)
            room.bbMatchups.push({ p1Id: ids[i], p2Id: ids[j], votes: {}, winner: null });
    room.bbCurrentMatchup = -1;
    bb_nextMatchup(room);
}

function bb_nextMatchup(room) {
    if (room.bbTimer) { clearInterval(room.bbTimer); clearTimeout(room.bbTimer); room.bbTimer = null; }
    room.bbCurrentMatchup++;
    if (room.bbCurrentMatchup >= room.bbMatchups.length) { bb_gameOver(room); return; }
    const m = room.bbMatchups[room.bbCurrentMatchup];
    room.bbTimeLeft = BB_BATTLE_SECS;
    broadcastRoom(room, 'bbMatchupStart', {
        matchupNum: room.bbCurrentMatchup + 1,
        totalMatchups: room.bbMatchups.length,
        p1Id: m.p1Id, p1Name: room.players[m.p1Id]?.name || '?',
        p2Id: m.p2Id, p2Name: room.players[m.p2Id]?.name || '?',
        p1Beat: room.bbBeats[m.p1Id] || {},
        p2Beat: room.bbBeats[m.p2Id] || {},
        p1Hand: room.bbHands[m.p1Id] || [],
        p2Hand: room.bbHands[m.p2Id] || [],
        voteTimeLeft: BB_BATTLE_SECS,
    });
    // Countdown timer — ticks and auto-advances if not all votes come in
    room.bbTimer = setInterval(() => {
        room.bbTimeLeft--;
        broadcastRoom(room, 'bbTimeTick', { timeLeft: room.bbTimeLeft });
        if (room.bbTimeLeft <= 0) { clearInterval(room.bbTimer); room.bbTimer = null; bb_endMatchupVote(room); }
    }, 1000);
}

function bb_endMatchupVote(room) {
    const m = room.bbMatchups[room.bbCurrentMatchup];
    if (!m) return;
    let p1v = 0, p2v = 0;
    Object.values(m.votes).forEach(v => { if (v === 'p1') p1v++; else p2v++; });
    m.winner = p1v >= p2v ? 'p1' : 'p2';
    const winnerId = m.winner === 'p1' ? m.p1Id : m.p2Id;
    room.bbScores[winnerId] = (room.bbScores[winnerId] || 0) + 1;
    broadcastRoom(room, 'bbMatchupResult', {
        winner: m.winner, winnerId, winnerName: room.players[winnerId]?.name || '?',
        p1Votes: p1v, p2Votes: p2v,
    });
    setTimeout(() => bb_nextMatchup(room), 3000);
}

function bb_gameOver(room) {
    clearInterval(room.bbTimer); clearTimeout(room.bbTimer); room.bbTimer = null;
    room.bbPhase = 'RESULT';
    room.gamePhase = 'LOBBY';
    const scores = Object.keys(room.players).map(id => ({
        id, name: room.players[id]?.name || '?', wins: room.bbScores[id] || 0,
    })).sort((a, b) => b.wins - a.wins);
    broadcastRoom(room, 'bbGameOver', { scores });
    // Do NOT call broadcastGameState here — that would immediately fire
    // gameState {phase:'LOBBY'} which dismisses the podium before anyone reads it.
    // gameState is sent when the host clicks "Back to Lobby" via bbReturnToLobby.
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
            name: playerData.name,
            x: typeof playerData.x === 'number' ? playerData.x : 500,
            y: typeof playerData.y === 'number' ? playerData.y : 279,
            color: playerData.color,
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

        // Re-sync Bad Pitches: push the player directly to their current screen
        if (room.selectedGame === 'beatbattle' && room.bbPhase !== 'LOBBY') {
            if (room.bbPhase === 'RECORD') {
                socket.emit('bbRecordPhase', { timeLeft: room.bbTimeLeft, playerCount: Object.keys(room.players).length });
            } else if (room.bbPhase === 'BUILD') {
                const myHand = room.bbHands[socket.id];
                if (myHand) socket.emit('bbBuildPhase', { hand: myHand, timeLeft: room.bbTimeLeft, tempo: BB_TEMPO });
            } else if (room.bbPhase === 'BATTLE') {
                const mi = room.bbCurrentMatchup;
                const m = (mi >= 0 && mi < room.bbMatchups.length) ? room.bbMatchups[mi] : null;
                if (m) socket.emit('bbMatchupStart', {
                    matchupIndex: mi, totalMatchups: room.bbMatchups.length,
                    p1Id: m.p1Id, p2Id: m.p2Id,
                    p1Name: room.players[m.p1Id]?.name || '?', p2Name: room.players[m.p2Id]?.name || '?',
                    p1Beat: room.bbBeats[m.p1Id] || {}, p2Beat: room.bbBeats[m.p2Id] || {},
                    p1Hand: room.bbHands[m.p1Id] || [], p2Hand: room.bbHands[m.p2Id] || [],
                    timeLeft: room.bbTimeLeft, scores: room.bbScores,
                });
            }
        }

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
        room.players[socket.id].color = data.color;
        socket.broadcast.to(room.code).emit('updatePlayers', room.players);
    });

    socket.on('avatarUpdate', ({ avatar }) => {
        const room = socketRoom(socket);
        if (!room || !room.players[socket.id] || typeof avatar !== 'string') return;
        room.avatars[socket.id] = avatar;
        socket.broadcast.to(room.code).emit('playerAvatar', { id: socket.id, avatar });
    });

    socket.on('emojiReaction', (data) => {
        const room = socketRoom(socket);
        if (!room) return;
        const now = Date.now();
        if (room.lastReactionTimes[socket.id] && now - room.lastReactionTimes[socket.id] < 2500) return;
        room.lastReactionTimes[socket.id] = now;
        broadcastRoom(room, 'emojiReaction', { emoji: data.emoji, name: data.name });
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
        broadcastRoom(room, 'seekerVolunteer', { name: data.name });
    });

    // ── Taco Stealth events ───────────────────────────────────────────────────

    socket.on('hostMap', ({ feedIndex, dataUrl, name }) => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        room.feedMaps[feedIndex] = dataUrl;
        if (name) room.feedNames[feedIndex] = name;
        socket.broadcast.to(room.code).emit('loadMap', { feedIndex, dataUrl, name });
    });

    socket.on('suggestPhoto', ({ dataUrl, from }) => {
        const room = socketRoom(socket);
        if (!room || room.gamePhase !== 'LOBBY') return;
        if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/') || dataUrl.length > 2.5 * 1024 * 1024) return;
        const entry = { dataUrl, from: (from || 'Someone').slice(0, 16) };
        room.suggestedPhotos.push(entry);
        if (room.suggestedPhotos.length > 4) room.suggestedPhotos.shift();
        const hostSock = io.sockets.sockets.get(room.host);
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
        const s = { socketId: socket.id, x1: stroke.x1, y1: stroke.y1, x2: stroke.x2, y2: stroke.y2, color: stroke.color, size: stroke.size, t: Date.now(), gid: stroke.gid || 0 };
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
        const s = { socketId: socket.id, x1: stroke.x1, y1: stroke.y1, x2: stroke.x2, y2: stroke.y2, color: stroke.color, size: stroke.size, t: Date.now(), gid: stroke.gid || 0 };
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
        let finalPhotos = photos.slice(0, 7);
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

    socket.on('bbSubmitRecordings', ({ recordings }) => {
        const room = socketRoom(socket);
        if (!room || room.bbPhase !== 'RECORD') return;
        room.bbRecordings[socket.id] = recordings || {};
        broadcastRoom(room, 'bbRecordingIn', { playerId: socket.id });
        const ids = Object.keys(room.players);
        if (ids.every(id => room.bbRecordings[id])) {
            clearInterval(room.bbTimer);
            setTimeout(() => bb_endRecord(room), 800);
        }
    });

    socket.on('bbSubmitBeat', ({ beat }) => {
        const room = socketRoom(socket);
        if (!room || room.bbPhase !== 'BUILD') return;
        room.bbBeats[socket.id] = beat || {};
        const ids = Object.keys(room.players);
        if (ids.every(id => room.bbBeats[id])) {
            clearInterval(room.bbTimer);
            setTimeout(() => bb_endBuild(room), 800);
        }
    });

    socket.on('bbVote', ({ vote }) => {
        const room = socketRoom(socket);
        if (!room || room.bbPhase !== 'BATTLE') return;
        const m = room.bbMatchups[room.bbCurrentMatchup];
        if (!m || m.votes[socket.id] || (vote !== 'p1' && vote !== 'p2')) return;
        m.votes[socket.id] = vote;
        const voteCount = Object.keys(m.votes).length;
        const playerCount = Object.keys(room.players).length;
        broadcastRoom(room, 'bbVoteCast', { voteCount, total: playerCount });
        if (voteCount >= playerCount) bb_endMatchupVote(room);
    });

    socket.on('bbReturnToLobby', () => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        clearInterval(room.bbTimer); clearTimeout(room.bbTimer);
        room.bbPhase = 'LOBBY'; room.gamePhase = 'LOBBY';
        room.bbRecordings = {}; room.bbPool = []; room.bbHands = {};
        room.bbBeats = {}; room.bbMatchups = []; room.bbCurrentMatchup = -1; room.bbScores = {};
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
