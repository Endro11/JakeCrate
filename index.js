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

const PAINTINGS = [
    {
        title: 'Mona Lisa', artist: 'Leonardo da Vinci · c.1503',
        imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Mona_Lisa%2C_by_Leonardo_da_Vinci%2C_from_C2RMF_retouched.jpg?width=900',
        parts: ['her face and enigmatic smile','her hands folded in her lap','her hair, veil, and dark headband','her dress, neckline, and bodice','the winding road and arch (right background)','the river and bridge (left background)','the misty distant mountains','the shadowy ambience around her'],
    },
    {
        title: 'The Starry Night', artist: 'Vincent van Gogh · 1889',
        imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Van_Gogh_-_Starry_Night_-_Google_Art_Project.jpg?width=900',
        parts: ['the swirling turbulent sky','the large moon and its glowing halo','the eleven bright spiral star clusters','the tall dark cypress tree','the quiet village rooftops below','the church steeple','the rolling dark blue hills','the horizon where sky meets hills'],
    },
    {
        title: 'The Scream', artist: 'Edvard Munch · 1893',
        imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Edvard_Munch%2C_1893%2C_The_Scream%2C_oil%2C_tempera_and_pastel_on_cardboard%2C_91_x_73_cm%2C_National_Gallery_of_Norway.jpg?width=900',
        parts: ['the screaming figure with oval head','the two dark figures walking behind','the blood-red and orange swirling sky','the dark undulating shoreline','the long wooden boardwalk','the dark fjord water below','the swirling wavy landscape lines','the distant ships on the water'],
    },
    {
        title: 'Girl with a Pearl Earring', artist: 'Johannes Vermeer · c.1665',
        imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/1665_Girl_with_a_Pearl_Earring.jpg?width=900',
        parts: ['her face, skin and lips','the large teardrop pearl earring','the blue and yellow wrapped turban','her eyes and direct gaze','the jet-black background','her neck and draped cloth collar','the shadow falling across her face','her slightly open mouth and chin'],
    },
    {
        title: 'The Great Wave off Kanagawa', artist: 'Katsushika Hokusai · c.1831',
        imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Katsushika_Hokusai_-_Thirty-six_Views_of_Mount_Fuji-_The_Great_Wave_Off_the_Coast_of_Kanagawa_-_Google_Art_Project.jpg?width=900',
        parts: ['the giant cresting wave (upper left)','the white foamy claw-like wave tips','the small snow-capped Mount Fuji','the three struggling fishing boats','the smaller background wave swells','the dark navy and indigo water trough','the spray and white seafoam','the pale grey sky above'],
    },
    {
        title: 'The Birth of Venus', artist: 'Sandro Botticelli · c.1485',
        imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Sandro_Botticelli_-_La_nascita_di_Venere_-_Google_Art_Project_-_edited.jpg?width=900',
        parts: ['Venus standing on the giant shell','her long flowing golden hair','the wind god Zephyr blowing (far left)','the flower-scattering nymph with cloth (right)','the stylized sea waves below','the falling rose petals','the trees and shore (far right)','the golden light and pale sky'],
    },
    {
        title: 'Nighthawks', artist: 'Edward Hopper · 1942',
        imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Nighthawks_by_Edward_Hopper_1942.jpg?width=900',
        parts: ['the glowing diner interior','the couple sitting at the counter','the lone man with his back turned','the white-uniformed server behind the counter','the dark empty street outside','the large curved diner window','the green diner exterior trim','the coffee urns and counter items'],
    },
    {
        title: 'American Gothic', artist: 'Grant Wood · 1930',
        imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Grant_Wood_-_American_Gothic_-_Google_Art_Project.jpg?width=900',
        parts: ['the stern man holding a pitchfork','the woman standing at his side','the house with the Gothic arched window','their stern facial expressions','the metal pitchfork itself','the red barn and trees behind them','the man\'s overalls and dark jacket','the woman\'s apron and brooch'],
    },
    {
        title: 'A Sunday on La Grande Jatte', artist: 'Georges Seurat · 1886',
        imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Georges_Seurat_-_A_Sunday_on_La_Grande_Jatte_--_1884_-_Google_Art_Project.jpg?width=900',
        parts: ['the woman with parasol and monkey (right)','the couple strolling in the middle','the men lounging on the grass (left)','the river and sailboats in the distance','the group under the trees (left middle)','the dappled tree shadows on the grass','the small dog in the foreground','the crowd of figures in the middle-distance'],
    },
    {
        title: 'Water Lilies', artist: 'Claude Monet · 1906',
        imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Claude_Monet_-_Water_Lilies_-_1906%2C_Ryerson.jpg?width=900',
        parts: ['the large pink water lily flowers','the round floating lily pad leaves','the sky reflected in the water (upper)','the weeping willow reflections (edges)','the dark murky water between the pads','the loose brushwork and reflections (center)','the lighter warm tones on the right','the heavy shadows and dark green patches'],
    },
    {
        title: 'The Persistence of Memory', artist: 'Salvador Dalí · 1931',
        imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/The_Persistence_of_Memory.jpg?width=900',
        parts: ['the melting watch draped over the ledge','the melting watch draped over the creature','the open watch covered in ants','the solid closed pocket watch with flies','the rocky brown plateau and table','the distant cliffs and small bay','the strange soft central creature','the reflective water on the left'],
    },
    {
        title: 'Las Meninas', artist: 'Diego Velázquez · 1656',
        imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Las_Meninas%2C_by_Diego_Vel%C3%A1zquez%2C_from_Prado_in_Google_Earth.jpg?width=900',
        parts: ['the Infanta Margarita (center)','the two ladies-in-waiting beside her','the large dog lying in the foreground','Velázquez at his easel (far left)','the mirror reflecting the king and queen','the open doorway with standing figure','the dwarfs and courtiers (right side)','the large dark paintings on the back wall'],
    },
];

