/**
 * GULMOHAR GROUND — FIRST PERSON · Procedural Web Audio engine.
 *
 * Zero assets and zero imports: every sound is synthesized from oscillators,
 * two shared noise buffers and biquad filters, mixed through a single master
 * gain. Positional audio is hand-rolled — stereo pan + distance attenuation
 * plus a rear-muffle lowpass — instead of PannerNode/HRTF, keeping spatial
 * mixing cheap and predictable.
 *
 * One-shot graphs disconnect themselves once their last scheduled source has
 * ended (ref-counted disposal), so nothing leaks. The crowd murmur bed and the
 * rolling-ball loop are persistent nodes created on unlock; their setters only
 * nudge AudioParams. Every public method is safe to call before unlock().
 */

/* ------------------------------------------------------------------ */
/* Tiny helpers                                                        */
/* ------------------------------------------------------------------ */

/** Exponential-ramp floor — 0 is an illegal value for exponential ramps. */
const FLOOR = 0.0001

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** Uniform random in [a, b). */
const rand = (a: number, b: number): number => a + Math.random() * (b - a)

/** ±`amount` detune factor (0.05 → ±5%), applied per play so nothing machine-guns. */
const jitter = (amount: number): number => 1 + rand(-amount, amount)

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Player ears. `yaw` is camera.rotation.y (YXZ order): forward = (-sin, -cos). */
export interface Listener {
  x: number
  z: number
  yaw: number
}

/**
 * Fully procedural sound engine for the maidan. All distances in metres,
 * times in seconds, levels 0..1. One-shots are cheap no-ops until the
 * context is unlocked, running and un-muted; setters store their desired
 * value so unlock() applies it later.
 */
export interface AudioEngine {
  /**
   * Create the AudioContext lazily on the first user gesture and resume it
   * if suspended; also starts the ambient crowd murmur bed at a low level.
   * Subsequent calls resolve immediately without touching the graph.
   */
  unlock(): Promise<void>
  /** Mute → master gain 0. One-shots also short-circuit while muted. */
  setMuted(m: boolean): void
  /** Current mute flag. */
  isMuted(): boolean
  /** Master volume 0..1 (default 0.9). */
  setMaster(v: number): void
  /** Listener pose used to spatialize every positional sound. Copied, not aliased. */
  setListener(l: Listener): void
  /**
   * Per-frame ambient scheduler: a distant crow every ~9–22 s and a faraway
   * temple bell every ~50–100 s, both very quiet. No-op until unlocked.
   */
  update(dt: number): void
  /** Leather kick thump: 70→45 Hz sine drop + band-passed scrape + strike click. `power` 0..1 scales gain. */
  playKick(x: number, z: number, power: number): void
  /** Soft grass tap as the ball is dribbled; slightly louder and longer when sprinting. */
  playTouch(x: number, z: number, sprint: boolean): void
  /** Grass footstep, ±15% random pitch. Quieter when walking; `mine` reads slightly fuller. */
  playFootstep(x: number, z: number, sprint: boolean, mine: boolean): void
  /** Ball bounce thud: ~130 Hz sine + noise puff, volume from `strength` 0..1. */
  playBounce(x: number, z: number, strength: number): void
  /** Metallic goalpost ping: detuned 620/940 Hz sines ringing ~450 ms with a gentle beat. */
  playPost(x: number, z: number): void
  /** Referee pea whistle: ~2100 Hz carrier trilled at ~28 Hz. 'full' = three blasts (0.25 / 0.25 / 0.8 s). */
  playWhistle(kind: 'short' | 'long' | 'full'): void
  /** Quick swish: band-passed noise sweeping 250→1400 Hz over ~130 ms. */
  playCut(x: number, z: number): void
  /** Ball pop for a flick lift: 300→180 Hz blip + tiny fluttering noise tail. */
  playFlick(x: number, z: number): void
  /** Non-spatial soft whoosh for a missed kick. */
  playWhiff(): void
  /** Goal cheer: noise swell through a 300–1400 Hz band plus staggered voice blips. */
  playCheer(): void
  /** Crowd murmur bed level 0..1 (gain = level · 0.12, ramped over ~0.8 s). */
  setCrowdLevel(level: number): void
  /** Per-frame rolling-ball loop: gain/rate from `speed`, pan + attenuation from (x, z). Only nudges persistent params. */
  setBallRoll(speed: number, x: number, z: number): void
  /** One distant crow caw; also fired at random by `update`. */
  playCrow(): void
  /** One faraway temple bell; also fired at random by `update`. */
  playBell(): void
  /** Countdown tick, woodblock-ish: ~1320 Hz (`high`) or ~880 Hz, 60 ms. */
  playTick(high: boolean): void
  /** Small UI blips: click, two-note join, quiet three-note goal banner. */
  playUI(kind: 'click' | 'join' | 'goal-banner'): void

  // ---- EGO supers
  /** Manga cut-in slam: taiko DON + a sword-bright shing. */
  playCutIn(mine: boolean): void
  /** Crimson Dragon roar: stacked detuned saws (the growl beats) + a throat-noise swell. */
  playRoar(x: number, z: number): void
  /** Deep boom when the dragon hits the net. */
  playBoom(x: number, z: number): void
  /** Mountain Bastion: sub rumble + staggered rock cracks. */
  playRumble(x: number, z: number): void
  /** Eagle Talon screech + the wing-rush whoosh. */
  playScreech(): void
  /** A wide airy whoosh (glides, zaps, pulls). */
  playWhoosh(x: number, z: number, strength: number): void
  /** Thunder: whip crack + rolling low tail. */
  playThunder(x: number, z: number): void
  /** Short electric buzz on a sealed player. */
  playZap(x: number, z: number): void
  /** Zero Hour: the low gong + a descending draw-down (start) or the glassy release (end). */
  playTimeStop(start: boolean): void
  /** Gulmohar Cyclone: a howling wind swell lasting `dur` seconds. */
  playWind(x: number, z: number, dur: number): void
}

