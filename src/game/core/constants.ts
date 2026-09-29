/**
 * GULMOHAR GROUND — FIRST PERSON
 * Global tuning constants. All times in seconds, distances in meters, SI-ish arcade units.
 */

/** Pitch geometry. Length runs along X, width along Z. */
export const PITCH = {
  L: 72,
  W: 46,
  cornerR: 7,
  /** Wall stands this far outside the touchline (rounded rect). */
  wallMargin: 4.5,
  get halfL() { return this.L / 2 },
  get halfW() { return this.W / 2 },
  get wallL() { return this.L + this.wallMargin * 2 },
  get wallW() { return this.W + this.wallMargin * 2 },
  get wallR() { return this.cornerR + this.wallMargin },
} as const

/** Goals sit in the short ends. Team A defends x = -halfL, Team B defends x = +halfL. */
export const GOAL = {
  halfW: 1.9, // 3.8 m wide mouth (5v5-sized pitch)
  height: 2.0,
  depth: 1.9, // net box depth behind the line
  postR: 0.065,
  /** Ball must be fully past the line by this much. */
  lineEps: 0.16,
} as const

/** Height of the goal's back net / rear stanchions (the roof net slopes down to it). */
export const NET_BACK_H = 1.42

export const BALL = {
  r: 0.19,
  gravity: -20,
  restitution: 0.5,
  /** Exponential rolling drag (per second) while grounded. */
  rollDamp: 0.7,
  /** Extra linear deceleration (m/s^2) so the ball actually stops. */
  rollDecel: 0.7,
  /** Exponential air drag (per second). */
  airDamp: 0.08,
  wallRestitution: 0.62,
  maxSpeed: 34,
  /** Below this horizontal speed the ball is considered at rest. */
  restSpeed: 0.25,
} as const

export const PLAYER = {
  r: 0.42,
  eye: 1.65,
  fov: 78,
  walkSpeed: 4.3,
  sprintSpeed: 7.2,
  accel: 30,
  sprintAccel: 34,
  /** Velocity damping when no input (per second). */
  stopDamp: 10,
  turnBoost: 2.4, // extra accel authority while changing direction
  dribbleRadius: 1.05,
  kickRange: 1.8,
  touchIntervalWalk: 0.4,
  touchIntervalSprint: 0.32,
  /** Head bob amplitude (m) at full sprint. */
  bobAmp: 0.035,
} as const

export const KICK = {
  chargeTime: 1.0, // seconds of hold for full power
  minPower: 0.12,
  speedMin: 9,
  speedMax: 24.5,
  /** Vertical launch speed at loft 0 (looking down = driven) and loft 1 (looking up = chip). */
  vyDriven: 0.9,
  vyChip: 9.6,
  /** Camera pitch (radians) that maps to loft 0 / loft 1. */
  pitchForLoft0: -0.35,
  pitchForLoft1: 0.52,
  /** Host anti-cheat: max accepted kick range and per-kicker cooldown. */
  hostRangeTolerance: 2.3,
  // short enough that a flair touch followed by a quick shot both land
  hostCooldown: 0.18,
  powerCap: 1.05,
  /** Cosmetic follow-through duration. */
  followThrough: 0.32,
} as const

export const SKILL = {
  cutImpulse: 8.8,
  cutBaseImpulse: 5.2,
  cutCooldown: 0.55,
  cutKeepMomentum: 0.5,
  cutMinSpeed: 0.0,
  stepPlantTime: 0.12,
  stepBurstTime: 0.34,
  stepBurstMult: 2.6,
  stepCooldown: 1.2,
  flickCooldown: 1.6,
  flickVy: 5.2,
  flickFwd: 3.2,
  flickRange: 1.5,
} as const

export const SLIDE = {
  speed: 9.4,
  time: 0.55,
  cooldown: 2.2,
  ballRange: 1.2,
  foulRange: 0.85,
  pokePower: 0.5,
} as const

/**
 * Iteration-3 flair skills (rainbow / rabona / roulette / elastico / crouyff /
 * backheel / juggle / volley). Action kinds broadcast as `act`:
 * 0 none · 1 rainbow · 2 rabona · 3 roulette · 4 elastico · 5 crouyff · 6 backheel · 8 volley.
 */
