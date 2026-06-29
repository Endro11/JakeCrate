# JakeCrate — Development Handoff

**Last updated:** 2026-06-29  
**Live URL:** https://jakecrate.onrender.com  
**Repo:** GitHub `Endro11/JakeCrate`, branch `master`  
**Deploy:** Push to `master` → Render auto-deploys (free tier, may spin down ~30s first load)

---

## What This Is

A browser-based party game hub for 2–12 players on voice/video call. Players open the URL, one person creates a room and shares the 4-letter code, everyone joins with their name. Host picks a game and starts it.

**Stack:** Node.js + Express + Socket.io (server). Single-file vanilla HTML/CSS/JS client (`public/index.html`, ~4400 lines). No framework, no build step.

**DO NOT run locally on Windows.** npm throws "Exit handler never called" and hangs. Always verify on the Render deployment. Syntax-check server with: `node -e "require('./index.js')"` — a clean run shows `Cannot find module 'express'` (no local deps), not a syntax error.

---

## File Map

```
JakeCrate/
├── index.js              # Server: all game logic, socket handlers (~2100 lines)
├── public/
│   └── index.html        # Entire client: HTML + CSS + JS in one file (~4400 lines)
└── package.json
```

---

## Architecture

### Server (`index.js`)

All state lives in `rooms[code]` — one object per active room. `makeRoom(code)` initializes it. Key shared fields:

```js
{
  code, players, scores, avatars, feedMaps, feedNames, playerState,
  lastReactionTimes, hostSocketId, hostToken, seekerSocketId, seekerToken,
  seekerPokesLeft, gamePhase, selectedGame, strokePainting, timeLeft,
  lastHideTime, lastSeekTime, gameTimer, gameVotes,
  // MasterPieced (strokeoff):
  strokePrompt, strokeTheme, strokeFakeId, strokeHistory, strokeVotes,
  strokePlayerParts, strokePhase, soScores, revealTimer,
  // PikPic:
  ppPhase, ppRound, ppTotalRounds, ppStorytellerId, ppDeck, ppHands,
  ppClue, ppSubmissions, ppSubUsed, ppScores,
  // Rizz or Roast:
  rrPhase, rrPrompts, rrSubmissions, rrRecordings, rrVotes, rrScores,
  // Split Crew: (canvas-rendered, team state tracked per team)
  scPhase, scTeams, scLap, scScores,
  // Squiggle (Stroke Off):
  sqPhase, sqPrompts, sqPairs, sqVotes, sqScores,
}
```

**Helper functions:**
- `socketRoom(socket)` — finds the room a socket is in
- `broadcastRoom(room, event, data)` — emits to all sockets in the room
- `broadcastGameState(room)` — broadcasts `gameState` (phase, timer, seekerSocketId, hostSocketId)
- `isHost(room, socket)` — checks/assigns host
- `transferHostIfNeeded(room)` — promotes next player if host slot is empty

**Token-based dedup:** Each player has a `token` (UUID stored in `localStorage`). On `joinRoom`, if a stale socket with the same token exists, it's evicted. Handles page refreshes and duplicate tabs.

**Player cap:** 12 players per room, max 300 concurrent rooms, rate-limited room creation.

### Client (`public/index.html`)

Screens are absolutely-positioned `<div>` elements layered by z-index, shown/hidden via `display`. Key z-indexes:

| Screen | ID | z-index |
|--------|-----|---------|
| Hub (home) | `#hub-screen` | 50 |
| Room lobby | `#room-lobby` | 48 |
| TS game canvas | `<canvas>` | (base) |
| SO/MP draw screen | `#so-screen` | 45 |
| SO/MP memorize | `#so-memorize-screen` | 46 |
| PikPic screens | `#pp-*-screen` | 55 |
| Rules overlays | `.game-rules-overlay` | 70 |
| TS rules overlay | `#ts-rules-overlay` | 90 (fixed) |

**Key global client variables:**
```js
let socket, inRoom, isRoomHost, isJoined, selectedGame, hostId;
let playerName, myToken, otherPlayers, seekerSocketId;
let gamePhase, isDead, deadAt;
let cHue, cSat, cLight;  // active brush color (HSL)
let activeColor;          // computed CSS color string
let camera = { x, y, scale };
let SPACE_W = 1600, SPACE_H = 900;  // world dimensions
const playerSize = 75;
```

