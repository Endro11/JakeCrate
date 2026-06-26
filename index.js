const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 });

app.use(express.static('public'));

// ─── Room registry ────────────────────────────────────────────────────────────

const rooms = {};   // code -> room object

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
        seekerSocketId: null,
        seekerToken: null,
        seekerPokesLeft: 0,
        gamePhase: 'LOBBY',   // LOBBY | HIDING | SEEKING | REVEAL
        selectedGame: null,   // 'tacostealth' | 'strokeoff'
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
    };
}

function getRoom(code) { return rooms[code] || null; }

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

// ─── Taco Stealth game logic ──────────────────────────────────────────────────

function ts_tallyScores(room) {
    const hiders = Object.values(room.players).filter(p => p.id !== room.seekerSocketId);
    hiders.filter(p => !p.isDead).forEach(p => {
        if (!room.scores[p.name]) room.scores[p.name] = { name: p.name, survivals: 0, catches: 0 };
        room.scores[p.name].survivals += 1;
    });
    broadcastScores(room);
}

function ts_enterReveal(room) {
    clearInterval(room.gameTimer);
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
    room.gamePhase = 'LOBBY';
    room.timeLeft = 0;
    room.seekerSocketId = null;
    room.seekerToken = null;
    room.seekerPokesLeft = 0;
    Object.values(room.players).forEach(p => { p.isDead = false; });
    for (const t in room.playerState) delete room.playerState[t];
    broadcastRoom(room, 'updatePlayers', room.players);
    broadcastGameState(room);
}

function ts_checkReveal(room) {
    const hiders = Object.values(room.players).filter(p => p.id !== room.seekerSocketId);
    if (hiders.length > 0 && hiders.every(p => p.isDead)) ts_enterReveal(room);
}

// ─── Stroke Off game logic ────────────────────────────────────────────────────

const SO_THEMES = [
    { theme: 'a dog',       emoji: '🐕', parts: ['the head','the body','the front legs','the back legs','the tail','the ears'] },
    { theme: 'a cat',       emoji: '🐈', parts: ['the head','the body','the paws','the tail','the ears','the face'] },
    { theme: 'a house',     emoji: '🏠', parts: ['the roof','the front wall','the door','the windows','the chimney','the yard'] },
    { theme: 'a rocket',    emoji: '🚀', parts: ['the nose cone','the body','the fins','the engine','the flames','the windows'] },
    { theme: 'a pizza',     emoji: '🍕', parts: ['the crust','the sauce','the cheese','the pepperoni','the toppings','the box'] },
    { theme: 'a tree',      emoji: '🌳', parts: ['the trunk','the roots','the left branches','the right branches','the leaves','the top'] },
    { theme: 'a fish',      emoji: '🐟', parts: ['the body','the head','the tail fin','the top fin','the scales','the eye'] },
    { theme: 'a car',       emoji: '🚗', parts: ['the body','the wheels','the windows','the headlights','the doors','the bumper'] },
    { theme: 'a robot',     emoji: '🤖', parts: ['the head','the torso','the arms','the legs','the control panel','the antenna'] },
    { theme: 'a dragon',    emoji: '🐉', parts: ['the head','the body','the wings','the tail','the claws','the fire breath'] },
    { theme: 'a bicycle',   emoji: '🚲', parts: ['the front wheel','the back wheel','the frame','the handlebars','the seat','the pedals'] },
    { theme: 'a castle',    emoji: '🏰', parts: ['the left tower','the right tower','the main gate','the walls','the battlements','the flag'] },
    { theme: 'a penguin',   emoji: '🐧', parts: ['the head','the body','the wings','the feet','the beak','the belly'] },
    { theme: 'a submarine', emoji: '🌊', parts: ['the hull','the conning tower','the propeller','the periscope','the portholes','the torpedo bay'] },
    { theme: 'a cactus',    emoji: '🌵', parts: ['the main trunk','the left arm','the right arm','the spines','the flowers','the pot'] },
    { theme: 'a snowman',   emoji: '⛄', parts: ['the bottom ball','the middle ball','the head','the hat','the scarf','the arms'] },
    { theme: 'a burger',    emoji: '🍔', parts: ['the top bun','the bottom bun','the patty','the lettuce','the cheese','the tomato'] },
];

function so_startDrawing(room, fakeId) {
    const tObj = SO_THEMES[Math.random() * SO_THEMES.length | 0];
    room.strokePrompt = tObj.theme;
    room.strokeTheme = tObj;
    room.strokeFakeId = fakeId;
    room.strokeHistory = [];
    room.strokeVotes = {};
    room.strokePhase = 'DRAWING';
    room.timeLeft = 60;

    // Distribute parts evenly across players
    const playerIds = Object.keys(room.players);
    const shuffled = [...tObj.parts].sort(() => Math.random() - 0.5);
    room.strokePlayerParts = {};
    playerIds.forEach((sid, i) => { room.strokePlayerParts[sid] = shuffled[i % shuffled.length]; });

    Object.keys(room.players).forEach(sid => {
        const isFake = sid === fakeId;
        io.to(sid).emit('strokeStart', {
            theme: tObj.theme,
            emoji: tObj.emoji,
            part: isFake ? '???' : room.strokePlayerParts[sid],
            isFake,
            duration: 60,
        });
    });

    broadcastRoom(room, 'strokePhaseChange', { phase: 'DRAWING', timeLeft: 60 });

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
    room.strokeHistory = [];
    room.strokeVotes = {};
    room.strokePlayerParts = {};
    room.gamePhase = 'LOBBY';
    broadcastGameState(room);
    if (Object.keys(room.soScores).length > 0) {
        broadcastRoom(room, 'updateSoScores', Object.values(room.soScores));
    }
}