export const SKILL2 = {
  rainbow: {
    cooldown: 3.0,
    duration: 0.55,
    /** Ball must be within this range to start the roll-up. */
    range: 1.2,
    /** Kinematic roll-up phase: ball climbs the standing leg. */
    riseTime: 0.2,
    riseHeight: 0.8,
    flickFwd: 2.6,
    flickVy: 9.2,
  },
  rabona: {
    /** Extra flair cooldown on top of the normal kick cadence. */
    flairCd: 1.2,
    lockTime: 0.42,
    powerMult: 1.08,
    loftAdd: 0.12,
  },
  roulette: {
    cooldown: 4.0,
    duration: 0.62,
    /** Ball pinned under the sole only within this range. */
    range: 1.15,
    exitSpeed: 3.6,
  },
  elastico: {
    cooldown: 3.5,
    total: 0.3,
    outTime: 0.16,
    outDist: 1.05,
    /** Lateral cut speed of the instep snap. */
    crossSpeed: 2.4,
    /** Forward bias of the snap — the exit runs past the standing leg. */
    crossFwd: 3.4,
    range: 1.2,
  },
  crouyff: {
    cooldown: 3.5,
    total: 0.54,
    windup: 0.2,
    turnTime: 0.34,
    /** Controlled exit — the ball stays with you out of the turn (a hard
     * exit would overshoot the standing gather and visibly reverse). */
    exitSpeed: 1.6,
    range: 1.25,
  },
  backheel: {
    cooldown: 2.5,
    lockTime: 0.3,
    speed: 7.2,
    hopVy: 0.8,
    range: 1.35,
  },
  juggle: {
    /** Ball must be within this range and slow to latch on. */
    range: 1.2,
    maxBallSpeed: 2.6,
    /** Apex height (ball centre) and bounce rhythm. */
    apex: 1.05,
    hz: 1.55,
    /** Homing keeps the ball this far ahead of the player. */
    ahead: 0.55,
    footY: 0.19,
    kneeY: 0.55,
    walkCap: 2.3,
  },
  volley: {
    /** Any LMB kick with the ball above this height becomes a scissor volley. */
    height: 0.45,
    duration: 0.55,
  },
} as const

/**
 * EGO super moves (keys 1–6). Kinds broadcast in the 'super' event:
 * 1 dragon · 2 mountain · 3 eagle · 4 thunder · 5 time stop · 6 cyclone.
 */
export const SUPER = {
  /** EGO gauge: 0..max, spent per move. */
  egoMax: 100,
  /** Passive gain per second (match); solo practice multiplies it. */
  egoPerSec: 1.6,
  egoSoloMult: 2.4,
  egoFlair: 5,
  egoShot: 3,
  egoBigShot: 5,
  egoGoal: 18,
  egoClean: 6,
  /** Short lockout between any two supers (free play sandbox uses only this). */
  lockout: 1.6,
  dragon: {
    cost: 100,
    range: 1.6,
    /** Wind-up: the ball rises and coils before the strike. */
    windup: 0.62,
    /** Flight speed along the curve (m/s); duration clamps below. */
    speed: 24,
    minFlight: 1.0,
    maxFlight: 2.8,
    /** Max distance the dragon carries the ball along your aim (m). */
    range3d: 42,
    /** Speed the ball keeps when the dragon lets go (m/s). */
    releaseSpeed: 20,
    /** Anyone within this of the flying ball is bowled over. */
    knockRadius: 1.3,
  },
  mountain: {
    cost: 50,
    minDist: 4,
    maxDist: 24,
    fallbackDist: 9,
    /** Peaks along the ridge (spaced across `span` metres). */
    peaks: 5,
    span: 7.6,
    peakR: 0.95,
    rise: 0.7,
    life: 9,
    sink: 0.8,
    ballRestitution: 0.55,
  },
  eagle: {
    cost: 60,
    maxDist: 42,
    /** Glide speed (m/s) → duration clamp. */
    speed: 24,
    minT: 0.5,
    maxT: 1.35,
    apex: 2.6,
    knockRadius: 2.3,
  },
  thunder: {
    cost: 70,
    range: 26,
    /** The storm gathers (and the cut-in clears) before the first strike lands. */
    windup: 0.8,
    seal: 3.2,
    storm: 2.4,
  },
  timeStop: {
    cost: 100,
    soloDur: 4.4,
    matchDur: 3.3,
    speedMult: 1.55,
    /** A ball kicked during the stop flies this long, then hangs in the air. */
    kickDrift: 0.22,
  },
  cyclone: {
    cost: 70,
    minDist: 5,
    maxDist: 26,
    fallbackDist: 11,
    life: 5.5,
    pullRadius: 12,
    innerRadius: 1.7,
    pull: 7.5,
    swirl: 6.5,
  },
  /** Status durations applied to victims. */
  knockTime: 1.5,
} as const

