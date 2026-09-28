/** Shared network + simulation types. */

export type Team = 'A' | 'B'
export type Phase = 'lobby' | 'countdown' | 'play' | 'goal' | 'halftime' | 'victory' | 'restart'

/** Dead-ball restart kinds (real football rules). */
export type RestartKind = 'throwin' | 'corner' | 'goalkick' | 'freekick' | 'penalty' | 'kickoff'

export const TEAM_NAME: Record<Team, string> = { A: 'Saffron', B: 'Teal' }

/** Self-reported presence payload. */
export interface PresencePayload {
  id: string
  name: string
  team: Team
  joinedAt: number
}

export interface RosterEntry extends PresencePayload {
  isHost: boolean
}

/** 20 Hz player transform broadcast. */
export interface PlayerStateMsg {
  id: string
  x: number
  z: number
  yaw: number
  /** Planar speed (m/s) for run-cycle animation. */
  spd: number
  spr: 0 | 1
  /** Kick animation timer remaining (0..0.32). */
  kickT: number
  /** Cut side for body-tilt animation. */
  cutS: -1 | 0 | 1
  /** Flick hop timer (0..0.6). */
  flickT: number
  /** Stepover feint timer (0..0.5). */
  stepT: number
  /** Slide tackle timer remaining (0..SLIDE.time). */
  slideT: number
  /** Throw-in animation timer (0..0.5). */
  throwT: number
  /** Flair action kind: 0 none, 1 rainbow, 2 rabona, 3 roulette, 4 elastico, 5 crouyff, 6 backheel, 8 volley. */
  act: number
  /** Flair action seconds remaining. */
  actT: number
  /** Flair action param (roulette spin dir, elastico side, crouyff turn side). */
  actS: number
  /** Sustained juggle flag. */
  jugl: 0 | 1
  /** Super status (see PlayerStatus) + seconds remaining. Optional for older peers. */
  st?: PlayerStatus
  stT?: number
  seq: number
  t: number
}

/** EGO super kinds: 1 dragon · 2 mountain · 3 eagle · 4 thunder · 5 time stop · 6 cyclone. */
export type SuperKind = 1 | 2 | 3 | 4 | 5 | 6

/**
 * Player status from super moves (self-reported by the affected client):
 * 0 none · 1 sealed (thunder) · 2 knocked down · 3 frozen in stopped time ·
 * 4 caught in the cyclone · 5 eagle glide · 6 dragon wind-up.
 */
export type PlayerStatus = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** 15 Hz authoritative ball broadcast (host only). */
export interface BallStateMsg {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  vz: number
  lastTouch: string | null
  seq: number
  t: number
  /** Sender when it is NOT the host (the Zero Hour caster owns the ball while time is stopped). */
  from?: string
}

/** Kick / throw request. Client plays cosmetics immediately; host validates + applies. */
export interface KickMsg {
  id: string
  dx: number
  dz: number
  /** 0..1 loft factor derived from camera pitch. */
  loftN: number
  /** 0..1 charge power. */
  power: number
  /** 'throw' is only legal for the restart taker during a throw-in. */
  kind: 'kick' | 'throw'
  seq: number
}

export interface Scorer {
  id: string
  name: string
  team: Team
}

export interface RestartInfo {
  kind: RestartKind
  team: Team
  x: number
  z: number
  takerId: string | null
  reason: string
}

export type MatchEventMsg =
  | { type: 'goal'; team: Team; scorerId: string | null; scorerName: string | null; scoreA: number; scoreB: number; kickoffIn: number }
  | { type: 'countdown'; endsIn: number; slots: Record<string, [number, number, number]>; ball: [number, number, number] }
  | { type: 'play' }
  | {
      type: 'deadball'
      kind: RestartKind
      team: Team
      x: number
      z: number
      takerId: string | null
      reason: string
      /** Per-player repositioning targets (taker on the spot, others outside exclusion zones). */
      slots: Record<string, [number, number, number]>
    }
  | SuperEventMsg
  | {
      /** Eagle Talon landing — the host hands the ball to the claimer; nearby opponents fall. */
      type: 'superClaim'
      from: string
      team: Team
      x: number
      z: number
      bx: number
      bz: number
    }
  | { type: 'halftime'; scoreA: number; scoreB: number; resumeIn: number }
  | { type: 'victory'; winner: Team | 'draw'; scoreA: number; scoreB: number; scorers: Scorer[] }
  | { type: 'teams'; teams: Record<string, Team> }
  | { type: 'hello'; from: string }
  | {
      type: 'snapshot'
      phase: Phase
      scoreA: number
      scoreB: number
      clock: number
      half: number
      ball: BallStateMsg
      restart: RestartInfo | null
      /** ids that should apply this snapshot (fresh joiners / hello senders). */
      audience: string[]
    }