/* ------------------------------------------------------------------ */
/* Internal types                                                      */
/* ------------------------------------------------------------------ */

/** Hand-rolled spatialization solution for one positional sound. */
interface Spatial {
  /** Stereo pan, -1 (hard left) … +1 (hard right). */
  pan: number
  /** Distance attenuation 1/(1 + (dist/9)^1.7); 1 at the listener's feet. */
  gain: number
  /** Source is behind the listener → ×0.8 gain + extra muffle lowpass. */
  behind: boolean
}

/**
 * Output chain of one sound. Sources connect to `input`; `nodes` collects
 * every node of the graph for disposal; `add` registers a scheduled source
 * and tears the whole chain down once the last one has ended. The ref-count
 * matters: multi-source sounds (kick = thump + scrape + click) must not be
 * disconnected by their first-finishing source.
 */
interface Out {
  input: AudioNode
  nodes: AudioNode[]
  add(src: AudioScheduledSourceNode): void
}

/** Options for `noiseHit`, the one-shot noise-voice workhorse. */
interface NoiseOpts {
  filter: BiquadFilterType
  /** Filter frequency at onset (Hz). */
  freq: number
  q: number
  level: number
  attack: number
  decay: number
  /** Optional sustain between attack and decay (swell instead of hit). */
  hold?: number
  /** Loop the 2 s buffer — for tails longer than the buffer. */
  loop?: boolean
  /** Noise playback rate; default ±12% so no two hits are identical. */
  rate?: number
  /** Exponential filter sweep target. */
  sweepTo?: number
  /** Time to reach `sweepTo`; defaults to 70% of the hit length. */
  sweepTime?: number
  /** After reaching `sweepTo`, sweep back down to this by the end of the hit. */
  sweepBack?: number
}

/** Options for `toneHit`, the one-shot oscillator workhorse. */
interface ToneOpts {
  type: OscillatorType
  freq: number
  level: number
  attack: number
  decay: number
  /** Start this many seconds from now (for staggering). */
  delay?: number
  /** Exponential pitch glide target. */
  slideTo?: number
  /** Time to reach `slideTo`; defaults to the full blip length. */
  slideTime?: number
  /** Optional lowpass between oscillator and gain. */
  lowpass?: number
}

/* ------------------------------------------------------------------ */
/* Noise buffers (built once, on unlock)                               */
/* ------------------------------------------------------------------ */

/** ~2 s of white noise, shared by every noise-based sound. */
function makeWhiteBuffer(ctx: AudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 2)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  return buf
}

/**
 * ~4 s of brown-ish noise for the crowd murmur. A leaky integrator keeps the
 * energy low; subtracting the head→tail line afterwards forces both ends to
 * the same value, which makes the loop click-free without a crossfade.
 */
function makeBrownBuffer(ctx: AudioContext): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * 4)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  let last = 0
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1
    last = (last + 0.04 * white) / 1.04
    d[i] = last
  }
  const head = d[0]
  const tail = d[len - 1]
  for (let i = 0; i < len; i++) d[i] -= head + ((tail - head) * i) / (len - 1)
  let peak = 0
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(d[i]))
  const g = peak > 1e-6 ? 0.9 / peak : 1
  for (let i = 0; i < len; i++) d[i] *= g
  return buf
}

/* ------------------------------------------------------------------ */
/* Spatialization                                                      */
/* ------------------------------------------------------------------ */

const CULL_DIST = 70
const REF_DIST = 9
const FALLOFF_EXP = 1.7

/**
 * Manual 2D spatialization. forward = (-sin yaw, -cos yaw),
 * right = (cos yaw, -sin yaw); pan = dot(delta, right)/dist,
 * gain = 1/(1 + (dist/9)^1.7). Returns null past the 70 m cull radius
 * (the whole 55×35 maidan fits well inside it).
 */
function computeSpatial(x: number, z: number, l: Listener): Spatial | null {
  const dx = x - l.x
  const dz = z - l.z
  const dist = Math.hypot(dx, dz)
  if (dist > CULL_DIST) return null
  const sinY = Math.sin(l.yaw)
  const cosY = Math.cos(l.yaw)
  const pan = dist < 1e-4 ? 0 : clamp((dx * cosY - dz * sinY) / dist, -1, 1)
  const behind = -dx * sinY - dz * cosY < 0
  const gain = 1 / (1 + Math.pow(dist / REF_DIST, FALLOFF_EXP))
  return { pan, gain, behind }
}

/* ------------------------------------------------------------------ */
/* Envelope helpers                                                    */
/* ------------------------------------------------------------------ */

/** Percussive: fast exponential attack, exponential decay down to the floor. */
function envHit(p: AudioParam, t: number, peak: number, attack: number, decay: number): void {
  p.setValueAtTime(FLOOR, t)
  p.exponentialRampToValueAtTime(Math.max(peak, 2 * FLOOR), t + attack)
  p.exponentialRampToValueAtTime(FLOOR, t + attack + decay)
}

/** Swell: attack → hold → long exponential release. */
function envSwell(p: AudioParam, t: number, peak: number, attack: number, hold: number, release: number): void {
  p.setValueAtTime(FLOOR, t)
  p.exponentialRampToValueAtTime(peak, t + attack)
  p.setValueAtTime(peak, t + attack + hold)
  p.exponentialRampToValueAtTime(FLOOR, t + attack + hold + release)
}

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