---

## Game 1: Sleight of Hands (`tacostealth`)

**Display name:** Sleight of Hands · Tagline: "Paint your hand to blend in — the seeker pokes to find you"  
**Minimum players:** 2

**How it works:**
1. All hiders place their hand blob on the room photo background (kitchen/dining/drive-thru scenes) and paint it to blend in
2. When seeking starts, the seeker pans/zooms and pokes blobs to identify players
3. Caught players fall off screen. Survivors win.
4. Infection mode: caught hiders become seekers

**Phase flow:** `LOBBY → HIDING → SEEKING → REVEAL → LOBBY`

**Server events → client:**
- `gameState` — phase, timeLeft, seekerSocketId, hostSocketId, pokesLeft
- `updatePlayers` — full player map (positions, colors, isDead, etc.)
- `triggerPickleSlide` — you got poked, you're dead (fall animation)
- `revealResult` — reveal screen with who survived

**Client events → server:**
- `playerMove`, `paintStroke`, `pokeTrigger`, `volunteer`, `startGame`

**UI notes:**
- Floating mode toggle (green=paint / blue=move)
- Right-side tool rail: eyedropper MATCH, color swatch, brush ±, undo, flip, hand menu, whistle, reactions, lock-in
- Lock-in: hider taps lock when satisfied → editing disabled; if all lock in early, seek begins
- Seeker crosshair reticle; poke has 700ms cooldown; poke count = number of players
- `hideSelf = meSeeker() && phase === 'HIDING' || 'SEEKING'` — seeker never sees their own avatar
- Dead animation: `deadSlide(elapsed)` falls 1500px out of world space over 1.2 seconds

**Canvas:** Main `<canvas>` fills viewport. Camera has pan/zoom (pinch mobile, wheel desktop, right-drag desktop). World = 1600×900. Player blobs = 75×75px world space.

**Score tracking (`room.scores[playerName]`):**
- `survivals` — rounds survived
- `catches` — players caught as seeker

---

## Game 2: MasterPieced (`strokeoff`)

**Display name:** MasterPieced · Tagline: "Draw a famous painting from memory — one player is the fake"  
**Minimum players:** 3

**How it works:**
1. A meme image shown to all players for 20 seconds (memorize)
2. Each player gets a different named part of the image to draw from memory (75 seconds)
3. One player is THE FAKE — they get `???` and must bluff
4. After drawing, players vote on who the fake is
5. Fake escapes = fake wins; fake caught = real players win

**Phase flow:** `LOBBY → MEMORIZE → DRAWING → REVEAL → VOTE → RESULT → LOBBY`

**Constants:** `MEMORIZE_SECONDS = 20`, `DRAW_SECONDS = 75`, `SO_REVEAL_MS = 4500`, `SO_VOTE_DURATION = 20`

**Images:** Meme images (replaced original Wikimedia paintings June 2026 — fixed broken URL issue). Each has 8 named `parts`. Parts assigned round-robin; fake gets `???`.

**Server events → client:**
- `soShowPainting` — `{imageUrl, title, artist, yourPart, memorizeSeconds}`
- `soBeginDrawing` — `{prompt, part}`
- `soStroke` — rebroadcasted stroke (real-time sync)
- `soRedraw` — full history redraw after undo
- `soRevealBegin` — `{history, players, prompt}`
- `soRevealNext` — `{player, idx, total}`
- `soVoteOpen` — `{players, prompt, emoji, timeLeft}`
- `soVoteResult` — `{fakeId, fakeName, fakeCaught, tallies, players, soScores}`
- `strokePhaseChange` — `{phase, timeLeft}`

**Client events → server:** `soStroke`, `soUndo`, `soVote`, `soReturnToLobby`

**Canvas:** `<canvas id="so-canvas" width="450" height="800">` (portrait). CSS-scaled to fit. No camera transform — all coordinates are canvas-local.

**Stroke storage:** `room.strokeHistory` = array of `{socketId, x1, y1, x2, y2, color, size, t, gid}`. `gid` (gesture ID) increments per mousedown/touchstart. `soUndo` removes all strokes with matching socketId+gid.

**Thumbnail:** `#so-draw-thumb` shows small version of image during drawing. Tap to eyedrop color. Uses `crossOrigin="anonymous"`.

