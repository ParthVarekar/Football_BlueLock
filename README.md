# Gulmohar Ground — First Person ⚽

**First-person gully football at golden hour.** Every friend is a footballer on the
pitch, seeing the match through their own eyes: dribble, sprint, use skill moves,
and kick the ball wherever you're looking — to pass, to cross, or to score.
2–6 players (3v3 is the sweet spot), two teams, on a hand-painted Indian maidan
rendered like an anime background painting.

![pitch](public/logo.svg)

---

## Quick start (local)

```bash
bun install        # or npm install
bun run dev        # or npm run dev
```

Open **http://localhost:3000**.

- **Practice alone** works immediately and offline — with the AI defender, or
  in **Free play** with nobody else on the pitch —
  no configuration needed.
- **Multiplayer rooms** need Supabase keys (2-minute setup below).

## 2-minute Supabase setup (multiplayer)

The game uses **Supabase Realtime** (broadcast + presence) as its network layer.
There is **zero server code** and **no database setup** — realtime channels need
no tables and no RLS policies.

**Setup — env vars only** (keys are never typed into the game):

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **Project Settings → API**.
3. Copy **Project URL** and the **anon public** key.
4. `.env.local` is already scaffolded in the repo root — uncomment and fill in
   the two lines (or `cp .env.example .env.local`):

```bash
# NEXT_PUBLIC_SUPABASE_URL=https://YOUR-PROJECT.supabase.co
# NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
```

5. Restart `bun run dev`, click **Create a room**, and share the 4-letter code.

## Playing with friends

1. One player creates a room and shares the **4-character code**.
2. Everyone else joins with the code (2–6 players; the 7th is turned away).
3. The **first player in the room is HOST** — they can shuffle teams, move
   players between Saffron and Teal, and start the match.
4. Late joiners receive a full state snapshot and spectate until the next kickoff.
5. If the host leaves, the match ends gracefully, everyone returns to the lobby,
   and the next-oldest player becomes host.

**Match rules:** first to 5 goals, or the higher score after two 3-minute
halves. **Full football rules:** throw-ins (you hold the ball and fling it
with both hands), corners, goal kicks, direct free kicks, penalties, and
offside (flagged when a flagged receiver touches the ball — offside is off in
practice). Slide tackles are the foul mechanic: catch the ball first or the
whistle goes — a foul in the box is a penalty. No goalkeepers (street rules:
defend with your feet). The host can trigger a rematch from the victory screen.

## Controls

### Desktop

| Input | Action |
|---|---|
| **WASD / arrows** | Move (relative to look direction) |
| **Mouse** (pointer lock) | Look — **this is your aim** |
| **Shift** (hold) | Sprint (watch the stamina bar, bottom-left) |
| **LMB** (hold & release) | Charge and kick — power = hold time (1 s = full) |
| Look **down** while kicking | Driven pass / shot |
| Look **up** while kicking | Chip / lob over opponents (dashed arc shows the landing) |
| **RMB** | Quick sidestep cut (works from a standstill, stronger with speed) |
| **Q** | Stepover feint — shoulder sway, then burst |
| **F** | Flick the ball up and over a tackle |
| **C / Ctrl** | Slide tackle — a committed lunge. Win the ball = clean poke; catch an opponent first = **foul** (free kick, or a **penalty** in the box) |
| **E** | **Rainbow** — the ball rolls up your standing leg and heel-flicks over your head (3 s cooldown) |
| **Z** (while holding LMB) | **Rabona** — releases the charged kick cross-legged: ×1.08 power, extra loft, planted-hop animation |
| **X** | **Roulette / Marseille turn** — full 360° spin, ball under your sole, exits forward at speed (4 s cooldown) |
| **V** | **Elastico** — push the ball out one way, snap it hard across the other (side follows your strafe key) |
| **G** | **Cruyff turn** — fake-shot windup, drag the ball behind your standing leg, turn 180° |
| **B** | **Backheel** — clip the ball opposite your facing with a little hop |
| **T** | **Juggle** on/off — rhythmic keepy-uppy (walk speed only). Kick mid-bounce for a **volley**; sprint or T again to drop it |
| *(automatic)* | Any kick with the ball above knee height plays a **scissor volley** instead of the ground swing |
| **R** (solo modes) | Reset the ball to your feet |
| **Esc / P** | Release the mouse / open the menu (with settings) |

### Touch (phones & tablets — controls appear automatically)

- **Left thumb:** virtual joystick to move.
- **Right side:** drag anywhere to look.
- **KICK button** (the big one): hold to charge, release to strike (also takes
  throw-ins).
- **RUN / STEP / TRICKS / CUT / FLICK / SLIDE** buttons for the rest — TRICKS
  opens a tray with **Rainbow, Rabona (works with a held KICK charge), Spin,
  Elastico, Cruyff, Heel and Juggle**.

## Settings

In the main menu and the pause menu (**Settings**):