/**
 * A super move goes off. Sent by the CASTER (any client) and applied by
 * everyone; each client decides for itself whether it was caught.
 */
export interface SuperEventMsg {
  type: 'super'
  kind: SuperKind
  from: string
  team: Team
  name: string
  /** Caster position + facing at cast. */
  x: number
  z: number
  yaw: number
  /** Aimed ground point (mountain / cyclone / thunder fallback). */
  ax: number
  az: number
  /** Dragon: cubic bezier control points [x0,y0,z0, x1,y1,z1, x2,y2,z2, x3,y3,z3] + flight seconds. */
  path?: number[]
  flight?: number
  /** Zero Hour: stop duration. */
  dur?: number
  /** Deterministic seed for the cosmetic randomness (peak heights, bolt shapes). */
  seed: number
}

export interface NetHandlers {
  onRoster(roster: RosterEntry[]): void
  onPlayerState(msg: PlayerStateMsg): void
  onBallState(msg: BallStateMsg, meta: { clock: number; phase: Phase; scoreA: number; scoreB: number }): void
  onKick(msg: KickMsg): void
  onEvent(msg: MatchEventMsg): void
  onStatus(status: 'connecting' | 'connected' | 'error' | 'closed', detail?: string): void
}

export interface NetClient {
  readonly myId: string
  readonly configured: boolean
  connect(code: string, me: PresencePayload): Promise<void>
  disconnect(): void
  updatePresence(partial: Partial<PresencePayload>): void
  sendPlayerState(msg: PlayerStateMsg): void
  sendBallState(msg: BallStateMsg, meta: { clock: number; phase: Phase; scoreA: number; scoreB: number }): void
  sendKick(msg: KickMsg): void
  sendEvent(msg: MatchEventMsg): void
}

/** Skill cooldown readouts for the HUD (1 = ready). */
export interface SkillReadouts {
  cut: number
  step: number
  flick: number
  slide: number
  rainbow: number
  roulette: number
  elastico: number
  crouyff: number
  backheel: number
}

/** A remote player's interpolated pose for rendering + local collisions. */
export interface SampledPose {
  x: number
  z: number
  yaw: number
  spd: number
  spr: boolean
  kickT: number
  cutS: -1 | 0 | 1
  flickT: number
  stepT: number
  slideT: number
  throwT: number
  act: number
  actT: number
  actS: number
  jugl: 0 | 1
  st: PlayerStatus
  stT: number
}

/** EGO gauge + per-super readiness for the HUD. */
export interface EgoReadout {
  /** 0..1 fill. */
  fill: number
  /** Free play: supers cost nothing (sandbox). */
  infinite: boolean
  /** Per kind 1..6 (index 0 unused): can fire right now. */
  ready: boolean[]
  /** Global lockout 0..1 (1 = clear). */
  lock: number
}

/** UI-facing state snapshot pushed by the Game to React. */
export interface UiState {
  screen: 'menu' | 'room' | 'game'
  practice: boolean
  freePlay: boolean
  netConfigured: boolean
  connected: boolean
  netStatus: string
  roomCode: string
  roster: RosterEntry[]
  isHost: boolean
  myId: string
  myName: string
  myTeam: Team
  phase: Phase
  scoreA: number
  scoreB: number
  clock: number
  half: number
  spectating: boolean
  banner: { title: string; sub: string; tone: Team | 'neutral'; until: number } | null
  countdown: number | null
  victory: { winner: Team | 'draw'; scorers: Scorer[] } | null
  practiceGoals: number
  muted: boolean
  pointerLocked: boolean
  touchMode: boolean
  paused: boolean
  charging: boolean
  chargePower: number
  stamina: number
  settings: import('./settings').GameSettings
  restart: { kind: RestartKind; team: Team; takerId: string | null; takerName: string; mine: boolean; label: string; hint: string } | null
  skills: SkillReadouts
  sliding: boolean
  /** Latched-on juggle (T toggle). */
  juggling: boolean
  ego: EgoReadout
}

export type UiCmd =
  | { type: 'setName'; name: string }
  | { type: 'createRoom' }
  | { type: 'joinRoom'; code: string }
  | { type: 'leaveRoom' }
  | { type: 'startMatch' }
  | { type: 'shuffleTeams' }
  | { type: 'setTeam'; id: string; team: Team }
  | { type: 'rematch' }
  | { type: 'startPractice' }
  | { type: 'startFreePlay' }
  | { type: 'practiceReset' }
  | { type: 'leaveMatch' }
  | { type: 'toggleMute' }
  | { type: 'requestLock' }
  | { type: 'setSettings'; patch: import('./settings').GameSettingsPatch }