**Score tracking (`room.soScores[playerName]`):**
- `correct` — correctly voted for the fake
- `fakeWins` — successfully bluffed as the fake

---

## Game 3: Stroke Off (`squiggle`)

**Display name:** Stroke Off · Tagline: "Turn a squiggle into art — 3 rounds, 1v1 battles, crowd votes"  
**Minimum players:** 2 (works best with 4+)

**How it works:**
1. Players receive a random prompt and a pre-drawn squiggle
2. They have drawing time to incorporate the squiggle into their art matching the prompt
3. Pairs of drawings are revealed 1v1; audience votes for their favorite
4. Bracket format: 3 rounds, points scale by round

**Phase flow:** `LOBBY → DRAWING → REVEAL → VOTE → RESULT → LOBBY`

**Socket events:**
- Server → client: `sqRoundStart`, `sqRevealPair`, `sqVoteResult`, `sqFinalResult`
- Client → server: `sqStartGame`, `sqStroke`, `sqVote`

**Canvas:** Same portrait canvas approach as MasterPieced, canvas-local coordinates.

**Score tracking:** Round wins (points scale with round number).

---

## Game 4: PikPic (`pikpic`)

**Display name:** PikPic · Tagline: "Upload your photos, deal a deck, give clues — Dixit with your camera roll"  
**Minimum players:** 3 (works best with 4+)

**How it works:**
1. Each player uploads 7 personal photos (or fills from curated stockpile)
2. Cards dealt from the uploaded pool to each player
3. The Curator (storyteller) picks a card and writes a clue
4. All other players pick a card from their hand that matches the clue
5. Cards shuffled and displayed; players vote for which is the Curator's real card
6. Scoring rewards difficulty balance (everyone guessing = Curator loses points; nobody guessing = also bad)
7. 3 rounds, rotating Curator

**Phase flow:** `LOBBY → UPLOAD → CLUE (Curator) / WAIT (others) → SUBMIT (others) / WAIT (Curator) → VOTE → RESULT → LOBBY`

**Key UI elements:**
- Upload grid: 4-column grid, up to 7 photos; file input or selfie camera
- Curated stockpile fill: `ppFillFromCurated()` fills remaining slots with server-side images
- Fan hand: `ppRenderFan(containerId, cards, mode)` — `mode='select'` for Curator choosing, `mode='drag'` for others submitting
- Hold to preview: hold any fan card 320ms → full-screen overlay
- Touch drag (mode='drag'): `ppBegHold` with `setPointerCapture`, ghost element follows finger, drop on zone = submit; drop on swap zone = swap once
- Drop zones: green "DRAG TO SUBMIT" zone, orange "SWAP (once)" zone
- Vote carousel: swipe-like nav with prev/next buttons + dots; tap image to select, button appears to confirm
- `ppSubUsed` flag: swap zone disabled after one use per round

**Server events → client:**
- `ppRoundStart` — `{round, totalRounds, storytellerId, storytellerName, hand, ppScores, players, subUsed, timeLeft}`
- `ppClueSet` — `{clue, storytellerId, storytellerName}` — shows submit screen to others
- `ppSubmissionCount` — `{submitted, total}` — progress update
- `ppHandUpdate` — `{hand, subUsed}` — after swap
- `ppVoteOpen` — `{cards, clue, timeLeft}` — shuffled cards for voting
- `ppVoteResult` — `{storytellerId, correctCardId, votes, scores, players}`
- `ppRoundEnd` / `ppGameEnd`

**Client events → server:** `ppStartGame`, `ppUploadPhotos`, `ppSetClue`, `ppSubmitCard`, `ppSwapCard`, `ppVote`, `ppReturnToLobby`

**Score tracking (`room.ppScores[playerName]`):**
- Points per round based on vote distribution (Dixit-style)

**Known Android issues (fixed 2026-06-29):**
- ~~Touch drag-to-submit didn't work~~ — fixed via pointer-event drag + `setPointerCapture`
- ~~Hold-to-preview triggered browser context menu~~ — fixed with `oncontextmenu="return false"` + `-webkit-touch-callout:none`

---

## Game 5: Rizz or Roast (`rizzorroast`)

**Display name:** Rizz or Roast · Tagline: "Same madlib, different energy — fill it in, record yourself, go 1v1"  
**Minimum players:** 2