const MEMORIZE_SECONDS = 20;
const DRAW_SECONDS = 75;

function so_startDrawing(room, fakeId) {
    const painting = PAINTINGS[Math.random() * PAINTINGS.length | 0];
    room.strokePainting = painting;
    room.strokePrompt = painting.title;
    room.strokeTheme = { emoji: '🖼️', theme: painting.title };
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

        const token = playerData.token || socket.id;

        // Evict any stale socket sharing this token (page refresh / duplicate tab)
        const staleId = Object.keys(room.players).find(id => room.players[id].token === token && id !== socket.id);
        if (staleId) {
            const staleSock = io.sockets.sockets.get(staleId);
            if (staleSock) { staleSock.leave(code); staleSock.emit('kicked', { reason: 'reconnected' }); }
            delete room.players[staleId];
            delete room.avatars[staleId];
            delete room.lastReactionTimes[staleId];
            if (room.hostSocketId === staleId) room.hostSocketId = socket.id;
            if (room.seekerSocketId === staleId) room.seekerSocketId = socket.id;
            console.log(`🔄 Evicted stale session for ${playerData.name} (${staleId})`);
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

    socket.on('kickPlayer', ({ targetId }) => {
        const room = socketRoom(socket);
        if (!room || !isHost(room, socket)) return;
        if (!room.players[targetId]) return;
        const targetSock = io.sockets.sockets.get(targetId);
        if (targetSock) { targetSock.leave(room.code); targetSock.emit('kicked', { reason: 'removed by host' }); }
        delete room.players[targetId];
        delete room.avatars[targetId];
        delete room.lastReactionTimes[targetId];
        if (room.seekerSocketId === targetId) room.seekerSocketId = null;
        broadcastRoom(room, 'updatePlayers', room.players);
        broadcastGameState(room);
        console.log(`🦵 Host kicked ${targetId} from room ${room.code}`);
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
