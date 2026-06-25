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
        // Stroke Off state
        strokePrompt: null,
        strokeFakeId: null,
        strokeHistory: [],    // { socketId, x1, y1, x2, y2, color, size, t }
        strokePhase: 'LOBBY', // LOBBY | DRAWING | REVEAL | VOTE
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

const SO_PROMPTS = [
    'a dog', 'a cat', 'a house', 'a rocket', 'a pizza', 'a tree', 'a fish',
    'a car', 'a robot', 'a dragon', 'a bicycle', 'a banana', 'a castle',
    'a ghost', 'a cactus', 'a penguin', 'a volcano', 'a submarine',
];

function so_startDrawing(room, fakeId) {
    room.strokePrompt = SO_PROMPTS[Math.random() * SO_PROMPTS.length | 0];
    room.strokeFakeId = fakeId;
    room.strokeHistory = [];
    room.strokePhase = 'DRAWING';
    room.timeLeft = 60;

    Object.keys(room.players).forEach(sid => {
        const isFake = sid === fakeId;
        io.to(sid).emit('strokeStart', {
            prompt: isFake ? '???' : room.strokePrompt,
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

function so_startReveal(room) {
    clearInterval(room.gameTimer);
    room.strokePhase = 'REVEAL';
    broadcastRoom(room, 'strokeReveal', {
        history: room.strokeHistory,
        players: Object.values(room.players).map(p => ({ id: p.id, name: p.name, token: p.token })),
        prompt: room.strokePrompt,
    });
}

function so_returnToLobby(room) {
    room.strokePhase = 'LOBBY';
    room.strokePrompt = null;
    room.strokeFakeId = null;
    room.strokeHistory = [];
    room.gamePhase = 'LOBBY';
    broadcastGameState(room);
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
    });

    socket.on('selectGame', (gameId) => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        room.selectedGame = gameId;
        broadcastGameState(room);
        console.log(`🎮 Room ${room.code} selected game: ${gameId}`);
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
        so_startDrawing(room, fakeId);
    });

    socket.on('soStroke', (stroke) => {
        const room = socketRoom(socket);
        if (!room || room.strokePhase !== 'DRAWING') return;
        const s = { socketId: socket.id, x1: stroke.x1, y1: stroke.y1, x2: stroke.x2, y2: stroke.y2, color: stroke.color, size: stroke.size, t: Date.now() };
        room.strokeHistory.push(s);
        socket.broadcast.to(room.code).emit('soStroke', s);
    });

    socket.on('soVote', ({ suspectId }) => {
        const room = socketRoom(socket);
        if (!room) return;
        // Simple: broadcast the vote, let clients tally. Could track server-side later.
        broadcastRoom(room, 'soVote', { voterId: socket.id, suspectId });
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
            delete rooms[room.code];
            console.log(`🗑️  Room ${room.code} removed (empty)`);
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 JakeCrate running on port ${PORT}`));
