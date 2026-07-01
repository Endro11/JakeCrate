# JakeCrate — Development Handoff

**Last updated:** 2026-07-01  
**Live URL:** https://jakecrate.onrender.com  
**Repo:** GitHub `Endro11/JakeCrate`, branch `master`  
**Deploy:** Push to `master` → Render auto-deploys (free tier, may spin down ~30s first load)

---

## What This Is

A browser-based party game hub for 2–12 players on voice/video call. Players open the URL, one person creates a room and shares the 4-letter code, everyone joins with their name. Host picks a game and starts it.

**Stack:** Node.js + Express + Socket.io (server). Single-file vanilla HTML/CSS/JS client (`public/index.html`, ~5800 lines). No framework, no build step.

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

**Key UI elements (rewritten 2026-07-01 — the drag-and-drop/hold-to-preview description below is stale, replaced twice this session):**
- Every photo everywhere (upload thumbnails, fan cards, result grid, vote carousel, full-screen preview) shares one `.pp-polaroid` CSS frame (white border, thick bottom margin, drop shadow) — previously only the fan had it.
- Upload grid: 4-column grid of polaroid-framed thumbnails, up to 7 photos; file input or selfie camera. `ppResizeToDataUrl`/`ppHandleFiles` (client-side resize to a 600px JPEG) now has a try/catch around the canvas draw/export step — a bug there let odd/old photos throw inside `img.onload` with nothing to catch it, silently hanging the promise forever and killing the rest of that upload batch. Also has a concurrency guard (re-opening the file picker mid-batch no longer interleaves) and a single summary toast instead of one per failure.
- Curated stockpile fill: `ppFillFromCurated()` fills remaining slots with server-side images
- Fan hand: `ppRenderFan(containerId, cards, mode)` — `mode='select'` (Curator choosing a clue card), `'drag'` (others submitting a matching pic), `'browse'` (view-only — used on the idle wait screen so players have their own hand to look at instead of a blank screen while waiting on someone else). Positions are a deterministic per-photo scattered "tossed on a table" jitter (`ppSeedRand`, seeded by cardId, not `Math.random()`) rather than a neat symmetric arc — re-rendering after a swap only moves the swapped photo.
- Tap to enlarge, unified everywhere via `#pp-lightbox`: single tap opens a large polaroid-framed preview with a context-appropriate action button ("Pick this pic" / "Vote this pic") when applicable, or just a close button for pure viewing (upload thumbnails, result grid, idle-wait browsing). There is no hold-gesture and no drag-and-drop — both were removed and replaced by this single system.
- Submit flow: tap a pic (via the lightbox's "Pick this pic" button, or double-tap to skip straight to it) to stage it into the small preview strip, then explicit SUBMIT / SWAP (once) buttons finalize it — not drag-and-drop.
- Vote carousel: swipe/prev-next nav with dots; tap a pic to preview large with a "Vote this pic" button that casts the vote directly (kept at 2 taps total to match the old flow).
- `ppSubUsed` flag: swap zone disabled after one use per round
- User-facing copy says "pic(s)" throughout, not "card(s)" (renamed 2026-07-01) — internal identifiers (`cardId`, `ppSelectCard`, etc.) still say "card" and are unaffected.

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

## Game 7: Bad Pitches (`beatbattle`)

**Display name:** Bad Pitches · Tagline: "Dig for loops, build a beat, layer it up — vote for the best producer"  
**Minimum players:** 2  
**Latest commit:** `d8f2d36` (R1 genre retarget) on top of `d2c5655` (slot-grid redesign)

**How it works:**
1. **R1 — THE RECORD** — a random 78 from Archive.org's `georgeblood` collection, filtered to blues/gospel/boogie/bebop-jazz subjects (retargeted 2026-07-01 — was pulling mostly 1930s-40s big-band/dance-orchestra material, now lands on sample-worthy 40s-50s combo recordings like B.B. King, Charlie Parker, Lightning Hopkins). Everyone sees the CRATE reveal (10s preview with spinning vinyl), then gets 90s to scrub the waveform and lock in a 4/6/8s loop.
2. **R2 — THE BREAK** — a curated drum break is assigned from a hardcoded pool (Ultimate Breaks & Beats). Same CRATE reveal → SCRUB flow, but the waveform auto-zooms to the `breakAt` timestamp so you land on the drums instantly. Scrub header says "FIND THE BREAK."
3. **BUILD (75s)** — slot toggle grid: JAZZ row + DRUMS row across N columns (default 4). Tap any cell to toggle that layer on/off for that slot. +/− buttons add or remove slots. Preview plays 2 full cycles. Lock in submits your beat.
4. **LISTEN** — each player's beat plays back slot-by-slot (sequential slots, simultaneous layers per slot).
5. **VOTE** — players vote for the best beat. Podium shown.

**Slot grid model:**
- Each column = one time slot of length `slotLen` seconds (matches the R1 loop duration: 4, 6, or 8s).
- Beat total duration = `slots.length × slotLen` seconds.
- JAZZ row plays R1 loop buffer (player's locked jazz loop) for each enabled slot.
- DRUMS row plays R2 loop buffer (player's locked drum break loop) for each enabled slot.
- Layers within a slot play simultaneously; slots play end-to-end.

**Drum break pool (hardcoded — never changes without a deploy):**
```js
const BB_DRUM_BREAKS = [
    { title: 'Apache',                      artist: 'Incredible Bongo Band', file: '503.2 Apache.mp3',              breakAt: 0  },
    { title: "Dance To The Drummer's Beat", artist: 'Herman Kelly & Life',   file: "503.3 Dance...",                breakAt: 0  },
    { title: 'Synthetic Substitution',      artist: 'Melvin Bliss',          file: '505.4 Synthetic Substitution.mp3', breakAt: 0 },
    { title: 'Amen Brother',                artist: 'The Winstons',          file: '501.3 Amen Brother.mp3',        breakAt: 83 },
    { title: 'Different Strokes',           artist: 'Syl Johnson',           file: '504.1 Different Strokes.mp3',   breakAt: 0  },
    { title: 'Bongo Rock',                  artist: 'Incredible Bongo Band', file: '503.4 Bongo Rock.mp3',          breakAt: 0  },
    { title: 'Cold Sweat',                  artist: 'James Brown',           file: '506.2 Cold Sweat.mp3',          breakAt: 0  },
    { title: 'Give It Up Or Turn It Loose', artist: 'James Brown',           file: '507.1 Give It Up...',           breakAt: 24 },
];
```
Source: `ultimate-break-beats-complete` identifier on Archive.org. Files served via `/api/bb-audio/:code`.

**Audio architecture:**
- Proxy routes: `/api/bb-audio/:code` (current/drums, `room.bbSampleBytes`), `/api/bb-audio-r1/:code` (R1 jazz, `room.bbR1SampleBytes`)
- Web Audio chain: gain(0.8) → highShelf(6kHz, −8dB) → compressor(−22dB, 4:1) → destination
- R1 jazz buffer: `bbSampleBuffer`. R2 drums buffer: during R2 scrub = `bbSampleBuffer`; at BUILD start, moved to `bbR2LoopBuffer` and R1 jazz re-fetched into `bbSampleBuffer`.
- Scheduled playback: `AudioBufferSourceNode` per layer per slot, `src.start(t, loopStart); src.stop(t + slotLen)`. All nodes tracked in `bbScheduledSrcs[]`; `bbStopScheduled()` stops all of them.
- `bbBreakAt`: state variable set from `bbScrubPhase` event; triggers `bbAutoZoomToBreakAt(t)` after buffer decodes, pre-positioning loop at the break.

**Default loop locks:** `{ start: 5, end: 9, duration: 4, rate: 1 }`  
**Loop durations:** 4 / 6 / 8 seconds (buttons in scrub UI)  
**Constants:** `BB_TOTAL_ROUNDS=2`, `BB_ROUND_TYPES=['sample','break']`, `BB_CRATE_SECS=45`, `BB_SCRUB_SECS=90`, `BB_BUILD_SECS=75`, `BB_VOTE_SECS=45`

**Key server functions:** `bb_startGame` → `bb_startRound` → `bb_beginScrub` → `bb_endScrub` → `bb_beginBuild` → `bb_endBuild` → `bb_listenNext` → `bb_openVote`  
**Key client functions:** `bbShowBuildScreen`, `bbRenderBeatGrid`, `bbToggleSlot`, `bbAddSlot`, `bbRemoveSlot`, `bbPreviewBeat`, `bbBuildSubmit`, `bbPlayListenBeat`, `bbAutoZoomToBreakAt`, `bbStopScheduled`

**Socket events:**
- Server → client: `bbCratePhase`, `bbSampleReady`, `bbScrubPhase`, `bbBuildPhase`, `bbListenPhase`, `bbListenBeat`, `bbVotePhase`, `bbVoteResult`, `bbTimeTick`
- Client → server: `bbStartGame`, `bbLockScrub {start,end,duration,rate}`, `bbSubmitBeat {slots,slotLen}`, `bbVote`, `bbReturnToLobby`

**Rejected designs (don't bring back):**
- 8-row 2×8 step-grid wall (too busy)
- Free-timing finger-drum loop-recorder with quantize/bars/roll/metronome (too open-ended)
- RECORD mouth-sounds + TUNE/deal-a-hand round (too many moving parts; user dropped it in favor of vinyl scrubbing)

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

### Recently resolved / verified non-issues (2026-07-01 Sleight of Hands audit)
- **"Avatar renders as box"** — checked `rebuildHandCanvas()` in `public/index.html`: it correctly clips painted colors to the hand emoji's alpha silhouette via `destination-in` compositing (`handMasks[currentHandIdx]`). Renders as a proper blob, not a box. This item was stale and has been removed from the list below — the "box" some earlier report saw was almost certainly the brief solid-color fallback square shown before the first `rebuildHandCanvas()` pass completes, not a persistent bug.
- **Find Me / undo button overlap** — `#findMeBtn` was positioned at `top:60%`, which on shorter phone screens landed inside `#float-tools`' fixed-height button stack (pinned to `top:50%`, always visible alongside it during HIDING/SEEKING). Moved to `bottom:calc(64px + safe-area)` (bottom-right corner, anchored to the bottom edge instead of a percentage of screen height) so it can't collide with float-tools regardless of screen size. Also found and fixed a related edge case: opening the color/tools drawer (`#ts-drawer`) could still overlap the button on narrow/short screens — `toggleDrawer()` now hides `findMeBtn` while the drawer is open and restores it via `applyChromeVisibility()` on close; `closeDrawer()` (the separate path used when picking a color/hand/flip/lock-in from inside the drawer) was missing that restore call entirely and has been fixed to match.

### High priority
- **TS host end-round / pause:** No button for host to end a Sleight of Hands round early. MasterPieced has `#so-host-end-btn`; TS does not. Re-verified 2026-07-01 (`applyChromeVisibility`/`syncFloatMode` in `public/index.html` and the `index.js` TS socket handlers — no `tsHostEnd`-equivalent exists anywhere) — this is a real, still-missing feature, not stale.

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
32. Bad Pitches (`beatbattle`) added as Game 7 — record/tune/build/battle beat-maker
33. Bad Pitches BUILD iterated twice: rejected the 8-row step-grid and the free-timing loop-recorder; landed on "pick a vibe, tweak one sound at a time" (commit `e8b72db`). Added TUNE round, per-sound color (`bbColorFor`), and tweak-travels-to-battle fix. HANDOFF now covers all 7 games.

### June 30, 2026
34. Bad Pitches completely redesigned (commit `d2c5655`): dropped RECORD/TUNE/mouth-sounds entirely. New flow: R1=jazz vinyl scrub → R2=curated drum break scrub (auto-zoom to break) → BUILD slot grid (JAZZ/DRUMS rows × N slots, toggle per cell) → LISTEN → VOTE. Hardcoded 8 UBB drum breaks with `breakAt` timestamps. Loop durations reverted to 4/6/8s. Slot-based scheduling (`bbScheduledSrcs`). `BB_TOTAL_ROUNDS=2`.

### July 1, 2026
35. Bad Pitches: R1 Archive.org search retargeted from `collection:georgeblood` alone (mostly 1930s-40s big-band/dance-orchestra) to a blues/gospel/boogie/bebop-jazz subject filter with waltz/military-band/dance-orchestra/holiday/symphony excluded — lands on genuinely sample-worthy 40s-50s material (commit `d8f2d36`).
36. PikPic photo-card polish pass 1 (commit `a793113`): fixed a real side-scroll bug where fan cards' rotation math assumed a fixed 72px width and didn't account for cards pivoting from their bottom edge (not center); cards now size dynamically (72-92px) from the fan wrap's real rendered width. Unified tap-to-enlarge across Upload/Result/Fan/Vote into one `#pp-lightbox` system, replacing a separate hold-to-preview overlay that only some screens had.
37. PikPic photo-card polish pass 2 (commit `3a5b267`): unified the polaroid look (white frame, thick bottom margin, shadow) across every photo display, not just the fan. Fan/wait-screen hand layout changed from a neat symmetric arc to a deterministic per-photo scattered "tossed on a table" look. Idle wait screen now shows the player's own hand instead of being blank. Renamed user-facing "card"→"pic" copy throughout. Along the way, found and fixed two pre-existing latent bugs: `calc(env(...)+Npx)` (missing space around the operator) was silently zeroing out padding on every PikPic screen plus the universal podium/Rizz or Roast/Split Crew's pit-stop header (invalid value inside a shorthand `padding` declaration drops the whole declaration); and a global bare `button { flex-grow:1 }` rule was stretching `#pp-lightbox-action` to fill the screen since nothing had a flex override for it.
38. PikPic upload-hang bug fixed (commit `bb8f999`): `ppResizeToDataUrl`'s canvas draw/export had no try/catch inside `img.onload`, so an old/odd-dimension photo throwing there (mobile canvas limits) left the promise hanging forever and silently killed the rest of that upload batch — explains "selecting a batch of older photos, most don't show up, one reappears next time." Fixed with try/catch+reject, a concurrency guard, and a single summary toast.
39. Sleight of Hands UI audit: confirmed "avatar renders as box" was stale (verified `rebuildHandCanvas()` correctly masks to a blob silhouette) and removed it from Known Issues. Confirmed "no host end-round button" is still real (re-checked against `index.js` and `applyChromeVisibility`/`syncFloatMode`). Found and fixed a genuine, always-present UI bug: `#findMeBtn` at `top:60%` overlapped `#float-tools`' undo button on shorter phone screens (float-tools is pinned to `top:50%` with a fixed pixel height, so a percentage-based sibling position wasn't reliably clear of it) — moved to a bottom-right, bottom-anchored position, plus fixed a related edge case where the color/tools drawer could still overlap it (`toggleDrawer`/`closeDrawer` now hide/restore `findMeBtn` correctly around the drawer's open state).
40. None of the above pushed to `origin/master` yet as of this entry (5 commits sitting local, PikPic-only verified via DOM inspection + a synthetic preview, not a live multiplayer playtest).