**How it works:**
1. Players receive a madlib template with blanks to fill
2. Each player fills in their version
3. Players record audio delivering their madlib response
4. Audience votes: RIZZ (charming) vs ROAST (savage) for each 1v1 matchup
5. Scoring: 3pts winner, 1pt loser, 2pts each on a tie

**Phase flow:** `LOBBY → FILL → RECORD → PLAYBACK/VOTE → RESULT → LOBBY`

**Socket events:**
- Server → client: `rrRoundStart`, `rrPlayback`, `rrVoteResult`, `rrGameEnd`
- Client → server: `rrStartGame`, `rrSubmitFills`, `rrSubmitRecording`, `rrVote`

**Audio:** Uses `MediaRecorder` API for in-browser audio capture. Recordings sent as blob → server stores and rebroadcasts for playback.

---

## Game 6: Split Crew (`splitcrew`)

**Display name:** Split Crew · Tagline: "One phone reads tasks, one does them — keep your diva driver happy"  
**Minimum players:** 2 (one instructor + one executor per team; scales to multiple teams)

**How it works:**
1. Teams split: one player is the Instructor (reads tasks from their screen), one is the Executor (performs them)
2. Tasks involve gauges, angles, sequences, timing
3. 3 laps; crashes eliminate a team
4. Quality scoring; highest score wins

**Drivers:** Chad, Brittney, Rico, Dale, Yuki, Fabrice — each has a character portrait sprite rendered on a canvas.

**Phase flow:** `LOBBY → RACING (3 laps) → RESULT`

**Socket events:**
- Server → client: `scGameStart`, `scTaskUpdate`, `scCrash`, `scLapComplete`, `scGameEnd`
- Client → server: `scStartGame`, `scCompleteTask`

**Canvas:** Character sprites and racing UI rendered on `<canvas>`. Cranks, dials, and gauges are canvas-drawn interactive elements with `touchstart`/`touchmove` handlers.

**Score tracking:** Tasks completed, quality points, lap times.

---

## Lobby / Room Management

**Flow:**
1. Hub screen → Create Room or Join Room with code (4-letter)
2. Room lobby shows: room code, player list, game picker, start button
3. Host picks game → start button appears
4. Rules overlay shows when game begins (8s, skippable)

**Events:**
- `roomCreated` — `{code}` → client joins and shows lobby
- `updatePlayers` — full player map, re-renders lobby chips
- `hostChanged` — `{hostSocketId}` → updates `isRoomHost`, re-renders
- `roomClosed` — everyone sent back to hub
- `kicked` — removed by host → back to hub

**Host transfer:** When host disconnects/leaves, `transferHostIfNeeded()` assigns crown to next player.

**Player count guards:** Each game has a minimum enforced in `rlStartGame()` before emitting `startGame`.

**Kick:** Host-only per-player button in lobby chips. Emits `kickPlayer({targetId})`.

**Unified scoreboard:** `#unified-scoreboard` in lobby shows cross-game scores for the session.

---

## Rules Overlays

Shown at start of each round, 8 seconds, skippable.

- **SO/MP rules** (`#so-rules-overlay`): shown on `soShowPainting`. `soSkipRules()` clears timer.
- **TS rules** (`#ts-rules-overlay`): shown on `gameState` phase → `HIDING`. Uses `position:fixed` (covers full-viewport canvas).

---

## Color System (TS + MasterPieced)

```js
let cHue, cSat, cLight;   // HSL components
function applyColor() {
    activeColor = `hsl(${cHue},${cSat}%,${cLight}%)`;
}
```

Shared by Sleight of Hands and MasterPieced. Color picker wheel (TS tool rail) and thumbnail eyedropper (MP draw phase) both update these same variables.

---

## Score Display

Unified scoreboard in lobby (`#unified-scoreboard`) aggregates all games.

Per-game scoring:
- **Sleight of Hands:** `survivals`, `catches` (in `room.scores`)
- **MasterPieced:** `correct`, `fakeWins` (in `room.soScores`)
- **Stroke Off:** round wins by bracket position
- **PikPic:** Dixit-style vote distribution (in `room.ppScores`)
- **Rizz or Roast:** 3/1/2pts per matchup
- **Split Crew:** quality + task completion points

---

## Known Issues / Pending Work