- **Field of view** — 60° to 100° (default 78°).
- **Mouse sensitivity** — 0.25× to 3× (applies to touch look too).
- **Invert look (Y axis)**.
- **Volume**.
- **Graphics quality** — Low / Medium / High, applied **live**: ink outline
  width, shadow resolution, MSAA, pixel ratio, prop density (skyline, wires,
  hoardings, second tree row), grass tufts and crowd counts. Low is the
  default on touch devices; your choice is remembered.

Everything persists in `localStorage` — no account, no server.

## Solo modes

**Practice** — free solo play with an AI defender that drops off goal-side,
hunts loose balls in its zone, and clears its lines. All the match rules
apply (offside is off) — including throw-ins and penalties against you if you
slide late. Score, celebrate under the petal confetti, and the ball comes
back to your feet. Press **R** any time.

**Free play** — the whole ground to yourself: no AI, no opponents, no
whistles. The compound wall keeps every ball in play, goals still count (and
still celebrate), and the session timer runs as long as you like. Press **R**
to call the ball back to your feet.

## Deploy to Vercel

1. Push this repo to GitHub/GitLab and **Import Project** in Vercel
   (framework auto-detects as Next.js — no config needed).
2. Add the two environment variables for **Production** (and Preview):
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Deploy. That's it — the app is fully client-side; there is no server
   runtime, no database, no websockets of our own.

> Porting note: the game engine lives in `src/game/` and is framework-agnostic
> (Three.js + a thin React shell). The original spec targeted a Vite static
> site; this repo hosts the identical game as a client-rendered Next.js page,
> which also deploys to Vercel with zero config. Moving `src/game/**` into a
> Vite scaffold works as-is.

## Architecture

```
src/game/
├── core/        constants, shared types, math, procedural WebAudio engine
├── net/         Supabase Realtime client (presence roster + broadcast)
├── sim/         input (kb/mouse/touch), local player, ball physics,
│                remote-player interpolation buffers
├── render/      toon BRDF patch, outlines, post grade, world, players,
│                ball, view-model legs, particles, camera rig
├── ui/          React overlays (menu, lobby, HUD, touch controls)
└── Game.ts      orchestrator: state machine + fixed-timestep loop
```

### Netcode model

- Every client is authoritative over **its own transform**, broadcasting at
  **20 Hz**; others interpolate through a **120 ms** buffer.
- The **HOST is the sole arbiter of ball state**: physics, player-ball
  collisions, kick impulses, goals, score, clock, and phases, broadcast at
  **15 Hz**.
- **Local ball prediction:** while the ball is within dribble range of *your*
  player, your client simulates it locally so it sits convincingly at your feet
  even with latency; corrections from the host blend in gently (~200 ms) while
  dribbling and snap cleanly otherwise.
- **Kicks** are requests: the client plays the swing, thump, and grass
  immediately (cosmetic), and the host applies the impulse only after
  validating range and power cap — absurd or out-of-range kicks are silently
  rejected.
- Player-player collisions are a soft local push from the latest known
  positions (unsynced).

### The painted look

- `MeshToonMaterial` with a hand-authored 4-band gradient ramp; the toon BRDF
  (`lights_toon_pars_fragment`) is patched so **darker bands are hue-shifted
  toward violet** — coloured shadows, the heart of cel painting.
- **Inverted-hull outlines** (back-faced shells pushed along smoothed normals,
  constant pixel width) on the ball, goalposts, players, legs, and trees.
- Two-light anime setup: warm golden key (the only shadow caster, sinking as
  the match runs so shadows stretch), strong cool bounce from the opposite
  quarter, weak up-light, violet-grounded hemisphere.
- Gulmohar canopies are **faceted painterly clumps** — every icosahedron face
  carries its own tone from a small blossom palette (vertex colours), and they
  cast **dappled** light via an alpha-tested custom depth material.
- A painted dusk sky (2048px): banded gradient, wide sun glow + halo rings,
  cream-topped cumulus with dusty-rose undersides, cirrus streaks, and two
  layered hill ridges dissolving into the horizon haze.
- The skyline: 20+ city blocks with lit windows, a stepped temple gopuram, a
  radio mast, power poles with sagging wires, painted hoardings, and stepped
  crowd stands on three sides.
- Final grade: split-tone (violet darks / warm paper highlights), lifted
  blacks, paper grain, sRGB. No bloom, no glow — it's a painting.

### Performance

- Fixed-timestep simulation (60 Hz) with a frame-rate-independent renderer —
  the match runs at true speed even on struggling GPUs.
- Graphics presets (Low / Medium / High) switch **at runtime** from the
  settings panel: outline width, shadow map size, MSAA samples, pixel ratio,
  prop density, tuft/crowd counts. Touch devices default to Low.

## Troubleshooting

- **"Multiplayer needs Supabase keys"** — add the two env vars
  (`NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`) to
  `.env.local` and restart the dev server.
- **Room stays empty when friends join** — double-check the code (4 chars) and
  that you all use the same Supabase project.
- **Can't move after kickoff** — click the pitch once to capture the mouse;
  press Esc to release it.
- **Sandbox/preview** — use the Preview Panel; the game is fully client-side
  and works in any modern browser.

---

*Grass kick-ups, marigold petal confetti, distant crows, a faraway temple bell.
Golden hour never ends.* 🌇