// ─── Socket connections ────────────────────────────────────────────────────────

io.on('connection', (socket) => {
    console.log('🟢 Connected:', socket.id);

    // ── Hub: room management ──────────────────────────────────────────────────

    socket.on('createRoom', () => {
        const code = makeCode();
        rooms[code] = makeRoom(code);
        socket.join(code);
        socket.emit('roomCreated', { code });
        console.log(`🏠 Room created: ${code}`);
    });

    socket.on('joinRoom', ({ code, playerData }) => {
        code = (code || '').toUpperCase().trim();
        const room = getRoom(code);
        if (!room) { socket.emit('joinError', { message: 'Room not found.' }); return; }

        socket.join(code);
        const token = playerData.token || socket.id;
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

    socket.on('startGame', (data) => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        clearInterval(room.gameTimer);

        const seeker = room.players[data.seekerId];
        room.seekerSocketId = seeker ? seeker.id : null;
        room.seekerToken = seeker ? seeker.token : null;
        room.seekerPokesLeft = data.pokeCount || 5;
        room.lastHideTime = data.hideTime || 45;
        room.lastSeekTime = data.seekTime || 120;

        Object.values(room.players).forEach(p => { p.isDead = false; });
        for (const t in room.playerState) delete room.playerState[t];
        broadcastRoom(room, 'updatePlayers', room.players);

        room.gamePhase = 'HIDING';
        room.timeLeft = room.lastHideTime;
        broadcastGameState(room);

        room.gameTimer = setInterval(() => {
            room.timeLeft--;
            if (room.timeLeft <= 0) {
                clearInterval(room.gameTimer);
                room.gamePhase = 'SEEKING';
                room.timeLeft = room.lastSeekTime;
                broadcastGameState(room);
                room.gameTimer = setInterval(() => {
                    room.timeLeft--;
                    if (room.timeLeft <= 0) { ts_enterReveal(room); return; }
                    broadcastGameState(room);
                }, 1000);
                return;
            }
            broadcastGameState(room);
        }, 1000);
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
        if (!room || socket.id !== room.seekerSocketId || room.gamePhase !== 'SEEKING') return;
        const best = (targetId && room.players[targetId]) ? room.players[targetId] : null;
        const validHit = best && best.id !== room.seekerSocketId && !best.isDead;

        if (validHit) {
            best.isDead = true;
            if (best.token) room.playerState[best.token] = { isDead: true };
            const seeker = room.players[room.seekerSocketId];
            if (seeker) {
                if (!room.scores[seeker.name]) room.scores[seeker.name] = { name: seeker.name, survivals: 0, catches: 0 };
                room.scores[seeker.name].catches += 1;
            }
            broadcastRoom(room, 'updatePlayers', room.players);
            io.to(best.id).emit('triggerPickleSlide');
            io.to(room.seekerSocketId).emit('pokeResult', { hit: true, name: best.name, pokesLeft: room.seekerPokesLeft });
            broadcastScores(room);
            broadcastGameState(room);
            ts_checkReveal(room);
        } else {
            if (room.seekerPokesLeft <= 0) { io.to(room.seekerSocketId).emit('pokeResult', { hit: false, pokesLeft: 0, out: true }); return; }
            room.seekerPokesLeft--;
            io.to(room.seekerSocketId).emit('pokeResult', { hit: false, pokesLeft: room.seekerPokesLeft });
            broadcastGameState(room);
        }
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

    // ── Disconnect ────────────────────────────────────────────────────────────

    socket.on('disconnect', () => {
        const room = socketRoom(socket);
        if (!room) return;
        if (room.players[socket.id]) {
            console.log(`🔴 ${room.players[socket.id].name} left room ${room.code}`);
            delete room.players[socket.id];
            broadcastRoom(room, 'updatePlayers', room.players);
            if (room.gamePhase === 'SEEKING') ts_checkReveal(room);
        }
        if (socket.id === room.seekerSocketId) room.seekerSocketId = null;
        if (socket.id === room.hostSocketId) room.hostSocketId = null;
        delete room.lastReactionTimes[socket.id];
        delete room.avatars[socket.id];
        broadcastGameState(room);

        // Clean up empty rooms
        if (Object.keys(room.players).length === 0) {
            clearInterval(room.gameTimer);
            clearTimeout(room.revealTimer);
            delete rooms[room.code];
            console.log(`🗑️  Room ${room.code} removed (empty)`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 JakeCrate running on port ${PORT}`));