class AudioEngineImpl implements AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private white: AudioBuffer | null = null
  private brown: AudioBuffer | null = null

  private unlocked = false
  private unlockPromise: Promise<void> | null = null
  private muted = false
  private masterVol = 0.9
  private listener: Listener = { x: 0, z: 0, yaw: 0 }

  /** Persistent crowd murmur bed (created on unlock). */
  private crowdGain: GainNode | null = null
  /** Desired bed level; unlock() applies it, so early calls are not lost. */
  private crowdLevel = 0.35

  /** Persistent rolling-ball loop (created on unlock). */
  private rollSrc: AudioBufferSourceNode | null = null
  private rollTone: BiquadFilterNode | null = null
  private rollMuffle: BiquadFilterNode | null = null
  private rollGain: GainNode | null = null
  private rollPan: StereoPannerNode | null = null
  private rollBehind = false
  private rollLastGain = -1
  private rollLastRate = -1
  private rollLastCut = -1
  private rollLastPan = -2

  /**
   * Ambient timers. First triggers come a little earlier than the recurring
   * windows so the golden-hour setting reads immediately after unlock.
   */
  private crowT = rand(5, 10)
  private bellT = rand(40, 70)
  /** Rate-limit for the suspended-context nudge in `update`. */
  private resumeT = 0

  /* ---------------- lifecycle ---------------- */

  unlock(): Promise<void> {
    if (this.unlocked) return Promise.resolve()
    if (this.unlockPromise === null) this.unlockPromise = this.doUnlock()
    return this.unlockPromise
  }

  /** Creates the context and the persistent graph. Never rejects. */
  private async doUnlock(): Promise<void> {
    let ctx: AudioContext
    try {
      ctx = new AudioContext()
    } catch {
      return // Web Audio unavailable — the engine stays a permanent no-op.
    }
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        /* gesture didn't land; the graph still works once something resumes us */
      }
    }
    try {
      this.ctx = ctx
      const master = ctx.createGain()
      master.gain.value = this.muted ? 0 : this.masterVol
      master.connect(ctx.destination)
      this.master = master
      this.white = makeWhiteBuffer(ctx)
      this.brown = makeBrownBuffer(ctx)
      this.buildCrowdBed()
      this.buildRollLoop()
      this.unlocked = true
      this.applyCrowdLevel() // fade the stored bed level in over ~0.8 s
    } catch {
      // Half-built graph: tear it down and let a later unlock() retry.
      this.ctx = null
      this.master = null
      this.crowdGain = null
      this.rollSrc = null
      this.rollTone = null
      this.rollMuffle = null
      this.rollGain = null
      this.rollPan = null
      this.unlockPromise = null
      ctx.close().catch(() => undefined)
    }
  }

  setMuted(m: boolean): void {
    this.muted = m
    const ctx = this.ctx
    if (ctx !== null && this.master !== null) {
      this.master.gain.setTargetAtTime(m ? 0 : this.masterVol, ctx.currentTime, 0.02)
    }
  }

  isMuted(): boolean {
    return this.muted
  }

  setMaster(v: number): void {
    this.masterVol = clamp(v, 0, 1)
    const ctx = this.ctx
    if (ctx !== null && this.master !== null && !this.muted) {
      this.master.gain.setTargetAtTime(this.masterVol, ctx.currentTime, 0.03)
    }
  }

  setListener(l: Listener): void {
    this.listener = { x: l.x, z: l.z, yaw: l.yaw }
  }

  update(dt: number): void {
    const ctx = this.ctx
    if (ctx === null || !this.unlocked) return
    if (ctx.state !== 'running') {
      // Suspended by the browser (background tab / iOS interruption). Nudge it
      // awake at most every 1.5 s — without a fresh gesture this rejects quietly.
      this.resumeT -= dt
      if (this.resumeT <= 0) {
        this.resumeT = 1.5
        ctx.resume().catch(() => undefined)
      }
      return
    }
    this.crowT -= dt
    if (this.crowT <= 0) {
      this.crowT = rand(9, 22)
      this.playCrow()
    }
    this.bellT -= dt
    if (this.bellT <= 0) {
      this.bellT = rand(50, 100)
      this.playBell()
    }
  }

  /* ---------------- one-shot gameplay sounds ---------------- */

  playKick(x: number, z: number, power: number): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 1)
    if (out === null) return
    const p = clamp(power, 0, 1)
    const j = jitter(0.05)
    // Leather thump: 70→45 Hz sine drop over ~90 ms.
    this.toneHit(ctx, out, {
      type: 'sine',
      freq: 70 * j,
      slideTo: 45 * j,
      slideTime: 0.09,
      level: 0.58 * (0.3 + 0.7 * p),
      attack: 0.004,
      decay: 0.135,
    })
    // Boot scrape: band-passed burst across ~400–900 Hz.
    this.noiseHit(ctx, out, {
      filter: 'bandpass',
      freq: 650 * j,
      q: 1.2,
      level: 0.27 * (0.35 + 0.65 * p),
      attack: 0.003,
      decay: 0.068,
    })
    // Strike click.
    this.noiseHit(ctx, out, {
      filter: 'highpass',
      freq: 2600,
      q: 0.5,
      level: 0.1 * (0.3 + 0.7 * p),
      attack: 0.001,
      decay: 0.014,
    })
  }

  playTouch(x: number, z: number, sprint: boolean): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 1)
    if (out === null) return
    this.noiseHit(ctx, out, {
      filter: 'lowpass',
      freq: 600 * jitter(0.18),
      q: 0.4,
      level: sprint ? 0.16 : 0.11,
      attack: 0.006,
      decay: sprint ? 0.075 : 0.055,
    })
  }

  playFootstep(x: number, z: number, sprint: boolean, mine: boolean): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, mine ? 1.28 : 1)
    if (out === null) return
    this.noiseHit(ctx, out, {
      filter: 'lowpass',
      freq: rand(450, 650) * (mine ? 0.85 : 1), // own steps read a touch fuller
      q: 0.4,
      level: sprint ? 0.2 : 0.115,
      attack: 0.008,
      decay: 0.09,
      rate: jitter(0.15), // ±15% pitch variation
    })
  }

  playBounce(x: number, z: number, strength: number): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 1)
    if (out === null) return
    const s = clamp(strength, 0, 1)
    const j = jitter(0.05)
    this.toneHit(ctx, out, {
      type: 'sine',
      freq: 132 * j,
      slideTo: 106 * j,
      slideTime: 0.1,
      level: 0.42 * (0.25 + 0.75 * s),
      attack: 0.003,
      decay: 0.115,
    })
    this.noiseHit(ctx, out, {
      filter: 'lowpass',
      freq: 900,
      q: 0.5,
      level: 0.13 * (0.25 + 0.75 * s),
      attack: 0.002,
      decay: 0.05,
    })
  }

  playPost(x: number, z: number): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 1)
    if (out === null) return
    const f0 = 620 * jitter(0.004)
    // Two detuned sines plus a quiet partner a few Hz off the fundamental, so
    // the ring beats gently instead of sitting perfectly still.
    this.toneHit(ctx, out, { type: 'sine', freq: f0, level: 0.3, attack: 0.003, decay: 0.45 })
    this.toneHit(ctx, out, { type: 'sine', freq: f0 * 1.006, level: 0.17, attack: 0.003, decay: 0.45 })
    this.toneHit(ctx, out, { type: 'sine', freq: 940 * jitter(0.004), level: 0.22, attack: 0.003, decay: 0.36 })
    // Metallic strike.
    this.noiseHit(ctx, out, { filter: 'bandpass', freq: 3200, q: 1.2, level: 0.07, attack: 0.001, decay: 0.02 })
  }

  playWhistle(kind: 'short' | 'long' | 'full'): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.flatOut(1, 0)
    if (out === null) return
    const t = ctx.currentTime
    const blasts: Array<[number, number]> =
      kind === 'short' ? [[0, 0.35]] : kind === 'long' ? [[0, 0.9]] : [[0, 0.25], [0.38, 0.25], [0.76, 0.8]]
    const lastBlast = blasts[blasts.length - 1]
    const total = lastBlast[0] + lastBlast[1] + 0.1

    // Pea trill: a ~28 Hz LFO wobbles the shared gain between 0.1 and 1.0.
    const trill = ctx.createGain()
    trill.gain.value = 0.55
    const lfo = ctx.createOscillator()
    lfo.frequency.value = rand(26.5, 29.5)
    const depth = ctx.createGain()
    depth.gain.value = 0.45
    lfo.connect(depth)
    depth.connect(trill.gain)

    // Carrier + breathy noise, shaped by one bandpass at the whistle pitch.
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 2100 * jitter(0.008)
    bp.Q.value = 2
    const osc = ctx.createOscillator()
    osc.frequency.value = 2100 * jitter(0.008)
    osc.connect(trill)
    const ng = ctx.createGain()
    ng.gain.value = 0.55
    ng.connect(trill)
    const breath = this.whiteNoise(ctx, ng, jitter(0.1), true)

    // Blast envelope lives on its own gain so the LFO is left untouched.
    const env = ctx.createGain()
    const peak = 0.32
    for (const [off, dur] of blasts) {
      const t0 = t + off
      env.gain.setValueAtTime(FLOOR, t0)
      env.gain.exponentialRampToValueAtTime(peak, t0 + 0.014)
      env.gain.setValueAtTime(peak, t0 + dur - 0.045)
      env.gain.exponentialRampToValueAtTime(FLOOR, t0 + dur)
    }
    trill.connect(bp)
    bp.connect(env)
    env.connect(out.input)

    osc.start(t)
    osc.stop(t + total)
    lfo.start(t)
    lfo.stop(t + total)
    out.nodes.push(trill, lfo, depth, bp, env, osc, ng)
    out.add(osc)
    out.add(lfo)
    if (breath !== null) {
      breath.start(t, rand(0, 1))
      breath.stop(t + total)
      out.nodes.push(breath)
      out.add(breath)
    }
  }

  playCut(x: number, z: number): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 1)
    if (out === null) return
    this.noiseHit(ctx, out, {
      filter: 'bandpass',
      freq: 250,
      sweepTo: 1400,
      sweepTime: 0.13,
      q: 1.1,
      level: 0.16,
      attack: 0.04,
      decay: 0.13,
      rate: jitter(0.15),
    })
  }

  playFlick(x: number, z: number): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 1)
    if (out === null) return
    const j = jitter(0.05)
    this.toneHit(ctx, out, {
      type: 'sine',
      freq: 300 * j,
      slideTo: 180 * j,
      slideTime: 0.07,
      level: 0.28,
      attack: 0.004,
      decay: 0.085,
    })
    // Tiny fluttering tail: band-passed noise with a ~30 Hz wobble, fading fast.
    const t = ctx.currentTime
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.frequency.value = 1050 * jitter(0.15)
    bp.Q.value = 1.6
    const g = ctx.createGain()
    g.gain.setValueAtTime(0, t)
    g.gain.linearRampToValueAtTime(0.055, t + 0.01)
    g.gain.linearRampToValueAtTime(0, t + 0.14)
    const lfo = ctx.createOscillator()
    lfo.frequency.value = rand(26, 36)
    const ld = ctx.createGain()
    ld.gain.setValueAtTime(0.045, t + 0.05)
    ld.gain.linearRampToValueAtTime(0, t + 0.13) // fade the wobble before stopping
    lfo.connect(ld)
    ld.connect(g.gain)
    bp.connect(g)
    g.connect(out.input)
    const tail = this.whiteNoise(ctx, bp, jitter(0.15), false)
    lfo.start(t)
    lfo.stop(t + 0.15)
    out.nodes.push(bp, g, lfo, ld)
    out.add(lfo)
    if (tail !== null) {
      const buf = this.white
      tail.start(t, buf === null ? 0 : rand(0, buf.duration - 0.3))
      tail.stop(t + 0.15)
      out.nodes.push(tail)
      out.add(tail)
    }
  }

  playWhiff(): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.flatOut(1, 0)
    if (out === null) return
    const t = ctx.currentTime
    // Air rushing past the boot: the bandpass sweeps up, then back down.
    const bp = ctx.createBiquadFilter()
    bp.type = 'bandpass'
    bp.Q.value = 0.9
    bp.frequency.setValueAtTime(300, t)
    bp.frequency.exponentialRampToValueAtTime(1250, t + 0.09)
    bp.frequency.exponentialRampToValueAtTime(430, t + 0.21)
    const g = ctx.createGain()
    envSwell(g.gain, t, 0.13, 0.05, 0.02, 0.13)
    bp.connect(g)
    g.connect(out.input)
    out.nodes.push(bp, g)
    const n = this.whiteNoise(ctx, bp, jitter(0.12), false)
    if (n !== null) {
      const buf = this.white
      n.start(t, buf === null ? 0 : rand(0, buf.duration - 0.4))
      n.stop(t + 0.23)
      out.nodes.push(n)
      out.add(n)
    }
  }

  playCheer(): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.flatOut(1, 0)
    if (out === null) return
    const t = ctx.currentTime
    // Roar: looping noise swelled through a 300–1400 Hz band.
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 300 * jitter(0.1)
    hp.Q.value = 0.6
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 1400 * jitter(0.1)
    lp.Q.value = 0.6
    const g = ctx.createGain()
    envSwell(g.gain, t, 0.5, 0.15, 0.45, 2.6)
    hp.connect(lp)
    lp.connect(g)
    g.connect(out.input)
    out.nodes.push(hp, lp, g)
    const roar = this.whiteNoise(ctx, hp, jitter(0.1), true)
    if (roar !== null) {
      roar.start(t, rand(0, 1))
      roar.stop(t + 3.3)
      out.nodes.push(roar)
      out.add(roar)
    }
    // 5–8 staggered "voice" blips: little filtered saw bursts, very quiet.
    const count = 5 + Math.floor(Math.random() * 4)
    for (let i = 0; i < count; i++) {
      const f = rand(250, 600)
      this.toneHit(ctx, out, {
        type: 'sawtooth',
        freq: f,
        slideTo: f * rand(1.05, 1.18), // happy upward glide
        slideTime: rand(0.08, 0.16),
        lowpass: 1200,
        level: rand(0.018, 0.04),
        attack: 0.02,
        decay: rand(0.1, 0.22),
        delay: rand(0.12, 1.5),
      })
    }
  }

  /* ---------------- continuous beds ---------------- */

  setCrowdLevel(level: number): void {
    this.crowdLevel = clamp(level, 0, 1)
    this.applyCrowdLevel()
  }

  setBallRoll(speed: number, x: number, z: number): void {
    const ctx = this.ctx
    if (
      ctx === null ||
      this.rollGain === null ||
      this.rollPan === null ||
      this.rollSrc === null ||
      this.rollTone === null ||
      this.rollMuffle === null
    ) {
      return
    }
    const t = ctx.currentTime
    const s = Math.max(0, speed)
    const sp = computeSpatial(x, z, this.listener)
    const g = sp === null ? 0 : clamp(s / 18, 0, 1) * 0.5 * sp.gain * (sp.behind ? 0.8 : 1)
    if (Math.abs(g - this.rollLastGain) > 0.004) {
      this.rollLastGain = g
      this.rollGain.gain.setTargetAtTime(g, t, 0.05)
    }
    const rate = 0.7 + s / 40
    if (Math.abs(rate - this.rollLastRate) > 0.01) {
      this.rollLastRate = rate
      this.rollSrc.playbackRate.setTargetAtTime(rate, t, 0.09)
    }
    const cut = 480 + s * 34 // faster roll = brighter rustle
    if (Math.abs(cut - this.rollLastCut) > 20) {
      this.rollLastCut = cut
      this.rollTone.frequency.setTargetAtTime(cut, t, 0.09)
    }
    if (sp !== null) {
      if (sp.behind !== this.rollBehind) {
        this.rollBehind = sp.behind
        this.rollMuffle.frequency.setTargetAtTime(sp.behind ? 2800 : 12000, t, 0.12)
      }
      if (Math.abs(sp.pan - this.rollLastPan) > 0.008) {
        this.rollLastPan = sp.pan
        this.rollPan.pan.setTargetAtTime(sp.pan, t, 0.08)
      }
    }
  }

  /* ---------------- ambience ---------------- */

  playCrow(): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.flatOut(1, rand(-0.75, 0.75)) // crows drift around the sky
    if (out === null) return
    const caws = Math.random() < 0.4 ? 3 : 2
    const base = rand(640, 760)
    let d = 0
    for (let i = 0; i < caws; i++) {
      const f = base * (1 - i * 0.05) * jitter(0.04)
      this.toneHit(ctx, out, {
        type: 'sawtooth',
        freq: f * 1.18,
        slideTo: f * 0.78,
        slideTime: 0.11,
        lowpass: 2200,
        level: rand(0.03, 0.05),
        attack: 0.012,
        decay: 0.115,
        delay: d,
      })
      d += rand(0.19, 0.27)
    }
  }

  playBell(): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.flatOut(1, rand(-0.5, 0.5))
    if (out === null) return
    const f = rand(392, 494)
    const ring = rand(0.85, 1.15)
    // Inharmonic partials with staggered decays read as a small temple bell;
    // the softened attacks keep it feeling far away (distant transients smear).
    const partials: ReadonlyArray<readonly [number, number, number]> = [
      [1, 0.11, 3.2],
      [2.0, 0.06, 2.2],
      [2.74, 0.038, 1.5],
      [3.51, 0.024, 1.0],
    ]
    for (const [ratio, level, decay] of partials) {
      this.toneHit(ctx, out, {
        type: 'sine',
        freq: f * ratio * jitter(0.002),
        level,
        attack: 0.02,
        decay: decay * ring,
      })
    }
    // Distant strike.
    this.noiseHit(ctx, out, { filter: 'bandpass', freq: f * 2.6, q: 1, level: 0.02, attack: 0.004, decay: 0.07 })
  }

  /* ---------------- ticks + UI ---------------- */

  playTick(high: boolean): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.flatOut(1, 0)
    if (out === null) return
    const f = (high ? 1320 : 880) * jitter(0.003)
    this.toneHit(ctx, out, {
      type: 'triangle',
      freq: f,
      slideTo: f * 0.955,
      slideTime: 0.05,
      level: 0.2,
      attack: 0.002,
      decay: 0.058,
    })
    this.noiseHit(ctx, out, { filter: 'highpass', freq: 3000, q: 0.5, level: 0.04, attack: 0.001, decay: 0.012 })
  }

  playUI(kind: 'click' | 'join' | 'goal-banner'): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.flatOut(1, 0)
    if (out === null) return
    if (kind === 'click') {
      const f = 660 * jitter(0.003)
      this.toneHit(ctx, out, {
        type: 'sine',
        freq: f,
        slideTo: f * 0.97,
        slideTime: 0.03,
        level: 0.13,
        attack: 0.002,
        decay: 0.036,
      })
    } else if (kind === 'join') {
      this.toneHit(ctx, out, { type: 'triangle', freq: 523.25, level: 0.11, attack: 0.004, decay: 0.07 })
      this.toneHit(ctx, out, { type: 'triangle', freq: 783.99, level: 0.11, attack: 0.004, decay: 0.09, delay: 0.09 })
    } else {
      const notes = [659.25, 880, 1318.5] // E5 — A5 — E6
      for (let i = 0; i < notes.length; i++) {
        this.toneHit(ctx, out, {
          type: 'triangle',
          freq: notes[i],
          level: 0.085,
          attack: 0.006,
          decay: i === notes.length - 1 ? 0.3 : 0.11,
          delay: i * 0.09,
        })
      }
    }
  }

  /* ---------------- EGO supers ---------------- */

  playCutIn(mine: boolean): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.flatOut(mine ? 1 : 0.55, 0)
    if (out === null) return
    // taiko DON: skin thump + body
    this.toneHit(ctx, out, { type: 'sine', freq: 96, slideTo: 52, slideTime: 0.22, level: 0.75, attack: 0.004, decay: 0.42 })
    this.noiseHit(ctx, out, { filter: 'lowpass', freq: 420, q: 0.6, level: 0.32, attack: 0.002, decay: 0.16 })
    // shing
    this.noiseHit(ctx, out, { filter: 'bandpass', freq: 5200, q: 3, level: 0.1, attack: 0.01, decay: 0.45, sweepTo: 8800 })
    this.toneHit(ctx, out, { type: 'triangle', freq: 1760, level: 0.04, attack: 0.005, decay: 0.5, delay: 0.02 })
    this.toneHit(ctx, out, { type: 'triangle', freq: 2637, level: 0.025, attack: 0.005, decay: 0.4, delay: 0.03 })
  }

  playRoar(x: number, z: number): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 1.6)
    if (out === null) return
    for (const [f, lvl] of [
      [104, 0.22],
      [111, 0.2],
      [57, 0.26],
      [163, 0.08],
    ] as const) {
      this.toneHit(ctx, out, { type: 'sawtooth', freq: f, slideTo: f * 0.62, slideTime: 1.3, level: lvl, attack: 0.09, decay: 1.35, lowpass: 820 })
    }
    this.noiseHit(ctx, out, { filter: 'bandpass', freq: 520, q: 1.1, level: 0.42, attack: 0.08, hold: 0.55, decay: 0.8, sweepTo: 240, loop: true })
  }

  playBoom(x: number, z: number): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 2.2)
    if (out === null) return
    this.toneHit(ctx, out, { type: 'sine', freq: 64, slideTo: 28, slideTime: 1.0, level: 0.9, attack: 0.004, decay: 1.25 })
    this.noiseHit(ctx, out, { filter: 'lowpass', freq: 1100, q: 0.5, level: 0.6, attack: 0.003, decay: 1.1, sweepTo: 110, loop: true })
    this.noiseHit(ctx, out, { filter: 'highpass', freq: 2400, q: 0.5, level: 0.14, attack: 0.001, decay: 0.05 })
  }

  playRumble(x: number, z: number): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 2)
    if (out === null) return
    this.noiseHit(ctx, out, { filter: 'lowpass', freq: 220, q: 0.7, level: 0.75, attack: 0.05, hold: 0.5, decay: 0.9, loop: true, sweepTo: 90 })
    this.toneHit(ctx, out, { type: 'sine', freq: 42, slideTo: 31, level: 0.55, attack: 0.03, decay: 1.2 })
    // rock cracks, staggered through the heave
    for (let i = 0; i < 4; i++) {
      window.setTimeout(() => {
        const c = this.liveCtx()
        if (c === null) return
        const o = this.spatialOut(x, z, 1.2)
        if (o === null) return
        this.noiseHit(c, o, { filter: 'bandpass', freq: 1400 + Math.random() * 1200, q: 1.4, level: 0.28, attack: 0.001, decay: 0.07 })
        this.toneHit(c, o, { type: 'sine', freq: 140 + Math.random() * 60, slideTo: 70, level: 0.25, attack: 0.002, decay: 0.12 })
      }, 60 + i * 130 + Math.random() * 60)
    }
  }

  playScreech(): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.flatOut(1, 0)
    if (out === null) return
    this.toneHit(ctx, out, { type: 'triangle', freq: 2350, slideTo: 1450, slideTime: 0.55, level: 0.1, attack: 0.03, decay: 0.6 })
    this.toneHit(ctx, out, { type: 'sawtooth', freq: 2780, slideTo: 1700, slideTime: 0.5, level: 0.035, attack: 0.03, decay: 0.55, lowpass: 3600 })
    this.toneHit(ctx, out, { type: 'triangle', freq: 1900, slideTo: 1500, level: 0.05, attack: 0.02, decay: 0.3, delay: 0.62 })
    this.noiseHit(ctx, out, { filter: 'bandpass', freq: 700, q: 0.8, level: 0.3, attack: 0.12, decay: 0.55, sweepTo: 2600 })
  }

  playWhoosh(x: number, z: number, strength: number): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 1)
    if (out === null) return
    const k = clamp(strength, 0, 1.5)
    this.noiseHit(ctx, out, { filter: 'bandpass', freq: 420, q: 0.9, level: 0.3 * k, attack: 0.1, decay: 0.45, sweepTo: 2400, sweepBack: 600 })
  }

  playThunder(x: number, z: number): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 2.2)
    if (out === null) return
    this.noiseHit(ctx, out, { filter: 'highpass', freq: 1900, q: 0.4, level: 0.55, attack: 0.001, decay: 0.09 })
    this.noiseHit(ctx, out, { filter: 'bandpass', freq: 3200, q: 1.5, level: 0.22, attack: 0.001, decay: 0.2 })
    this.noiseHit(ctx, out, { filter: 'lowpass', freq: 1300, q: 0.4, level: 0.7, attack: 0.02, decay: 2.2, sweepTo: 80, loop: true })
    this.toneHit(ctx, out, { type: 'sine', freq: 48, slideTo: 34, level: 0.45, attack: 0.05, decay: 1.6 })
  }

  playZap(x: number, z: number): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 0.8)
    if (out === null) return
    this.toneHit(ctx, out, { type: 'square', freq: 920 * jitter(0.1), slideTo: 380, level: 0.045, attack: 0.002, decay: 0.16, lowpass: 3000 })
    this.noiseHit(ctx, out, { filter: 'bandpass', freq: 3400, q: 2, level: 0.12, attack: 0.001, decay: 0.08 })
  }

  playTimeStop(start: boolean): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.flatOut(1, 0)
    if (out === null) return
    if (start) {
      // gong: inharmonic partials over a 55 Hz root
      this.toneHit(ctx, out, { type: 'sine', freq: 55, level: 0.6, attack: 0.01, decay: 2.6 })
      this.toneHit(ctx, out, { type: 'sine', freq: 55 * 2.76, level: 0.22, attack: 0.01, decay: 1.8 })
      this.toneHit(ctx, out, { type: 'sine', freq: 55 * 5.4, level: 0.1, attack: 0.01, decay: 1.1 })
      this.toneHit(ctx, out, { type: 'triangle', freq: 55 * 8.9, level: 0.04, attack: 0.01, decay: 0.8 })
      // everything else drains out of the air
      this.noiseHit(ctx, out, { filter: 'bandpass', freq: 3000, q: 0.8, level: 0.25, attack: 0.02, decay: 0.9, sweepTo: 160 })
    } else {
      this.noiseHit(ctx, out, { filter: 'bandpass', freq: 180, q: 0.8, level: 0.28, attack: 0.25, decay: 0.3, sweepTo: 3400 })
      for (const [f, d] of [
        [1568, 0.0],
        [2093, 0.05],
        [3136, 0.1],
      ] as const) {
        this.toneHit(ctx, out, { type: 'triangle', freq: f, level: 0.06, attack: 0.004, decay: 1.1, delay: 0.24 + d })
      }
    }
  }

  playWind(x: number, z: number, dur: number): void {
    const ctx = this.liveCtx()
    if (ctx === null) return
    const out = this.spatialOut(x, z, 1.8)
    if (out === null) return
    const hold = Math.max(0.2, dur - 1.4)
    this.noiseHit(ctx, out, { filter: 'bandpass', freq: 380, q: 1.2, level: 0.5, attack: 0.5, hold, decay: 0.9, loop: true, sweepTo: 950, sweepTime: 0.8, sweepBack: 420 })
    this.noiseHit(ctx, out, { filter: 'bandpass', freq: 1300, q: 3, level: 0.12, attack: 0.6, hold, decay: 0.8, loop: true, sweepTo: 2100, sweepBack: 900 })
  }

  /* ---------------- infrastructure ---------------- */

  /** The context when one-shots may be scheduled right now, else null. */
  private liveCtx(): AudioContext | null {
    const ctx = this.ctx
    if (ctx === null || this.master === null || !this.unlocked || this.muted) return null
    return ctx.state === 'running' ? ctx : null
  }

  /**
   * Crowd murmur bed: two de-correlated slices of the brown loop through
   * ~420 Hz bandpasses (380 / 460 Hz) so the loop seam never lines up.
   */
  private buildCrowdBed(): void {
    const ctx = this.ctx
    const brown = this.brown
    const master = this.master
    if (ctx === null || brown === null || master === null) return
    const gain = ctx.createGain()
    gain.gain.value = 0
    gain.connect(master)
    const layers: ReadonlyArray<readonly [number, number]> = [
      [0.86, 380],
      [1.17, 460],
    ]
    for (const [rate, freq] of layers) {
      const src = ctx.createBufferSource()
      src.buffer = brown
      src.loop = true
      src.playbackRate.value = rate
      const bp = ctx.createBiquadFilter()
      bp.type = 'bandpass'
      bp.frequency.value = freq
      bp.Q.value = 0.55
      src.connect(bp)
      bp.connect(gain)
      src.start(ctx.currentTime, rand(0, brown.duration - 0.05))
    }
    this.crowdGain = gain
  }

  private applyCrowdLevel(): void {
    const ctx = this.ctx
    const g = this.crowdGain
    if (ctx === null || g === null) return
    // setTargetAtTime with τ = 0.27 settles to ~95% in ~0.8 s.
    g.gain.setTargetAtTime(this.crowdLevel * 0.12, ctx.currentTime, 0.27)
  }

  /** Persistent rolling-ball loop; `setBallRoll` only tweaks its params. */
  private buildRollLoop(): void {
    const ctx = this.ctx
    const white = this.white
    const master = this.master
    if (ctx === null || white === null || master === null) return
    const src = ctx.createBufferSource()
    src.buffer = white
    src.loop = true
    src.playbackRate.value = 0.7
    const tone = ctx.createBiquadFilter()
    tone.type = 'lowpass'
    tone.frequency.value = 480
    tone.Q.value = 0.4
    const muffle = ctx.createBiquadFilter() // drops to 2.8 kHz when behind
    muffle.type = 'lowpass'
    muffle.frequency.value = 12000
    muffle.Q.value = 0.4
    const gain = ctx.createGain()
    gain.gain.value = 0
    const pan = ctx.createStereoPanner()
    src.connect(tone)
    tone.connect(muffle)
    muffle.connect(gain)
    gain.connect(pan)
    pan.connect(master)
    src.start(ctx.currentTime, rand(0, white.duration - 0.05))
    this.rollSrc = src
    this.rollTone = tone
    this.rollMuffle = muffle
    this.rollGain = gain
    this.rollPan = pan
  }

  /**
   * gain → panner → master with ref-counted self-disposal. `level` should
   * already include distance attenuation; `pan` is the stereo position.
   */
  private makeChain(ctx: AudioContext, level: number, pan: number): Out | null {
    const master = this.master
    if (master === null) return null
    const g = ctx.createGain()
    g.gain.value = level
    const p = ctx.createStereoPanner()
    p.pan.value = pan
    g.connect(p)
    p.connect(master)
    const nodes: AudioNode[] = [g, p]
    let live = 0
    let dead = false
    const out: Out = {
      input: g,
      nodes,
      add: (src: AudioScheduledSourceNode): void => {
        live += 1
        src.onended = () => {
          src.onended = null
          live -= 1
          if (live <= 0 && !dead) {
            dead = true
            for (const n of nodes) n.disconnect()
          }
        }
      },
    }
    return out
  }

  /** Non-spatial output chain (whistle, whiff, cheer, ticks, UI, ambience). */
  private flatOut(level: number, pan: number): Out | null {
    const ctx = this.ctx
    if (ctx === null) return null
    return this.makeChain(ctx, level, pan)
  }

  /**
   * Positional output chain: applies pan, distance attenuation and the rear
   * treatment (×0.8 gain + an extra 2.8 kHz lowpass). Returns null when the
   * source lies beyond the 70 m cull radius.
   */
  private spatialOut(x: number, z: number, level: number): Out | null {
    const ctx = this.ctx
    if (ctx === null) return null
    const sp = computeSpatial(x, z, this.listener)
    if (sp === null) return null
    const out = this.makeChain(ctx, level * sp.gain * (sp.behind ? 0.8 : 1), sp.pan)
    if (out === null) return null
    if (sp.behind) {
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = 2800
      lp.Q.value = 0.4
      lp.connect(out.input)
      out.nodes.push(lp)
      out.input = lp
    }
    return out
  }

  /** Unstarted white-noise source connected to `dest`; the caller starts it. */
  private whiteNoise(
    ctx: AudioContext,
    dest: AudioNode,
    rate: number,
    loop: boolean,
  ): AudioBufferSourceNode | null {
    const buf = this.white
    if (buf === null) return null
    const src = ctx.createBufferSource()
    src.buffer = buf
    src.playbackRate.value = rate
    src.loop = loop
    src.connect(dest)
    return src
  }

  /** One-shot noise voice: filter + gain envelope + a random slice of the shared buffer. */
  private noiseHit(ctx: AudioContext, out: Out, o: NoiseOpts): void {
    const buf = this.white
    if (buf === null) return
    const t = ctx.currentTime
    const end = o.attack + (o.hold ?? 0) + o.decay
    const f = ctx.createBiquadFilter()
    f.type = o.filter
    f.frequency.setValueAtTime(o.freq, t)
    if (o.sweepTo !== undefined) {
      f.frequency.exponentialRampToValueAtTime(o.sweepTo, t + (o.sweepTime ?? end * 0.7))
      if (o.sweepBack !== undefined) f.frequency.exponentialRampToValueAtTime(o.sweepBack, t + end)
    }
    f.Q.value = o.q
    const g = ctx.createGain()
    if (o.hold !== undefined) envSwell(g.gain, t, o.level, o.attack, o.hold, o.decay)
    else envHit(g.gain, t, o.level, o.attack, o.decay)
    f.connect(g)
    g.connect(out.input)
    const src = this.whiteNoise(ctx, f, o.rate ?? jitter(0.12), o.loop === true)
    if (src === null) return
    // Pick a random offset so repeated hits never sample the same waveform.
    const need = (end + 0.05) * Math.max(1, src.playbackRate.value)
    src.start(t, rand(0, Math.max(0, buf.duration - need)))
    src.stop(t + end + 0.03)
    out.nodes.push(f, g, src)
    out.add(src)
  }

  /** One-shot oscillator voice with optional pitch glide and lowpass. */
  private toneHit(ctx: AudioContext, out: Out, o: ToneOpts): void {
    const t = ctx.currentTime + (o.delay ?? 0)
    const osc = ctx.createOscillator()
    osc.type = o.type
    osc.frequency.setValueAtTime(o.freq, t)
    if (o.slideTo !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(o.slideTo, t + (o.slideTime ?? o.attack + o.decay))
    }
    let head: AudioNode = osc
    if (o.lowpass !== undefined) {
      const lp = ctx.createBiquadFilter()
      lp.type = 'lowpass'
      lp.frequency.value = o.lowpass
      lp.Q.value = 0.5
      osc.connect(lp)
      out.nodes.push(lp)
      head = lp
    }
    const g = ctx.createGain()
    envHit(g.gain, t, o.level, o.attack, o.decay)
    head.connect(g)
    g.connect(out.input)
    osc.start(t)
    osc.stop(t + o.attack + o.decay + 0.04)
    out.nodes.push(osc, g)
    out.add(osc)
  }
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createAudioEngine(): AudioEngine {
  return new AudioEngineImpl()
}