### High priority
- **TS host end-round / pause:** No button for host to end a Sleight of Hands round early. MasterPieced has `#so-host-end-btn`; TS does not.
- **Avatar renders as box (TS):** Player blob shows as a box instead of blob silhouette in Sleight of Hands. Likely a canvas render path issue.

### Medium priority
- **Eraser removal:** Both drawing games (MasterPieced + Stroke Off) should remove the eraser tool — keep only Undo. Currently eraser is still present.
- **MasterPieced countdown tick:** Timer countdown has a client-side tick bug (desync or missing decrement).
- **Brush-size label:** Both drawing games — the brush size number should display next to the slider.
- **PC layout for MasterPieced:** Portrait canvas centered in landscape browser is not optimized. Consider info panels beside canvas.
- **Spectator mode:** No way to join mid-game and watch.
- **Sound effects:** Zero audio across all games.
- **Reconnect UX:** Token dedup works silently; no "Reconnecting…" toast.
- **Connection status:** No visual feedback if socket drops.

### Nice to have
- Ready-up system per player before host starts
- Round X of Y display
- Custom room settings via lobby UI
- More meme images for MasterPieced (push to `PAINTINGS` array in `index.js`)
- PikPic: timer visible to Curator while others are submitting

---

## Adding Meme Images (MasterPieced)

Add entries to the `PAINTINGS` array in `index.js`:

```js
{
    title: 'Image Name',
    artist: 'Source · Year',
    imageUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/FILENAME.jpg?width=900',
    parts: [
        'description of part 1',
        // up to 8 parts; fewer is fine, more wraps round-robin
    ],
}
```

Use Wikimedia Commons `Special:FilePath` URLs — CORS-enabled, needed for thumbnail eyedropper.

---

## Deployment

```bash
git add public/index.html index.js   # (or specific files)
git commit -m "description"
git push origin master
# Render auto-deploys. Test on jakecrate.onrender.com
```

Render free tier — first load after idle may take ~30 seconds. Port set via `process.env.PORT`, falls back to 3000.

---

## Session History

### June 26, 2026 (original sessions)
1. 12 famous paintings for MasterPieced (later replaced with memes)
2. Token-based session dedup — no more duplicate player instances on refresh
3. Zoom/pan bug fixes — canvas clamp-before-compute in pinch and wheel handlers
4. Platform-consistent player badges — colored initials circles
5. Host kick button in lobby
6. Eraser + undo in both drawing games
7. Drawing bug fix — SO canvas handlers were trapped inside a dead socket handler
8. PEN/ERASE toolbar — two explicit buttons instead of a single toggle
9. Painting thumbnail during SO draw phase with tap-to-eyedrop color picker
10. Rules overlays for both games (8s auto-dismiss, skippable)
11. Host end-round button for MasterPieced
12. Bigger HUD text on desktop (media query)
13. Seeker avatar hidden during HIDING phase
14. Dead fall animation — falls 1500px, fully exits world space
15. Leave Room / Close Room buttons in lobby
16. Host transfer — automatic crown promotion when host disconnects
17. Player count guard — can't start TS with <2 or SO with <3

### June 27–28, 2026
18. PikPic added — full Dixit-style game with photo uploads, fan hand UI, drag-to-submit zones, carousel voting
19. Rizz or Roast added — madlib + audio recording + 1v1 voting
20. Squiggle (Stroke Off) added — squiggle drawing bracket tournament
21. Split Crew added — instructor/executor driving challenge with canvas sprites
22. Game names updated: Taco Stealth → Sleight of Hands, Stroke Off → MasterPieced
23. Replaced Wikimedia paintings with memes in MasterPieced (fixed broken URLs)
24. PikPic UX overhaul — fan hand, curated stockpile, swap zone, carousel vote, pinch-to-zoom on memorize
25. PikPic session hardening — reconnect, token dedup for photo state
26. Rizz or Roast: dropped romantic framing, now general "rizz vs roast" energy
27. Winner podium added to all games

### June 29, 2026
28. PikPic Android fixes: touch drag-to-submit via `setPointerCapture` + ghost element (HTML5 DnD is desktop-only)
29. PikPic context menu suppression: `oncontextmenu="return false"` + `-webkit-touch-callout:none` on fan cards and vote images
30. Button/layout pass: `.pp-btn` padding reduced, drop zones compacted, fan-wrap height increased to 210px
31. HANDOFF updated to cover all 6 games