export const STAMINA = {
  max: 1,
  drainPerSec: 0.26, // sprinting
  regenPerSec: 0.34, // walking / idle
  minToSprint: 0.06,
} as const

export const NET = {
  // matched to the relay's 15 Hz batching tick
  playerHz: 15,
  ballHz: 15,
  // two server ticks of buffer so batched arrivals interpolate smoothly
  interpDelay: 0.16, // remote player interpolation buffer
  maxPlayers: 10,
  codeChars: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789',
} as const

export const MATCH = {
  halfLen: 180, // 3-minute halves
  halves: 2,
  goalsToWin: 5,
  goalCeleb: 4.0,
  countdown: 3.2,
  halftimeBreak: 3.5,
} as const

/** Lawn-tennis-ball sized pitch furniture, real-rules edition (scaled to 55×35). */
export const RULES = {
  /** Penalty area depth from the goal line + half width. */
  boxDepth: 13,
  boxHalfW: 14,
  /** Six-yard (goal) area. */
  goalAreaDepth: 4.5,
  goalAreaHalfW: 6,
  /** Penalty spot distance from the goal line. */
  penaltySpot: 9,
  /** Opponents pushed this far from a free-kick / corner spot at setup. */
  freeKickRadius: 3.4,
  /** Thrower must keep this far outside the touchline. */
  throwStandOff: 0.4,
  /** Max throw-in release speed (m/s). */
  throwSpeedMin: 5,
  throwSpeedMax: 13,
  /** Auto-release if the taker goofs around. */
  restartTimeout: 9,
  /** Offside forgiveness: level-with is onside. */
  offsideTolerance: 0.3,
  /** Grace beyond line + ball radius before the whistle. */
  outGrace: 0.06,
  /** Brief stoppage banner before the restart goes live. */
  restartBanner: 1.35,
} as const

/** Hand-painted palette. Hex strings shared by render + UI. */
export const PALETTE = {
  ink: '#2f2823',
  paper: '#fbf3e2',
  paperDeep: '#f3e6cc',
  saffron: '#f28a2e',
  saffronDeep: '#d96f16',
  teal: '#2fa8a0',
  tealDeep: '#1f847d',
  grassA: '#7e9a4e',
  grassB: '#74904a',
  worn: '#a78b58',
  trunk: '#6b4a36',
  blossom: '#e8532f',
  blossomDeep: '#c93b1f',
  skyTop: '#86a0cf',
  skyHorizon: '#ffe9c4',
  fog: '#f2ddbe',
  dust: '#c7b183',
  plaster: '#e8d9b8',
  brick: '#b0603c',
  metal: '#b9b4ac',
} as const

export type Quality = 'low' | 'medium' | 'high'

export const QUALITY = {
  high: { shadowMap: 2048, outlinePx: 2.6, msaa: 4, pixelRatioCap: 2, tufts: 260, motes: true, crowd: 46, detail: true },
  medium: { shadowMap: 1536, outlinePx: 2.2, msaa: 2, pixelRatioCap: 1.75, tufts: 170, motes: true, crowd: 36, detail: true },
  low: { shadowMap: 1024, outlinePx: 0, msaa: 0, pixelRatioCap: 1.5, tufts: 90, motes: false, crowd: 24, detail: false },
} as const

/** Default player-name pool. */
export const NAME_POOL = [
  'Arjun', 'Zoya', 'Rohan', 'Meera', 'Kabir', 'Tara', 'Dev', 'Ananya', 'Ishaan', 'Priya', 'Sam', 'Riya',
] as const

export const ROOM_FULL_MSG = 'Room is full (10 players).'

/** Skin tones for procedural players. */
export const SKIN_TONES = ['#c68958', '#a9703f', '#8a5a30', '#e0a878'] as const
