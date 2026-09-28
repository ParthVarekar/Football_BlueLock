/**
 * Game orchestrator — state machine, wiring between net / sim / render /
 * audio / UI. Owns the rAF loop and the React-facing snapshot store.
 *
 * Real-rules layer (host-authoritative): out-of-play detection, throw-ins,
 * corners, goal kicks, free kicks, penalties, offside (flag-on-touch) and
 * slide-tackle fouls. Restart flow: deadball event → per-player placement →
 * frozen ball → the taker releases (kick or throw) → play resumes.
 */
import * as THREE from 'three'
import { BALL, GOAL, KICK, MATCH, NET, PALETTE, PITCH, PLAYER, QUALITY, RULES, SKILL, SKILL2, SLIDE, STAMINA, SUPER, type Quality } from './core/constants'
import { clamp, damp, dampAngle, formatClock, forwardXZ, makeRng, randomName, rightXZ, sdRoundedRect, yawFromDir } from './core/math'
import type {
  BallStateMsg,
  KickMsg,
  MatchEventMsg,
  Phase,
  PlayerStateMsg,
  PlayerStatus,
  RestartKind,
  RosterEntry,
  Scorer,
  SuperEventMsg,
  SuperKind,
  Team,
  UiCmd,
  UiState,
} from './core/types'
import { TEAM_NAME } from './core/types'
import { createAudioEngine, type AudioEngine } from './core/audio'
import { loadSettings, saveSettings, type GameSettings, type GameSettingsPatch } from './core/settings'
import { InputManager, type InputFrame } from './sim/input'
import { LocalPlayer } from './sim/localPlayer'
import {
  backheelClip,
  dribbleStep,
  easedSweep,
  elasticoPush,
  elasticoSnap,
  juggleBounce,
  juggleDrop,
  kickVelocity,
  nearestDribbler,
  rainbowFlick,
  rainbowRoll,
  soleDrag,
  stepBall,
  throwVelocity,
  type BallState,
  type Dribbler,
} from './sim/ball'
import {
  checkOutOfPlay,
  defendedGoalX,
  inPenaltyBox,
  offsidePositions,
  otherTeam,
  penaltySpot,
  RESTART_LABEL,
  restartSlots,
  type PlayerRef,
} from './sim/rules'
import { RemotePlayers } from './sim/remote'
import {
  aimGroundPoint,
  bezierAt,
  bezierTangent,
  collideBallWithWalls,
  cycloneVelocity,
  dragonEase,
  dragonPath,
  eagleDuration,
  eagleLift,
  mountainAlive,
  mountainPeaks,
  pushOutOfWalls,
  type Cyclone,
  type MountainWall,
} from './sim/supers'
import { RelayNet, isNetConfigured, makeRoomCode, normalizeRoomCode } from './net/relayNet'
import { createLights } from './render/toon'
import { setOutlineWidth, updateOutlineFrame } from './render/outline'
import { createGameRenderer, GradePass } from './render/post'
import { createWorld, type World } from './render/world'
import { PlayerRig } from './render/players'
import { BallView } from './render/ballView'
import { LegsView, type LegActionState } from './render/legs'
import { Particles } from './render/particles'
import { CameraRig } from './render/cameraRig'
import { SuperFx } from './render/superFx'
import { MangaOverlay, SUPER_STYLE, type LocalStatus } from './render/mangaOverlay'

export interface GameCallbacks {
  onToast: (msg: string) => void
}

export interface GameOptions extends GameCallbacks {
  webglCanvas: HTMLCanvasElement
  aimCanvas: HTMLCanvasElement
  /** Manga overlay layer for the EGO supers (cut-ins, focus lines, sfx). */
  fxCanvas: HTMLCanvasElement
  container: HTMLElement
}

export interface GameHandle {
  cmd(c: UiCmd): void
  subscribe(fn: () => void): () => void
  getSnapshot(): UiState
  readonly input: InputManager
  dispose(): void
}

const nowSec = (): number => performance.now() / 1000
const AI_ID = 'ai-defender'
/** Seconds without a transform before a remote player is treated as gone. */
const STALE_AFTER = 3
const UP = new THREE.Vector3(0, 1, 0)

interface RestartState {
  kind: RestartKind
  team: Team
  x: number
  z: number
  takerId: string | null
  reason: string
}

export function createGame(opts: GameOptions): GameHandle {
  const { webglCanvas, aimCanvas, fxCanvas, container, onToast } = opts

  // ------------------------------------------------------------------ settings + quality
  const settings: GameSettings = loadSettings()
  let appliedQuality: Quality = settings.quality
  const touchModeInitial =
    window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
  let touchMode = touchModeInitial
  const q = QUALITY[appliedQuality]

  // ------------------------------------------------------------------ three
  const renderer = createGameRenderer(webglCanvas)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pixelRatioCap))
  const scene = new THREE.Scene()
  const lights = createLights(scene, appliedQuality)
  const world: World = createWorld(scene, appliedQuality)
  const grade = new GradePass(renderer, appliedQuality)
  const particles = new Particles(scene)
  const cameraRig = new CameraRig(16 / 9)
  cameraRig.setFov(settings.fov)
  const ballView = new BallView(appliedQuality)
  scene.add(ballView.group)
  const legs = new LegsView(appliedQuality)
  // the first-person body lives in the WORLD, hung from the hips under the
  // player — it yaws with the view and leans toward it as you look down
  scene.add(legs.group)
  legs.group.visible = false
  const superFx = new SuperFx(scene, appliedQuality)
  const manga = new MangaOverlay(fxCanvas)

  const aimCtx = aimCanvas.getContext('2d') as CanvasRenderingContext2D | null

  // ------------------------------------------------------------------ systems
  const audio: AudioEngine = createAudioEngine()
  audio.setMaster(settings.volume)
  const remote = new RemotePlayers()
  const rigs = new Map<string, PlayerRig>()
  const rigTeams = new Map<string, Team>()

  const player = new LocalPlayer({
    onFootstep: () => audio.playFootstep(player.x, player.z, player.sprinting, true),
    onCut: (side, x, z) => {
      audio.playCut(x, z)
      particles.grassBurst(x, z, 8, 0, 0, 0.8)
      cameraRig.cutRoll(side)
    },
    onStepover: (x, z) => {
      particles.grassBurst(x, z, 10, 0, 0, 1)
      audio.playTouch(x, z, false)
    },
    onFlick: () => {
      cameraRig.landDip(0.4)
    },
    onSlide: (x, z, dx, dz) => {
      particles.dustPuff(x, z, 1)
      particles.grassBurst(x, z, 12, dx, dz, 1.1)
      audio.playCut(x, z)
      cameraRig.landDip(0.55)
    },
    onSlideEnd: () => {
      cameraRig.landDip(0.45)
      particles.dustPuff(player.x, player.z, 0.6)
    },
  })

  const input = new InputManager(webglCanvas, () => setPaused(true))

  // ------------------------------------------------------------------ state
  type Mode = 'menu' | 'practice' | 'free' | 'match'
  let mode: Mode = 'menu'
  let screen: UiState['screen'] = 'menu'
  let phase: Phase = 'lobby'
  let paused = false
  let spectating = false
  let roster: RosterEntry[] = []
  let prevHostId: string | null = null
  let myName = loadName()
  let myId = `p-${Math.random().toString(36).slice(2, 10)}`
  let net: RelayNet | null = null
  let netCode = ''
  let netStatus = ''
  let scoreA = 0
  let scoreB = 0
  let clock = 0
  let half = 1
  let scorers: Scorer[] = []
  let victory: UiState['victory'] = null
  let banner: UiState['banner'] = null
  let countdownEndsAt: number | null = null
  let lastCountdownTick = 99
  let practiceGoals = 0
  let practiceResetAt: number | null = null
  let muted = false

  // rules state (host-authoritative)
  let restart: RestartState | null = null
  let restartStartedAt = 0
  let prevLastTouch: string | null = null
  let offsideFlags = new Set<string>()
  let noOffsideOneTouch = false
  const slideCleanIds = new Set<string>()
  const slidePokedIds = new Set<string>()
  let mySlideClean = false
  let aiThrowT = 0

  const localBall: BallState = { x: 0, y: BALL.r, z: 0, vx: 0, vy: 0, vz: 0, lastTouch: null }
  let hostBall: BallStateMsg | null = null
  let myKickT = 0
  let mySeq = 0
  let ballSeq = 0
  let stateTimer = 0
  let ballTimer = 0
  const hostTimers: Array<{ at: number; fn: () => void }> = []
  const lastHostKick = new Map<string, number>()

  const myDribbler: Dribbler = { id: myId, x: 0, z: 0, vx: 0, vz: 0, yaw: 0, sprinting: false, touchTimer: 0 }
  const remoteDribblers = new Map<string, Dribbler>()

  const ai = { x: 10, z: 0, vx: 0, vz: 0, yaw: Math.PI / 2, kickCd: 0, sealT: 0, knockT: 0, stopT: 0, grip: 0 }

  // flair-skill state (local authority; ball work mirrors the flick pattern)
  interface SkillBallCapture {
    owned: boolean
    startX: number
    startZ: number
    fwd0X: number
    fwd0Z: number
    right0X: number
    right0Z: number
    flicked: boolean
    snapped: boolean
  }
  let skillBall: SkillBallCapture | null = null
  /** Grace after a flair skill releases the ball — my own dribble gather would
   * otherwise spring-kill the exit impulse before the ball clears 2.3 m. */
  let skillBallGrace = 0
  let skillCooldownToasted = false
  let skillRangeToasted = false
  let juggleHintToasted = false

  // ---- EGO supers
  /** Sim clock (slows in solo slow-mo) — every super timing runs on it. */
  let simT = 0
  let ego = 0
  let superLock = 0
  let superSeq = 1
  let lastSuperToast = -99
  const walls: MountainWall[] = []
  const cyclones: Cyclone[] = []
  interface DragonFlight {
    key: number
    from: string
    team: Team
    path: number[]
    flight: number
    castAt: number
    strikeAt: number
    /** Ball position when the cast arrived (it coils up from here). */
    bx: number
    by: number
    bz: number
    struck: boolean
    done: boolean
    hit: Set<string>
  }
  let dragon: DragonFlight | null = null
  let glide: { sx: number; sz: number; t: number; total: number; release: number; landed: boolean } | null = null
  const remoteGlideStart = new Map<string, number>()
  let timeStop: { by: string; until: number; mine: boolean; lastTick: number } | null = null
  /** Caster-side Zero Hour ball: frozen until touched, or hanging after a kick. */
  let tsBall: { frozen: boolean; held: { vx: number; vy: number; vz: number } | null; driftAt: number } | null = null
  let tsGraceUntil = -1
  let tsGraceFrom = ''
  const pendingBolts: Array<{ at: number; id: string | null; x: number; z: number; seed: number; cast: number }> = []
  let lastInkCast = -1
  // grade + time-feel
  let stormUntil = 0
  let storm = 0
  let mono = 0
  let inkUntil = 0
  let washAmt = 0
  const washColor = new THREE.Color('#ffffff')
  let slowMoUntil = 0
  let slowMoScale = 1
  let lastZap = 0
  const superTmpP = { x: 0, y: 0, z: 0 }
  const superTmpT = { x: 0, y: 0, z: 0 }

  /** Solo modes: offline, local-authority, never-ending. */
  const solo = (): boolean => mode === 'practice' || mode === 'free'
  const isHost = (): boolean => (solo() ? true : roster[0]?.id === myId)
  const myTeam = (): Team => roster.find((r) => r.id === myId)?.team ?? 'A'

  // ------------------------------------------------------------------ ui store
  let snapshot!: UiState
  const listeners = new Set<() => void>()
  let uiTimer = 0

  const chargeCache = { held: false, power: 0 }

  function buildUi(): UiState {
    const takerName =
      restart?.takerId == null
        ? ''
        : restart.takerId === myId
          ? myName
          : restart.takerId === AI_ID
            ? 'Defender'
            : (roster.find((r) => r.id === restart?.takerId)?.name ?? '…')
    return {
      screen,
      practice: mode === 'practice',
      freePlay: mode === 'free',
      netConfigured: isNetConfigured(),
      connected: net !== null && netStatus === 'connected',
      netStatus,
      roomCode: netCode,
      roster,
      isHost: isHost(),
      myId,
      myName,
      myTeam: myTeam(),
      phase,
      scoreA,
      scoreB,
      clock,
      half,
      spectating,
      banner,
      countdown: countdownEndsAt !== null ? Math.max(0, Math.ceil(countdownEndsAt - nowSec())) : null,
      victory,
      practiceGoals,
      muted,
      pointerLocked: input.pointerLocked,
      touchMode,
      paused,
      charging: chargeCache.held,
      chargePower: chargeCache.power,
      stamina: player.stamina / STAMINA.max,
      settings: { ...settings },
      restart:
        restart !== null && phase === 'restart'
          ? {
              kind: restart.kind,
              team: restart.team,
              takerId: restart.takerId,
              takerName,
              mine: restart.takerId === myId,
              label: RESTART_LABEL[restart.kind],
              hint:
                restart.takerId === myId
                  ? restart.kind === 'throwin'
                    ? 'Hold LMB to charge — release to throw'
                    : 'Hold LMB to charge — release to take it'
                  : `Waiting for ${takerName}…`,
            }
          : null,
      skills: {
        cut: 1 - clamp(player.cutCooldown / SKILL.cutCooldown, 0, 1),
        step: 1 - clamp(player.stepCooldown / SKILL.stepCooldown, 0, 1),
        flick: 1 - clamp(player.flickCooldown / SKILL.flickCooldown, 0, 1),
        slide: 1 - clamp(player.slideCooldown / SLIDE.cooldown, 0, 1),
        rainbow: 1 - clamp(player.rainbowCooldown / SKILL2.rainbow.cooldown, 0, 1),
        roulette: 1 - clamp(player.rouletteCooldown / SKILL2.roulette.cooldown, 0, 1),
        elastico: 1 - clamp(player.elasticoCooldown / SKILL2.elastico.cooldown, 0, 1),
        crouyff: 1 - clamp(player.crouyffCooldown / SKILL2.crouyff.cooldown, 0, 1),
        backheel: 1 - clamp(player.backheelCooldown / SKILL2.backheel.cooldown, 0, 1),
      },
      sliding: player.sliding,
      juggling: player.juggling,
      ego: {
        fill: mode === 'free' ? 1 : ego / SUPER.egoMax,
        infinite: mode === 'free',
        ready: [0, 1, 2, 3, 4, 5, 6].map((k) => k > 0 && (mode === 'free' || ego >= superCost(k as SuperKind))),
        lock: 1 - clamp(superLock / SUPER.lockout, 0, 1),
      },
    }
  }

  function pushUi(): void {
    snapshot = buildUi()
    for (const fn of listeners) fn()
  }

  // ------------------------------------------------------------------ helpers
  function loadName(): string {
    try {
      const v = localStorage.getItem('gg-name')
      if (v && v.trim()) return v.trim().slice(0, 14)
    } catch {
      /* private mode */
    }
    return randomName([])
  }

  function toast(msg: string): void {
    onToast(msg)
  }

  function setPaused(p: boolean): void {
    if (screen !== 'game' || phase === 'victory') return
    paused = p
    input.inputEnabled = !p && (phase === 'play' || phase === 'restart') && !spectating
    if (p) input.exitLock()
    pushUi()
  }

  function setBall(x: number, z: number): void {
    if (dragon && !dragon.done) endDragonFlight(false)
    tsBall = null
    localBall.x = x
    localBall.y = BALL.r
    localBall.z = z
    localBall.vx = 0
    localBall.vy = 0
    localBall.vz = 0
    localBall.lastTouch = null
    hostBall = null
    myKickT = 0
  }

  function loftFromPitch(): number {
    return clamp((cameraRig.visualPitch - KICK.pitchForLoft0) / (KICK.pitchForLoft1 - KICK.pitchForLoft0), 0, 1)
  }

  function posOf(id: string): { x: number; z: number; yaw: number } | null {
    if (id === myId) return { x: player.x, z: player.z, yaw: cameraRig.yaw }
    if (id === AI_ID) return { x: ai.x, z: ai.z, yaw: ai.yaw }
    return remote.latest(id)
  }

  function teamsMap(): Record<string, Team> {
    const m: Record<string, Team> = {}
    if (solo()) {
      m[myId] = 'A'
      if (mode === 'practice') m[AI_ID] = 'B'
      return m
    }
    for (const r of roster) m[r.id] = r.team
    return m
  }

  function rulesPlayers(): PlayerRef[] {
    const teams = teamsMap()
    const out: PlayerRef[] = [{ id: myId, team: teams[myId] ?? 'A', x: player.x, z: player.z }]
    if (mode === 'practice') out.push({ id: AI_ID, team: 'B', x: ai.x, z: ai.z })
    for (const id of remote.ids()) {
      if (id === AI_ID) continue
      const p = remote.latest(id)
      if (!p) continue
      out.push({ id, team: teams[id] ?? 'B', x: p.x, z: p.z })
    }
    return out
  }

  function applyQuality(quality: Quality): void {
    appliedQuality = quality
    const p = QUALITY[quality]
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.pixelRatioCap))
    grade.setSamples(p.msaa)
    grade.setGrain(quality === 'high' ? 0.016 : quality === 'medium' ? 0.02 : 0.026)
    lights.setShadowSize(p.shadowMap)
    setOutlineWidth(p.outlinePx)
    world.setDetail(p.detail)
    world.setCounts(p.tufts, p.crowd)
    world.setQuality(quality)
    resize()
  }

  // ------------------------------------------------------------------ rigs
  function syncRigs(): void {
    const want = new Map<string, { name: string; team: Team }>()
    if (mode === 'match') {
      for (const r of roster) {
        if (r.id === myId) continue
        want.set(r.id, { name: r.name, team: r.team })
      }
    } else if (mode === 'practice') {
      want.set(AI_ID, { name: 'Defender', team: 'B' })
    }
    for (const [id, rig] of [...rigs]) {
      const w = want.get(id)
      if (!w || rigTeams.get(id) !== w.team) {
        scene.remove(rig.group)
        rig.dispose()
        rigs.delete(id)
        rigTeams.delete(id)
      }
    }
    for (const [id, w] of want) {
      if (rigs.has(id)) continue
      const rig = new PlayerRig({ id, name: w.name, team: w.team, quality: appliedQuality })
      rigs.set(id, rig)
      rigTeams.set(id, w.team)
      scene.add(rig.group)
      if (id !== AI_ID) {
        remote.setInfo(id, w.name, w.team)
        const home = formationHome(id)
        if (home) remote.snap(id, home[0], home[1], home[2])
      }
    }
  }

  function formationHome(id: string): [number, number, number] | null {
    const r = roster.find((e) => e.id === id)
    if (!r) return null
    const mates = roster.filter((e) => e.team === r.team).sort((a, b) => a.joinedAt - b.joinedAt)
    const i = Math.max(0, mates.findIndex((e) => e.id === id))
    const spread = clamp((i - (mates.length - 1) / 2) * 6.5, -18, 18)
    return r.team === 'A' ? [-(6 + i * 3.8), spread, -Math.PI / 2] : [6 + i * 3.8, spread, Math.PI / 2]
  }

  function formationSlots(): Record<string, [number, number, number]> {
    const slots: Record<string, [number, number, number]> = {}
    for (const r of roster) {
      const home = formationHome(r.id)
      if (home) slots[r.id] = home
    }
    return slots
  }

  // ------------------------------------------------------------------ rules (host)
  function nearestOfTeam(team: Team, x: number, z: number): string | null {
    let best: string | null = null
    let bestD = Infinity
    for (const p of rulesPlayers()) {
      if (p.team !== team) continue
      const d = Math.hypot(p.x - x, p.z - z)
      if (d < bestD) {
        bestD = d
        best = p.id
      }
    }
    return best
  }

  function hostDeadBall(kind: RestartKind, team: Team, x: number, z: number, reason: string, forcedTaker?: string): void {
    if (phase !== 'play') return
    const takerId = forcedTaker ?? nearestOfTeam(team, x, z)
    const slots = restartSlots(kind, team, x, z, takerId, rulesPlayers())
    const msg: MatchEventMsg = { type: 'deadball', kind, team, x, z, takerId, reason, slots }
    net?.sendEvent(msg)
    applyEvent(msg)
    restartStartedAt = nowSec()
  }

  function hostResumePlay(): void {
    const noOffsideRestart = restart !== null && (restart.kind === 'throwin' || restart.kind === 'corner' || restart.kind === 'goalkick')
    const msg: MatchEventMsg = { type: 'play' }
    net?.sendEvent(msg)
    applyEvent(msg)
    if (noOffsideRestart) noOffsideOneTouch = true
  }

  /** Pin the frozen ball to its spot — or into the thrower's hands. */
  function hostPinBall(): void {
    if (!restart) return
    if (restart.kind === 'throwin' && restart.takerId !== null) {
      const t = posOf(restart.takerId)
      if (t) {
        const [fx, fz] = forwardXZ(t.yaw)
        localBall.x = t.x + fx * 0.34
        localBall.z = t.z + fz * 0.34
        localBall.y = 1.66
      }
    } else {
      localBall.x = restart.x
      localBall.z = restart.z
      localBall.y = BALL.r
    }
    localBall.vx = 0
    localBall.vy = 0
    localBall.vz = 0
  }

  function hostCheckOut(): void {
    if (phase !== 'play') return
    const out = checkOutOfPlay(localBall, rulesPlayers(), teamsMap())
    if (!out) return
    const reason =
      out.kind === 'throwin'
        ? 'out on the touchline'
        : out.kind === 'corner'
          ? 'out off a defender'
          : 'out off an attacker'
    hostDeadBall(out.kind, out.team, out.x, out.z, reason)
  }

  function hostCheckOffside(): void {
    if (localBall.lastTouch === prevLastTouch) return
    const t = localBall.lastTouch
    prevLastTouch = t
    if (!t || phase !== 'play') return
    const teams = teamsMap()
    if (offsideFlags.size > 0 && offsideFlags.has(t)) {
      // whistle! indirect free kick where the flagged player interfered
      const p = posOf(t)
      const team = teams[t] ?? 'A'
      offsideFlags.clear()
      if (p) {
        hostDeadBall('freekick', otherTeam(team), clamp(p.x, -PITCH.halfL + 1, PITCH.halfL - 1), clamp(p.z, -PITCH.halfW + 0.6, PITCH.halfW - 0.6), 'offside')
      }
      return
    }
    if (noOffsideOneTouch) {
      noOffsideOneTouch = false
      offsideFlags.clear()
      return
    }
    if (solo()) {
      offsideFlags.clear()
      return
    }
    const team = teams[t]
    if (!team) {
      offsideFlags.clear()
      return
    }
    offsideFlags = offsidePositions(team, localBall.x, rulesPlayers())
    offsideFlags.delete(t)
  }

  function hostCheckSlides(): void {
    if (phase !== 'play') return
    const players = rulesPlayers()
    for (const p of players) {
      const slideT =
        p.id === myId ? player.slideAnimT : p.id === AI_ID ? 0 : (remote.latestAnims(p.id)?.slideT ?? 0)
      if (slideT <= 0.05) {
        slideCleanIds.delete(p.id)
        slidePokedIds.delete(p.id)
        continue
      }
      if (slideT < 0.15) continue
      const bd = Math.hypot(localBall.x - p.x, localBall.z - p.z)
      if (bd < SLIDE.ballRange && localBall.y < 1.0) {
        // clean — the slider won the ball (host applies the poke if unclaimed)
        if (!slidePokedIds.has(p.id) && p.id !== myId) {
          slidePokedIds.add(p.id)
          const dir = p.id === AI_ID ? { x: -1, z: 0 } : slideDirOf(p.id)
          const v = kickVelocity(SLIDE.pokePower, 0.2, dir.x, dir.z)
          localBall.vx = v.vx
          localBall.vy = v.vy
          localBall.vz = v.vz
          localBall.lastTouch = p.id
          prevLastTouch = p.id
          audio.playKick(p.x, p.z, SLIDE.pokePower)
          particles.grassBurst(localBall.x, localBall.z, 8, dir.x, dir.z, 0.9)
        }
        slideCleanIds.add(p.id)
        continue
      }
      if (slideCleanIds.has(p.id)) continue
      // did the lunge catch an opponent first? that's a foul.
      for (const o of players) {
        if (o.team === p.team) continue
        const d = Math.hypot(o.x - p.x, o.z - p.z)
        if (d < SLIDE.foulRange) {
          slideCleanIds.add(p.id)
          const spotX = clamp((p.x + o.x) / 2, -PITCH.halfL + 1, PITCH.halfL - 1)
          const spotZ = clamp((p.z + o.z) / 2, -PITCH.halfW + 0.6, PITCH.halfW - 0.6)
          const ownGoal = defendedGoalX(p.team) // the offender's own goal
          const box = inPenaltyBox(spotX, spotZ, ownGoal)
          if (box) {
            const spot = penaltySpot(ownGoal)
            hostDeadBall('penalty', o.team, spot.x, spot.z, 'foul in the box', o.id)
          } else {
            hostDeadBall('freekick', o.team, spotX, spotZ, 'foul', o.id)
          }
          return
        }
      }
    }
  }

  function slideDirOf(id: string): { x: number; z: number } {
    const v = remote.latestVel(id)
    if (v && Math.hypot(v.vx, v.vz) > 1) {
      const l = Math.hypot(v.vx, v.vz)
      return { x: v.vx / l, z: v.vz / l }
    }
    const p = remote.latest(id)
    if (p) return { x: -Math.sin(p.yaw), z: -Math.cos(p.yaw) }
    return { x: 1, z: 0 }
  }

  // ------------------------------------------------------------------ net handlers
  function hostValidateKick(msg: KickMsg): void {
    if (mode !== 'match') return
    if (phase === 'restart') {
      if (!restart || msg.id !== restart.takerId) return
      const wantThrow = restart.kind === 'throwin'
      if ((msg.kind === 'throw') !== wantThrow) return
      const power = clamp(msg.power, 0, KICK.powerCap)
      const loftN = clamp(msg.loftN, 0, 1)
      if (!wantThrow) {
        const at = remote.latest(msg.id)
        if (!at) return
        const dist = Math.hypot(localBall.x - at.x, localBall.z - at.z)
        if (dist > KICK.hostRangeTolerance || localBall.y > 1.6) return
      }
      const v = wantThrow ? throwVelocity(power, loftN, msg.dx, msg.dz) : kickVelocity(power, loftN, msg.dx, msg.dz)
      localBall.vx = v.vx
      localBall.vy = v.vy
      localBall.vz = v.vz
      localBall.lastTouch = msg.id
      prevLastTouch = msg.id
      const at = remote.latest(msg.id)
      audio.playKick(at?.x ?? restart.x, at?.z ?? restart.z, power)
      if (wantThrow) rigs.get(msg.id)?.playThrow()
      else {
        rigs.get(msg.id)?.playKick()
        particles.grassBurst(localBall.x, localBall.z, 7, msg.dx, msg.dz, 0.8)
      }
      hostResumePlay()
      return
    }
    if (phase !== 'play' || msg.kind !== 'kick') return
    const at = remote.latest(msg.id)
    if (!at) return
    const last = lastHostKick.get(msg.id) ?? -Infinity
    if (nowSec() - last < KICK.hostCooldown) return
    const dist = Math.hypot(localBall.x - at.x, localBall.z - at.z)
    if (dist > KICK.hostRangeTolerance || localBall.y > 1.6) return
    const power = clamp(msg.power, 0, KICK.powerCap)
    const v = kickVelocity(power, clamp(msg.loftN, 0, 1), msg.dx, msg.dz)
    localBall.vx = v.vx
    localBall.vy = v.vy
    localBall.vz = v.vz
    localBall.lastTouch = msg.id
    prevLastTouch = msg.id
    lastHostKick.set(msg.id, nowSec())
    audio.playKick(at.x, at.z, power)
    rigs.get(msg.id)?.playKick()
    particles.grassBurst(localBall.x, localBall.z, 7, msg.dx, msg.dz, 0.8)
  }

  function makeNetHandlers() {
    return {
      onRoster: (next: RosterEntry[]) => {
        const prev = roster
        roster = next
        const prevIds = new Set(prev.map((r) => r.id))
        const nextIds = new Set(next.map((r) => r.id))
        for (const r of next) if (!prevIds.has(r.id)) toast(`${r.name} joined`)
        for (const r of prev) if (!nextIds.has(r.id)) toast(`${r.name} left`)

        if (next.length > NET.maxPlayers) {
          const newest = next.reduce((a, b) => (a.joinedAt >= b.joinedAt ? a : b))
          if (newest.id === myId) {
            toast(`Room is full (${NET.maxPlayers} players).`)
            cmd({ type: 'leaveRoom' })
            return
          }
        }

        const newHost = next[0]?.id ?? null
        if (prevHostId !== null && newHost !== prevHostId && newHost !== null) {
          // host migration: the next-oldest player picks the match up where it was
          const hostName = next[0]?.name ?? 'Someone'
          if (newHost === myId) {
            if (screen === 'game') takeOverHosting()
            toast('Host left — you are hosting now.')
          } else if (screen === 'game') {
            toast(`Host left — ${hostName} is hosting now.`)
          }
        }
        prevHostId = newHost

        const me = next.find((r) => r.id === myId)
        if (me && prevIds.size > 0) {
          const countA = next.filter((r) => r.team === 'A').length
          const countB = next.filter((r) => r.team === 'B').length
          if (me.team === 'A' && countA - countB > 1) net?.updatePresence({ team: 'B' })
          else if (me.team === 'B' && countB - countA > 1) net?.updatePresence({ team: 'A' })
        }

        for (const r of next) if (r.id !== myId) remote.setInfo(r.id, r.name, r.team)
        for (const id of remote.ids()) if (!nextIds.has(id)) remote.remove(id)
        syncRigs()
        pushUi()
      },
      onPlayerState: (msg: PlayerStateMsg) => {
        remote.onState({ ...msg, t: nowSec() })
      },
      onBallState: (msg: BallStateMsg, meta: { clock: number; phase: Phase; scoreA: number; scoreB: number }) => {
        if (msg.from) {
          // the Zero Hour caster owns the ball while time stands (plus a short hand-back grace)
          const owner = timeStop ? timeStop.by : simT < tsGraceUntil ? tsGraceFrom : null
          if (msg.from !== owner) return
          if (isHost()) copyBall(localBall, msg)
          else hostBall = msg
          return
        }
        if (isHost()) return
        hostBall = msg
        clock = meta.clock
        scoreA = meta.scoreA
        scoreB = meta.scoreB
      },
      onKick: (msg: KickMsg) => {
        if (isHost()) {
          hostValidateKick(msg)
        } else {
          const at = remote.latest(msg.id)
          if (at) audio.playKick(at.x, at.z, clamp(msg.power, 0, 1))
          if (msg.kind === 'throw') rigs.get(msg.id)?.playThrow()
          else rigs.get(msg.id)?.playKick()
        }
      },
      onEvent: (msg: MatchEventMsg) => applyEvent(msg),
      onStatus: (status: string, detail?: string) => {
        const was = netStatus
        netStatus = detail === 'reconnecting' ? 'reconnecting' : status
        if (status === 'error') toast(detail ? `Connection error: ${detail}` : 'Connection error.')
        if (netStatus === 'reconnecting' && was === 'connected') toast('Connection dropped — reconnecting…')
        if (status === 'connected' && was === 'reconnecting') toast('Reconnected')
        pushUi()
      },
    }
  }

  // ------------------------------------------------------------------ events
  function applyEvent(msg: MatchEventMsg): void {
    switch (msg.type) {
      case 'goal': {
        scoreA = msg.scoreA
        scoreB = msg.scoreB
        if (msg.scorerId === myId) gainEgo(SUPER.egoGoal)
        phase = 'goal'
        restart = null
        input.inputEnabled = false
        if (screen === 'game') {
          const goalX = msg.team === 'A' ? PITCH.halfL : -PITCH.halfL
          celebrateGoal(goalX, msg.team, msg.scorerName)
        }
        break
      }
      case 'countdown': {
        clearSupers(false)
        applyCountdown(msg.endsIn, msg.slots, msg.ball)
        break
      }
      case 'super': {
        applySuper(msg)
        break
      }
      case 'superClaim': {
        applyClaim(msg)
        break
      }
      case 'play': {
        if (phase === 'play') break
        phase = 'play'
        restart = null
        countdownEndsAt = null
        spectating = false
        input.inputEnabled = !paused && !spectating
        audio.playWhistle('short')
        break
      }
      case 'deadball': {
        clearSupers(false)
        phase = 'restart'
        restart = { kind: msg.kind, team: msg.team, x: msg.x, z: msg.z, takerId: msg.takerId, reason: msg.reason }
        countdownEndsAt = null
        victory = null
        spectating = false
        input.inputEnabled = !paused && !spectating
        audio.playWhistle(msg.kind === 'penalty' ? 'long' : 'short')
        banner = {
          title: msg.kind === 'penalty' ? 'PENALTY!' : RESTART_LABEL[msg.kind].toUpperCase(),
          sub: `${TEAM_NAME[msg.team]}${msg.reason ? ` · ${msg.reason}` : ''}`,
          tone: msg.team,
          until: nowSec() + RULES.restartBanner + 1.1,
        }
        const mine = msg.slots[myId]
        if (mine) {
          player.teleport(mine[0], mine[1])
          cameraRig.yaw = mine[2]
          cameraRig.pitch = -0.06
        }
        for (const [id, slot] of Object.entries(msg.slots)) {
          if (id === myId) continue
          if (id === AI_ID) {
            ai.x = slot[0]
            ai.z = slot[1]
            ai.yaw = slot[2]
            ai.vx = 0
            ai.vz = 0
            continue
          }
          remote.snap(id, slot[0], slot[1], slot[2])
        }
        setBall(msg.x, msg.z)
        hostBall = null
        break
      }
      case 'halftime': {
        scoreA = msg.scoreA
        scoreB = msg.scoreB
        phase = 'halftime'
        restart = null
        input.inputEnabled = false
        countdownEndsAt = null
        half = 2
        banner = { title: 'Half Time', sub: 'Sip some water.', tone: 'neutral', until: nowSec() + msg.resumeIn - 0.2 }
        audio.playWhistle('long')
        break
      }
      case 'victory': {
        scoreA = msg.scoreA
        scoreB = msg.scoreB
        phase = 'victory'
        restart = null
        input.inputEnabled = false
        countdownEndsAt = null
        victory = { winner: msg.winner, scorers: msg.scorers }
        banner = null
        audio.playWhistle('full')
        audio.playCheer()
        world.cheerCrowd()
        break
      }
      case 'teams': {
        for (const [id, team] of Object.entries(msg.teams)) {
          const r = roster.find((e) => e.id === id)
          if (r) r.team = team
          if (id === myId) net?.updatePresence({ team })
          const info = remote.getInfo(id)
          if (info) remote.setInfo(id, info.name, team)
        }
        syncRigs()
        break
      }
      case 'hello': {
        if (isHost() && mode === 'match') {
          net?.sendEvent({
            type: 'snapshot',
            phase,
            scoreA,
            scoreB,
            clock,
            half,
            ball: { ...localBall, seq: ballSeq, t: nowSec() },
            restart: phase === 'restart' && restart !== null ? { ...restart } : null,
            audience: [msg.from],
          })
        }
        break
      }
      case 'snapshot': {
        if (!msg.audience.includes(myId)) return
        scoreA = msg.scoreA
        scoreB = msg.scoreB
        clock = msg.clock
        half = msg.half
        if (msg.phase === 'lobby') {
          screen = 'room'
          phase = 'lobby'
          restart = null
        } else {
          screen = 'game'
          phase = msg.phase
          restart =
            msg.restart !== null && msg.phase === 'restart'
              ? { kind: msg.restart.kind, team: msg.restart.team, x: msg.restart.x, z: msg.restart.z, takerId: msg.restart.takerId, reason: msg.restart.reason }
              : null
          spectating = msg.phase === 'play' || msg.phase === 'goal' || msg.phase === 'halftime' || msg.phase === 'restart'
          if (spectating) {
            player.teleport(9, PITCH.wallW / 2 - 1.6)
            cameraRig.yaw = yawFromDir(-9, -20)
            cameraRig.pitch = -0.05
          }
          localBall.x = msg.ball.x
          localBall.y = msg.ball.y
          localBall.z = msg.ball.z
          localBall.vx = msg.ball.vx
          localBall.vy = msg.ball.vy
          localBall.vz = msg.ball.vz
          localBall.lastTouch = msg.ball.lastTouch
          hostBall = msg.ball
        }
        syncRigs()
        break
      }
    }
    pushUi()
  }

  function celebrateGoal(goalX: number, team: Team, scorerName: string | null): void {
    banner = {
      title: 'GOOOAL!',
      sub: scorerName ? `${scorerName} · ${TEAM_NAME[team]}` : `${TEAM_NAME[team]} scores`,
      tone: team,
      until: nowSec() + 3.4,
    }
    audio.playWhistle('short')
    audio.playCheer()
    audio.playUI('goal-banner')
    cameraRig.goalShake(1)
    particles.petalBurst(goalX * 0.94, 1.1, 0, 38)
    particles.petalRain(goalX * 0.8, 0, 15, 34)
    // petals also drift through the scorer's own view
    const [fx, fz] = forwardXZ(cameraRig.yaw)
    particles.petalRain(player.x + fx * 3.2, player.z + fz * 3.2, 2.2, 16)
    world.cheerCrowd()
    world.wobbleNet(goalX, 1)
  }

  function applyCountdown(endsIn: number, slots: Record<string, [number, number, number]>, ball: [number, number, number]): void {
    phase = 'countdown'
    screen = 'game'
    victory = null
    banner = null
    spectating = false
    paused = false
    restart = null
    input.inputEnabled = false
    countdownEndsAt = nowSec() + endsIn
    lastCountdownTick = 99
    const mine = slots[myId]
    if (mine) {
      player.teleport(mine[0], mine[1])
      cameraRig.yaw = mine[2]
      cameraRig.pitch = 0
    }
    for (const [id, slot] of Object.entries(slots)) {
      if (id === myId) continue
      remote.snap(id, slot[0], slot[1], slot[2])
    }
    setBall(ball[0], ball[2])
    localBall.y = ball[1]
    audio.setCrowdLevel(0.45)
    pushUi()
  }

  /**
   * I just became host mid-match: adopt the last authoritative ball I had and
   * restart whatever host timer the old host was running.
   */
  function takeOverHosting(): void {
    if (hostBall) copyBall(localBall, hostBall)
    hostBall = null
    hostTimers.length = 0
    const t = nowSec()
    if (phase === 'goal' || phase === 'halftime') {
      hostTimers.push({
        at: t + 2,
        fn: () => {
          if (scoreA >= MATCH.goalsToWin || scoreB >= MATCH.goalsToWin) {
            const winner: Team | 'draw' = scoreA === scoreB ? 'draw' : scoreA > scoreB ? 'A' : 'B'
            const v: MatchEventMsg = { type: 'victory', winner, scoreA, scoreB, scorers }
            net?.sendEvent(v)
            applyEvent(v)
          } else beginKickoff()
        },
      })
    } else if (phase === 'restart') {
      restartStartedAt = t
    }
    // 'countdown' resolves through the existing host fallback when it hits zero
  }

  function endMatchToLobby(): void {
    clearSupers(true)
    phase = 'lobby'
    screen = 'room'
    paused = false
    spectating = false
    victory = null
    banner = null
    restart = null
    offsideFlags.clear()
    slideCleanIds.clear()
    slidePokedIds.clear()
    noOffsideOneTouch = false
    countdownEndsAt = null
    hostTimers.length = 0
    input.inputEnabled = false
    input.exitLock()
    setBall(0, 0)
    pushUi()
  }

  function beginKickoff(): void {
    const slots = formationSlots()
    const ball: [number, number, number] = [0, BALL.r, 0]
    const msg: MatchEventMsg = { type: 'countdown', endsIn: MATCH.countdown, slots, ball }
    net?.sendEvent(msg)
    applyEvent(msg)
    hostTimers.push({
      at: nowSec() + MATCH.countdown,
      fn: () => {
        if (phase !== 'countdown') return
        const play: MatchEventMsg = { type: 'play' }
        net?.sendEvent(play)
        applyEvent(play)
      },
    })
  }

  // ------------------------------------------------------------------ match flow (host)
  function hostGoalScored(team: Team): void {
    phase = 'goal'
    restart = null
    input.inputEnabled = false
    const scorerId = localBall.lastTouch
    const scorer = roster.find((r) => r.id === scorerId)
    if (team === 'A') scoreA++
    else scoreB++
    if (scorer) scorers.push({ id: scorer.id, name: scorer.name, team })
    const msg: MatchEventMsg = {
      type: 'goal',
      team,
      scorerId,
      scorerName: scorer?.name ?? null,
      scoreA,
      scoreB,
      kickoffIn: MATCH.goalCeleb,
    }
    net?.sendEvent(msg)
    applyEvent(msg)
    hostTimers.push({
      at: nowSec() + MATCH.goalCeleb,
      fn: () => {
        if (scoreA >= MATCH.goalsToWin || scoreB >= MATCH.goalsToWin) {
          const winner: Team | 'draw' = scoreA === scoreB ? 'draw' : scoreA > scoreB ? 'A' : 'B'
          const v: MatchEventMsg = { type: 'victory', winner, scoreA, scoreB, scorers }
          net?.sendEvent(v)
          applyEvent(v)
        } else {
          beginKickoff()
        }
      },
    })
  }

  function hostCheckClock(dt: number): void {
    if (phase !== 'play') return
    clock += dt
    if (solo()) return // session timer only — solo modes have no halves and never end
    if (half === 1 && clock >= MATCH.halfLen) {
      const msg: MatchEventMsg = { type: 'halftime', scoreA, scoreB, resumeIn: MATCH.halftimeBreak }
      net?.sendEvent(msg)
      applyEvent(msg)
      hostTimers.push({ at: nowSec() + MATCH.halftimeBreak, fn: () => beginKickoff() })
    } else if (half === 2 && clock >= MATCH.halfLen * MATCH.halves) {
      const winner: Team | 'draw' = scoreA === scoreB ? 'draw' : scoreA > scoreB ? 'A' : 'B'
      const v: MatchEventMsg = { type: 'victory', winner, scoreA, scoreB, scorers }
      net?.sendEvent(v)
      applyEvent(v)
    }
  }

  // ------------------------------------------------------------------ practice AI
  function stepAI(dt: number): void {
    ai.kickCd -= dt
    ai.sealT = Math.max(0, ai.sealT - dt)
    ai.knockT = Math.max(0, ai.knockT - dt)
    ai.stopT = Math.max(0, ai.stopT - dt)
    // super statuses: sealed / frozen in time stand still, knocked slides to a stop
    if (ai.stopT > 0 || ai.sealT > 0) {
      ai.vx = 0
      ai.vz = 0
      return
    }
    if (ai.knockT > 0 || ai.grip > 0.55) {
      const d = Math.exp(-5 * dt)
      ai.vx *= d
      ai.vz *= d
      ai.x = clamp(ai.x + ai.vx * dt, -PITCH.halfL + 0.5, PITCH.halfL + GOAL.depth - 0.3)
      ai.z = clamp(ai.z + ai.vz * dt, -PITCH.halfW + 0.4, PITCH.halfW - 0.4)
      return
    }
    const goalX = PITCH.halfL
    // The defender holds its own zone: it only hunts the ball once it is in
    // the defending half, so you get to dribble up and try to beat it 1v1.
    const ballInZone = localBall.x > 2
    let px: number
    let pz: number
    if (ballInZone) {
      px = localBall.x
      pz = localBall.z
    } else {
      // drop off goal-side: the further the ball is from the goal, the deeper
      // the defender sits — shooting lanes open up, 1v1s happen near the box
      const dxg = goalX - localBall.x
      const dzg = -localBall.z
      const dg = Math.hypot(dxg, dzg) || 1
      const hold = clamp(1.5 + dg * 0.24, 1.5, 8.5)
      px = clamp(localBall.x + (dxg / dg) * hold, 8, goalX - 1.5)
      // slight goal-side bias so it guards a lane, not the exact shooting line
      pz = clamp(localBall.z * 0.72 + (dzg / dg) * hold, -PITCH.halfW + 1, PITCH.halfW - 1)
    }
    const dAi = Math.hypot(localBall.x - ai.x, localBall.z - ai.z)
    const maxV = 4.7
    const dx = px - ai.x
    const dz = pz - ai.z
    const dl = Math.hypot(dx, dz)
    if (dl > 0.15) {
      ai.vx += ((dx / dl) * maxV - ai.vx) * Math.min(1, 7 * dt)
      ai.vz += ((dz / dl) * maxV - ai.vz) * Math.min(1, 7 * dt)
    } else {
      ai.vx *= Math.exp(-6 * dt)
      ai.vz *= Math.exp(-6 * dt)
    }
    ai.x = clamp(ai.x + ai.vx * dt, -PITCH.halfL + 0.5, PITCH.halfL + GOAL.depth - 0.3)
    ai.z = clamp(ai.z + ai.vz * dt, -PITCH.halfW + 0.4, PITCH.halfW - 0.4)
    ai.yaw = yawFromDir(localBall.x - ai.x, localBall.z - ai.z)

    if (ballInZone && dAi < 1.3 && localBall.y < 1.05 && ai.kickCd <= 0 && !(dragon && !dragon.done)) {
      const power = 0.3 + Math.random() * 0.3
      const dirX = -(0.6 + Math.random() * 0.4)
      const dirZ = (Math.random() - 0.5) * 1.4
      const v = kickVelocity(power, 0.12 + Math.random() * 0.2, dirX, dirZ)
      localBall.vx = v.vx
      localBall.vy = v.vy
      localBall.vz = v.vz
      localBall.lastTouch = AI_ID
      ai.kickCd = 1.7
      audio.playKick(ai.x, ai.z, power)
      rigs.get(AI_ID)?.playKick()
      particles.grassBurst(localBall.x, localBall.z, 6, dirX, dirZ, 0.8)
    }
  }

  /** The practice AI takes its restarts after a beat. */
  function aiTakeRestart(): void {
    if (!restart) return
    const t = posOf(AI_ID)
    if (!t) return
    let dirX: number
    let dirZ: number
    let power = 0.5
    let loft = 0.28
    if (restart.kind === 'penalty') {
      // AI attacks -X
      dirX = -1
      dirZ = (Math.random() - 0.5) * 0.35
      power = 0.72 + Math.random() * 0.15
      loft = 0.14
    } else {
      const cx = -restart.x * 0.4
      const cz = -restart.z * 0.4
      const l = Math.hypot(cx, cz) || 1
      dirX = cx / l
      dirZ = cz / l
      if (restart.kind === 'corner') {
        power = 0.55
        loft = 0.45
        dirX = -Math.sign(restart.x || 1) * 0.9
        dirZ = -Math.sign(restart.z || 1) * 0.42
      }
    }
    const v = restart.kind === 'throwin' ? throwVelocity(power, loft, dirX, dirZ) : kickVelocity(power, loft, dirX, dirZ)
    localBall.x = t.x + dirX * 0.4
    localBall.z = t.z + dirZ * 0.4
    localBall.y = restart.kind === 'throwin' ? 1.9 : BALL.r
    localBall.vx = v.vx
    localBall.vy = v.vy
    localBall.vz = v.vz
    localBall.lastTouch = AI_ID
    prevLastTouch = AI_ID
    if (restart.kind === 'throwin') {
      aiThrowT = 0.5
      rigs.get(AI_ID)?.playThrow()
    } else {
      rigs.get(AI_ID)?.playKick()
    }
    audio.playKick(t.x, t.z, power)
    particles.grassBurst(localBall.x, localBall.z, 6, dirX, dirZ, 0.8)
    hostResumePlay()
  }

  // ------------------------------------------------------------------ game step
  function stepGame(dt: number): void {
    const frame = input.poll(dt)
    simT += dt
    if (superLock > 0) superLock = Math.max(0, superLock - dt)
    const iAmTaker = phase === 'restart' && restart !== null && restart.takerId === myId
    const canAct = (phase === 'play' || iAmTaker) && !spectating && !paused && !player.disabled
    chargeCache.held = frame.chargeHeld && canAct
    chargeCache.power = clamp(frame.chargeTime / KICK.chargeTime, 0, 1)

    if (!paused) cameraRig.applyLook(frame.lookDx, frame.lookDy, 0.0022 * settings.sens, settings.invertY)

    const frozen = (phase !== 'play' && phase !== 'restart') || spectating || paused
    const actBefore = player.action ? player.action.kind : 0
    // super pulls act on the body before it steps
    stepCyclones(dt)
    player.step(dt, frame, cameraRig.yaw, frozen)
    stepGlide(dt)

    // keep the local player inside the boundary wall (same rounded-rect SDF
    // the ball uses — no ghosting through the compound wall)
    {
      const sd = sdRoundedRect(player.x, player.z, PITCH.wallL / 2 - 0.45, PITCH.wallW / 2 - 0.45, PITCH.wallR - 0.22)
      if (sd > -PLAYER.r) {
        const e = 0.03
        const gx = sdRoundedRect(player.x + e, player.z, PITCH.wallL / 2 - 0.45, PITCH.wallW / 2 - 0.45, PITCH.wallR - 0.22) - sdRoundedRect(player.x - e, player.z, PITCH.wallL / 2 - 0.45, PITCH.wallW / 2 - 0.45, PITCH.wallR - 0.22)
        const gz = sdRoundedRect(player.x, player.z + e, PITCH.wallL / 2 - 0.45, PITCH.wallW / 2 - 0.45, PITCH.wallR - 0.22) - sdRoundedRect(player.x, player.z - e, PITCH.wallL / 2 - 0.45, PITCH.wallW / 2 - 0.45, PITCH.wallR - 0.22)
        const gl = Math.hypot(gx, gz) || 1
        const push = sd + PLAYER.r
        player.x -= (gx / gl) * push
        player.z -= (gz / gl) * push
      }
    }
    // mountain rock is solid (and a heave under your feet launches you)
    stepWalls(dt)

    if (!frozen && !player.disabled) {
      if (frame.cutPressed) player.tryCut(frame.moveX, cameraRig.yaw)
      if (frame.stepPressed) player.tryStepover(cameraRig.yaw, frame.moveX, frame.moveY)
      if (frame.flickPressed && phase === 'play') {
        const d = Math.hypot(localBall.x - player.x, localBall.z - player.z)
        if (d < SKILL.flickRange && localBall.y < 1.0 && player.tryFlick()) {
          const [fx, fz] = forwardXZ(cameraRig.yaw)
          const v = kickVelocity(0.3, 0.75, fx, fz)
          localBall.vx = v.vx * 0.35 + player.vx * 0.4
          localBall.vy = SKILL.flickVy
          localBall.vz = v.vz * 0.35 + player.vz * 0.4
          localBall.lastTouch = myId
          prevLastTouch = myId
          myKickT = 0.8
          audio.playFlick(localBall.x, localBall.z)
          particles.grassBurst(localBall.x, localBall.z, 8, fx, fz, 0.7)
          if (mode === 'match' && !isHost()) {
            // clients inform the host about the predicted touch
            net?.sendKick({ id: myId, dx: fx, dz: fz, loftN: 0.75, power: 0.3, kind: 'kick', seq: mySeq++ })
          }
        }
      }
      if (frame.slidePressed && phase === 'play') {
        player.trySlide(cameraRig.yaw, frame.moveX, frame.moveY)
      }
    }

    // flair-skill dispatch (phase 'play' only — never during restart pins)
    if (!frozen && !player.disabled && phase === 'play') dispatchSkills(frame)
    // flair moves feed the EGO
    if (actBefore === 0 && player.action !== null) gainEgo(SUPER.egoFlair)

    // EGO supers (keys 1–6)
    if (frame.superPressed >= 1 && frame.superPressed <= 6 && !frozen && !player.disabled && phase === 'play') {
      trySuper(frame.superPressed as SuperKind)
    }
    stepTimeStop()
    stepBolts()
    if (phase === 'play' && !spectating && !timeStop) {
      gainEgo(SUPER.egoPerSec * (solo() ? SUPER.egoSoloMult : 1) * dt)
    }
    if (player.sealT > 0 && simT - lastZap > 0.42) {
      lastZap = simT
      audio.playZap(player.x, player.z)
      cameraRig.shake(0.12, 0.15)
    }

    // flair-skill camera drives — sim-authoritative so the sweeps stay
    // time-correct at any frame rate; the ball orbit follows cameraRig.yaw
    {
      const act = player.action
      let rainbowLook = 0
      if (act) {
        const u = clamp(1 - act.t / act.total, 0, 1)
        if (act.kind === 3) {
          cameraRig.driveSpin(easedSweep(u), act.s)
        } else if (act.kind === 5) {
          const windU = SKILL2.crouyff.windup / act.total
          if (u > windU) cameraRig.driveTurn(easedSweep(clamp((u - windU) / (1 - windU), 0, 1)), act.s)
        } else if (act.kind === 1 && skillBall !== null && skillBall.flicked) {
          // look up while the ball sails overhead
          const sinceFlick = act.total - act.t - SKILL2.rainbow.riseTime
          rainbowLook = 0.34 * clamp(sinceFlick / 0.1, 0, 1) * clamp(act.t / 0.16, 0, 1)
        }
      }
      cameraRig.setRainbowLook(rainbowLook)
    }

    // my slide's ball poke (local prediction; host validates via the kick msg)
    if (player.sliding && !mySlideClean && phase === 'play' && !spectating) {
      const d = Math.hypot(localBall.x - player.x, localBall.z - player.z)
      if (d < SLIDE.ballRange && localBall.y < 0.95) {
        const dir = player.slideDir ?? { x: -Math.sin(cameraRig.yaw), z: -Math.cos(cameraRig.yaw) }
        const v = kickVelocity(SLIDE.pokePower, 0.2, dir.x, dir.z)
        localBall.vx = v.vx * 0.8 + player.vx * 0.25
        localBall.vy = v.vy * 0.8
        localBall.vz = v.vz * 0.8 + player.vz * 0.25
        localBall.lastTouch = myId
        prevLastTouch = myId
        mySlideClean = true
        gainEgo(SUPER.egoClean)
        audio.playKick(player.x, player.z, SLIDE.pokePower)
        particles.grassBurst(localBall.x, localBall.z, 7, dir.x, dir.z, 0.9)
        if (mode === 'match') {
          net?.sendKick({ id: myId, dx: dir.x, dz: dir.z, loftN: 0.2, power: SLIDE.pokePower, kind: 'kick', seq: mySeq++ })
        }
      }
    }
    if (!player.sliding && mySlideClean) mySlideClean = false

    // restart zone keeping (own player)
    if (phase === 'restart' && restart && !spectating && !paused) {
      if (restart.kind === 'throwin' && restart.takerId === myId) {
        const need = PITCH.halfW + RULES.throwStandOff - 0.06
        if (Math.abs(player.z) < need) player.z = Math.sign(player.z || restart.z || 1) * need
      }
      if (restart.kind === 'penalty' && restart.takerId !== myId) {
        const goalX = restart.x > 0 ? PITCH.halfL : -PITCH.halfL
        if (inPenaltyBox(player.x, player.z, goalX)) {
          const behindX = restart.x - Math.sign(restart.x) * 1.0
          player.x = goalX > 0 ? Math.min(behindX, PITCH.halfL - RULES.boxDepth - 0.5) : Math.max(behindX, -PITCH.halfL + RULES.boxDepth + 0.5)
        }
      }
    }

    // my dribbler record
    myDribbler.id = myId
    myDribbler.x = player.x
    myDribbler.z = player.z
    myDribbler.vx = player.vx
    myDribbler.vz = player.vz
    myDribbler.yaw = cameraRig.yaw
    myDribbler.sprinting = player.sprinting

    // "eyes on the ball" — ease the gaze down while the ball is at our feet
    if (phase === 'play' && !spectating) {
      if (player.juggling) {
        // juggle gaze: steady ~0.3 drop so the bouncing ball stays framed
        cameraRig.setDribbleBias(0.3)
      } else {
        const bd = Math.hypot(localBall.x - player.x, localBall.z - player.z)
        // every factor fades smoothly — hard on/off thresholds made the view
        // bob as dribble touches nudged the ball in and out of range
        const proximity = clamp(1 - (bd - 0.25) / (PLAYER.dribbleRadius * 1.6), 0, 1)
        const heightFade = clamp((0.9 - localBall.y) / 0.4, 0, 1)
        // looking up (e.g. at the goal) hands the view back to you
        const lookFade = clamp((0.2 - cameraRig.pitch) / 0.35, 0, 1)
        // while charging, keep only a hint of the drop so chip aim stays free
        const chargeDamp = frame.chargeHeld ? 0.55 : 1
        const wantBias = 0.45 * proximity * heightFade * lookFade * chargeDamp
        cameraRig.setDribbleBias(wantBias)
      }
    } else {
      cameraRig.setDribbleBias(0)
    }

    // kick / throw release — aim = look, loft = camera pitch, power = hold time
    if (frame.kickRelease) handleKickRelease(frame)

    // ------------------------------------------------------------------ ball
    // bodies the ball bumps off — anyone knocked flat or mid-glide is out of the way
    const bodies: Array<{ id: string; x: number; z: number; vx: number; vz: number }> = []
    if (player.knockT <= 0 && !player.gliding) bodies.push({ id: myId, x: player.x, z: player.z, vx: player.vx, vz: player.vz })
    for (const id of remote.ids()) {
      if (id === AI_ID) continue
      const p = remote.latest(id)
      if (!p) continue
      const st = remote.latestStatus(id)?.st ?? 0
      if (st === 2 || st === 5) continue
      if (remote.age(id, nowSec()) > STALE_AFTER) continue
      const v = remote.latestVel(id)
      bodies.push({ id, x: p.x, z: p.z, vx: v?.vx ?? 0, vz: v?.vz ?? 0 })
    }
    if (mode === 'practice' && ai.knockT <= 0) bodies.push({ id: AI_ID, x: ai.x, z: ai.z, vx: ai.vx, vz: ai.vz })
    // scripted ball windows: the dragon's curve, and Zero Hour (only the caster's ball moves)
    const dragonOwnsBall = dragon !== null && !dragon.done
    const tsOther = timeStop !== null && timeStop.by !== myId
    const tsMine = timeStop !== null && timeStop.by === myId
    if (tsMine && tsBall && tsBall.frozen && Math.hypot(localBall.x - player.x, localBall.z - player.z) < 1.35) {
      tsBall.frozen = false // touched it — it's yours to move
    }
    const tsHold = tsMine && tsBall !== null && (tsBall.frozen || tsBall.held !== null)
    const activeBodies = phase === 'play' || phase === 'goal' ? bodies : []

    if (dragonOwnsBall) {
      // the Crimson Dragon carries the ball — no touches, no bumps, no corrections
      stepDragon()
    } else if (tsOther) {
      // time is stopped by someone else: the ball hangs exactly where it was
      // (the caster streams it; the host holds its physics too)
      if (hostBall && hostBall.from === timeStop?.by) copyBall(localBall, hostBall)
    } else if (tsHold) {
      // my Zero Hour: the ball hangs until I touch it / after my kick leaves the foot
    } else if (phase === 'restart' && restart) {
      // frozen dead ball — pinned by the host, predicted by the taker
      if (restart.kind === 'throwin' && restart.takerId === myId) {
        const [fx, fz] = forwardXZ(cameraRig.yaw)
        localBall.x = player.x + fx * 0.34
        localBall.z = player.z + fz * 0.34
        localBall.y = 1.66
        localBall.vx = 0
        localBall.vy = 0
        localBall.vz = 0
      } else if (solo() || isHost()) {
        hostPinBall()
      } else if (hostBall) {
        copyBall(localBall, hostBall)
      }
    } else if (solo() || isHost() || tsMine) {
      // HOST / solo (or the Zero Hour caster): authoritative ball
      const dribblers: Dribbler[] = player.disabled ? [] : [myDribbler]
      if (tsMine) {
        // only I move in stopped time
      } else if (mode === 'practice') {
        if (ai.knockT <= 0 && ai.sealT <= 0 && ai.stopT <= 0 && ai.grip < 0.55)
        dribblers.push({ id: AI_ID, x: ai.x, z: ai.z, vx: ai.vx, vz: ai.vz, yaw: ai.yaw, sprinting: false, touchTimer: 0 })
      } else {
        for (const id of remote.ids()) {
          if (id === AI_ID) continue
          const p = remote.latest(id)
          if (!p) continue
          if (remoteDisabled(id)) continue
          let rec = remoteDribblers.get(id)
          if (!rec) {
            rec = { id, x: p.x, z: p.z, vx: 0, vz: 0, yaw: p.yaw, sprinting: false, touchTimer: 0 }
            remoteDribblers.set(id, rec)
          }
          const v = remote.latestVel(id)
          rec.x = p.x
          rec.z = p.z
          rec.vx = v?.vx ?? 0
          rec.vz = v?.vz ?? 0
          rec.yaw = p.yaw
          dribblers.push(rec)
        }
      }
      if (phase === 'play') {
        const near = nearestDribbler(localBall, dribblers)
        // skip my own dribble touches while a flair action / juggle owns the ball,
        // or while a skill exit is still clearing the gather radius
        if (near && !(near.id === myId && (player.juggling || player.disabled || ballPinnedByAction() || skillBallGrace > 0))) {
          const ev = dribbleStep(localBall, near, dt)
          if (ev.touched) {
            audio.playTouch(localBall.x, localBall.z, ev.sprintTouch)
            if (!ev.sprintTouch && near.id === myId) particles.grassBurst(localBall.x, localBall.z, 2, 0, 0, 0.35)
          }
        }
      }
      const ev = stepBall(localBall, dt, activeBodies)
      wallBounce()
      handleBallEvents(ev, true)
      if (tsMine && tsBall && tsBall.driftAt >= 0 && simT - tsBall.driftAt > SUPER.timeStop.kickDrift) {
        // a ball kicked in stopped time flies a moment, then hangs until time resumes
        tsBall.held = { vx: localBall.vx, vy: localBall.vy, vz: localBall.vz }
        tsBall.driftAt = -1
        localBall.vx = 0
        localBall.vy = 0
        localBall.vz = 0
        manga.sfxAt('ピタッ', localBall.x, localBall.y + 0.5, localBall.z, elapsed, { size: 0.7 })
      }
      if (mode !== 'free' && !timeStop) {
        // free play: no whistles, no restarts — the compound wall keeps the
        // ball alive, so nothing ever interrupts the session
        hostCheckOut()
        hostCheckOffside()
        hostCheckSlides()
      }
      hostCheckClock(dt)
    } else {
      // CLIENT: local prediction + gentle correction toward host authority
      if (phase === 'play' && !player.juggling && !player.disabled && !ballPinnedByAction() && skillBallGrace <= 0) {
        const ev = dribbleStep(localBall, myDribbler, dt)
        if (ev.touched) audio.playTouch(localBall.x, localBall.z, ev.sprintTouch)
      }
      const ev = stepBall(localBall, dt, activeBodies)
      wallBounce()
      handleBallEvents(ev, false)
      if (myKickT > 0) myKickT -= dt

      if (hostBall) {
        const err = Math.hypot(localBall.x - hostBall.x, localBall.y - hostBall.y, localBall.z - hostBall.z)
        const iAmDribbling =
          Math.hypot(localBall.x - player.x, localBall.z - player.z) < PLAYER.dribbleRadius && localBall.y < 0.7 && myKickT <= 0
        if (err > 4) {
          copyBall(localBall, hostBall)
          if (player.juggling) stopJuggle(false)
        } else if (player.juggling || ballPinnedByAction()) {
          // kinematic ownership (juggle / skill pins) — corrections stand down;
          // the host's own dribble magnet keeps its ball near our feet
        } else if (iAmDribbling) {
          blendBall(localBall, hostBall, 4.5, 5, dt)
        } else if (myKickT > 0) {
          blendBall(localBall, hostBall, 6, 7, dt)
        } else if (err > 2.5) {
          copyBall(localBall, hostBall)
        } else {
          blendBall(localBall, hostBall, 9, 9, dt)
        }
      }
    }

    // flair-skill ball work — pins + impulses run AFTER physics (they win,
    // exactly like the throw-in hold); exits fire on the frame the action ends
    if (skillBallGrace > 0) skillBallGrace = Math.max(0, skillBallGrace - dt)
    if (player.action === null && actBefore !== 0 && skillBall !== null) {
      // the action just ended — drag moves release the ball forward
      if (skillBall.owned) {
        const [fx, fz] = forwardXZ(cameraRig.yaw)
        if (actBefore === 3) {
          skillBallGrace = 1
          localBall.vx = fx * SKILL2.roulette.exitSpeed + player.vx * 0.3
          localBall.vy = 0.3
          localBall.vz = fz * SKILL2.roulette.exitSpeed + player.vz * 0.3
          localBall.lastTouch = myId
          prevLastTouch = myId
          myKickT = 0.8
          myDribbler.touchTimer = 0.5
          audio.playTouch(localBall.x, localBall.z, false)
          if (mode === 'match' && !isHost()) {
            net?.sendKick({ id: myId, dx: fx, dz: fz, loftN: 0.08, power: 0.18, kind: 'kick', seq: mySeq++ })
          }
        } else if (actBefore === 5) {
          skillBallGrace = 1
          localBall.vx = fx * SKILL2.crouyff.exitSpeed + player.vx * 0.25
          localBall.vy = 0.25
          localBall.vz = fz * SKILL2.crouyff.exitSpeed + player.vz * 0.25
          localBall.lastTouch = myId
          prevLastTouch = myId
          myKickT = 0.8
          myDribbler.touchTimer = 0.5
          audio.playCut(localBall.x, localBall.z)
          if (mode === 'match' && !isHost()) {
            net?.sendKick({ id: myId, dx: fx, dz: fz, loftN: 0.06, power: 0.2, kind: 'kick', seq: mySeq++ })
          }
        }
      }
      skillBall = null
    }
    applySkillBall(dt)

    // juggle upkeep: rhythmic pin, bounce sounds, sprint drops the ball
    if (player.juggling) {
      if (phase !== 'play' || spectating) {
        stopJuggle(false)
      } else {
        const contact = juggleBounce(
          localBall,
          { x: player.x, z: player.z, yaw: cameraRig.yaw, vx: player.vx, vz: player.vz },
          player.jugglePhase,
          dt,
        )
        localBall.lastTouch = myId
        if (contact) audio.playTouch(localBall.x, localBall.z, Math.floor(player.jugglePhase) % 2 === 1)
        if (frame.sprint) stopJuggle(false)
      }
    }

    // restart housekeeping (host): timeouts + AI takes its restarts
    if (phase === 'restart' && restart && (solo() || isHost())) {
      if (mode === 'practice' && restart.takerId === AI_ID && nowSec() - restartStartedAt > 1.5) {
        aiTakeRestart()
      } else if (restart.takerId !== AI_ID && nowSec() - restartStartedAt > RULES.restartTimeout) {
        // troll-proof: auto-release after dawdling
        const t = restart.takerId !== null ? posOf(restart.takerId) : null
        const fromX = t ? t.x : restart.x
        const fromZ = t ? t.z : restart.z
        const l = Math.hypot(fromX, fromZ) || 1
        const v = restart.kind === 'throwin' ? throwVelocity(0.4, 0.3, -fromX / l, -fromZ / l) : kickVelocity(0.42, 0.22, -fromX / l, -fromZ / l)
        localBall.x = fromX
        localBall.z = fromZ
        localBall.y = restart.kind === 'throwin' ? 1.7 : BALL.r
        localBall.vx = v.vx
        localBall.vy = v.vy
        localBall.vz = v.vz
        localBall.lastTouch = restart.takerId
        prevLastTouch = restart.takerId
        hostResumePlay()
      }
    }

    // 15 Hz authoritative ball broadcast (the Zero Hour caster streams it while time stands)
    if (mode === 'match' && ((isHost() && !tsOther) || tsMine)) {
      ballTimer += dt
      if (ballTimer >= 1 / NET.ballHz) {
        ballTimer = 0
        sendBallNow()
      }
    }

    // player-player soft push (local, unsynced)
    for (const b of bodies) {
      if (b.id === myId) continue
      const dx = player.x - b.x
      const dz = player.z - b.z
      const d = Math.hypot(dx, dz)
      const minD = PLAYER.r * 2
      if (d < minD && d > 1e-4) {
        const push = (minD - d) * 0.5
        player.x += (dx / d) * push
        player.z += (dz / d) * push
      }
    }

    // solo extras: AI (practice only) + ball resets
    if (solo()) {
      if (mode === 'practice') stepAI(dt)
      if (frame.practiceReset) {
        const [fx, fz] = forwardXZ(cameraRig.yaw)
        setBall(player.x + fx * 0.6, player.z + fz * 0.6)
      }
      if (practiceResetAt !== null && nowSec() > practiceResetAt) {
        practiceResetAt = null
        const [fx, fz] = forwardXZ(cameraRig.yaw)
        setBall(player.x + fx * 0.6, player.z + fz * 0.6)
      }
      const inNet = Math.abs(localBall.x) > PITCH.halfL + 0.4
      if (inNet && practiceResetAt === null && Math.hypot(localBall.vx, localBall.vz) < 1.2 && phase === 'play') {
        practiceResetAt = nowSec() + 1.4
      }
    }

    // 20 Hz transform broadcast
    if (mode === 'match') {
      stateTimer += dt
      if (stateTimer >= 1 / NET.playerHz) {
        stateTimer = 0
        const anim = player.animState()
        net?.sendPlayerState({
          id: myId,
          x: player.x,
          z: player.z,
          yaw: cameraRig.yaw,
          spd: player.speed,
          spr: player.sprinting ? 1 : 0,
          kickT: anim.kickT,
          cutS: anim.cutS,
          flickT: anim.flickT,
          stepT: anim.stepT,
          slideT: anim.slideT,
          throwT: anim.throwT,
          act: anim.act,
          actT: anim.actT,
          actS: anim.actS,
          jugl: anim.jugl,
          st: player.status.st,
          stT: player.status.stT,
          seq: mySeq++,
          t: nowSec(),
        })
      }
    }

    // countdown ticks + host fallback
    if (countdownEndsAt !== null) {
      const remain = countdownEndsAt - nowSec()
      if (remain <= 0) {
        countdownEndsAt = null
        if (isHost() && mode === 'match' && phase === 'countdown') {
          const play: MatchEventMsg = { type: 'play' }
          net?.sendEvent(play)
          applyEvent(play)
        }
      } else {
        const tick = Math.ceil(remain)
        if (tick !== lastCountdownTick) {
          lastCountdownTick = tick
          audio.playTick(tick <= 1)
        }
      }
    }

    // host timers
    if (isHost() && mode === 'match') {
      const t = nowSec()
      for (let i = hostTimers.length - 1; i >= 0; i--) {
        if (hostTimers[i].at <= t) {
          const fn = hostTimers[i].fn
          hostTimers.splice(i, 1)
          fn()
        }
      }
    }

    if (banner && banner.until < nowSec()) {
      banner = null
      pushUi()
    }
  }

  /** LMB release — a kick, a restart take, or a throw-in fling. */
  function handleKickRelease(frame: InputFrame): void {
    const iAmTaker = phase === 'restart' && restart !== null && restart.takerId === myId
    if (!((phase === 'play' || iAmTaker) && !spectating && !paused)) return
    if (player.disabled) return
    const isThrow = iAmTaker && restart?.kind === 'throwin'
    const power = clamp(frame.kickReleasePower / KICK.chargeTime, KICK.minPower, 1)
    const [fx, fz] = forwardXZ(cameraRig.yaw)
    const loftN = loftFromPitch()

    if (isThrow) {
      player.throwAnimT = 0.5
      cameraRig.kickDip(0.5 + power * 0.4)
      const v = throwVelocity(power, loftN, fx, fz)
      localBall.vx = v.vx
      localBall.vy = v.vy
      localBall.vz = v.vz
      localBall.lastTouch = myId
      prevLastTouch = myId
      myKickT = 0.4
      audio.playKick(player.x, player.z, power * 0.7)
      if (mode === 'match') net?.sendKick({ id: myId, dx: fx, dz: fz, loftN, power, kind: 'throw', seq: mySeq++ })
      if (mode === 'practice' || isHost()) hostResumePlay()
      return
    }

    const d = Math.hypot(localBall.x - player.x, localBall.z - player.z)
    const inRange = d < PLAYER.kickRange && localBall.y < 1.25
    // VOLLEY: any kick with the ball above knee-ish height becomes a scissor
    // volley — while juggling this is the natural strike from the bounce
    const volley = inRange && localBall.y > SKILL2.volley.height
    if (player.juggling) stopJuggle(true)
    if (volley) {
      player.startVolley(cameraRig.yaw)
      cameraRig.volleyRecoil(0.9 + power * 0.5)
    } else {
      player.kickAnimT = KICK.followThrough
      cameraRig.kickDip(0.8 + power * 0.6)
    }
    if (!inRange) {
      audio.playWhiff()
      return
    }
    const v = kickVelocity(power, loftN, fx, fz)
    localBall.vx = v.vx
    localBall.vy = v.vy
    localBall.vz = v.vz
    localBall.lastTouch = myId
    prevLastTouch = myId
    myKickT = 1.0
    myDribbler.touchTimer = 0.5
    if (tsBall) tsBall.driftAt = simT
    gainEgo(power > 0.7 ? SUPER.egoBigShot : SUPER.egoShot)
    audio.playKick(player.x, player.z, power)
    particles.grassBurst(localBall.x, localBall.z, 12, fx, fz, 0.9 + power * 0.6)
    if (mode === 'match') {
      net?.sendKick({ id: myId, dx: fx, dz: fz, loftN, power, kind: 'kick', seq: mySeq++ })
    }
    if (iAmTaker && (mode === 'practice' || isHost())) hostResumePlay()
  }

  // ------------------------------------------------------------------ flair skills

  /** Cooldown / busy failure — silent except for a single first-time toast. */
  function skillFailFeedback(): void {
    if (skillCooldownToasted) return
    skillCooldownToasted = true
    toast('Skill still warming up — watch the cooldown pips')
  }

  /** Ball out of reach — single first-time hint, never spam. */
  function skillRangeFeedback(): void {
    if (skillRangeToasted) return
    skillRangeToasted = true
    toast('The ball needs to be at your feet for that')
  }

  /** Stop juggling. `kicked` skips the soft drop (a strike is taking the ball). */
  function stopJuggle(kicked: boolean): void {
    if (!player.juggling) return
    player.juggling = false
    if (!kicked && phase === 'play') juggleDrop(localBall)
  }

  /** True while a flair action kinematically owns the ball (dribble/corrections off). */
  function ballPinnedByAction(): boolean {
    const act = player.action
    if (!act || !skillBall || !skillBall.owned) return false
    if (act.kind === 1) return act.t > act.total - SKILL2.rainbow.riseTime
    if (act.kind === 3) return true
    if (act.kind === 4) return act.t > act.total - SKILL2.elastico.outTime
    if (act.kind === 5) return act.t < act.total - SKILL2.crouyff.windup
    return false
  }

  /** Z rabona — releases the held charge as a cross-legged strike. */
  function performRabona(power: number): void {
    const [fx, fz] = forwardXZ(cameraRig.yaw)
    const loftN = clamp(loftFromPitch() + SKILL2.rabona.loftAdd, 0, 1)
    const boosted = Math.min(1, power * SKILL2.rabona.powerMult)
    const d = Math.hypot(localBall.x - player.x, localBall.z - player.z)
    const inRange = d < PLAYER.kickRange && localBall.y < 1.25
    if (player.juggling) stopJuggle(true)
    player.tryRabona(cameraRig.yaw) // committed — the flair cooldown burns even on a whiff
    cameraRig.rabonaHop()
    if (!inRange) {
      audio.playWhiff()
      return
    }
    const v = kickVelocity(boosted, loftN, fx, fz)
    localBall.vx = v.vx
    localBall.vy = v.vy
    localBall.vz = v.vz
    localBall.lastTouch = myId
    prevLastTouch = myId
    myKickT = 1.0
    myDribbler.touchTimer = 0.5
    audio.playKick(player.x, player.z, boosted)
    particles.grassBurst(localBall.x, localBall.z, 10, fx, fz, 0.8 + boosted * 0.5)
    if (mode === 'match') {
      net?.sendKick({ id: myId, dx: fx, dz: fz, loftN, power: boosted, kind: 'kick', seq: mySeq++ })
    }
  }

  /**
   * Per-frame ball work for the active flair action (runs AFTER physics so the
   * pins win, exactly like the throw-in hold). Local-authority: the kick msg
   * informs the host the same way the F flick does.
   */
  function applySkillBall(dt: number): void {
    const act = player.action
    if (!act || !skillBall || !skillBall.owned) return
    const u = clamp(1 - act.t / act.total, 0, 1)
    const me = { x: player.x, z: player.z, yaw: cameraRig.yaw, vx: player.vx, vz: player.vz }

    if (act.kind === 1) {
      // RAINBOW — roll-up pin, then the heel flick launch
      const rollU = SKILL2.rainbow.riseTime / act.total
      if (u < rollU) {
        rainbowRoll(localBall, me, skillBall.startX, skillBall.startZ, u / rollU)
      } else if (!skillBall.flicked) {
        skillBall.flicked = true
        skillBallGrace = 1
        const [fx, fz] = forwardXZ(cameraRig.yaw)
        rainbowFlick(localBall, me, fx, fz)
        localBall.lastTouch = myId
        prevLastTouch = myId
        myKickT = 1.0
        myDribbler.touchTimer = 0.5
        audio.playFlick(localBall.x, localBall.z)
        particles.grassBurst(localBall.x, localBall.z, 6, fx, fz, 0.6)
        if (mode === 'match' && !isHost()) {
          net?.sendKick({ id: myId, dx: fx, dz: fz, loftN: 0.95, power: 0.22, kind: 'kick', seq: mySeq++ })
        }
      }
    } else if (act.kind === 3) {
      // ROULETTE — ball pinned under the sole, orbiting with the body
      soleDrag(localBall, me, skillBall.fwd0X, skillBall.fwd0Z, skillBall.right0X, skillBall.right0Z)
      localBall.lastTouch = myId
    } else if (act.kind === 4) {
      // ELASTICO — push out to the side, then the hard snap across
      const outU = SKILL2.elastico.outTime / act.total
      if (u < outU) {
        elasticoPush(localBall, me, act.s, skillBall.startX, skillBall.startZ, u / outU)
      } else if (!skillBall.snapped) {
        skillBall.snapped = true
        skillBallGrace = 1
        const [fx, fz] = forwardXZ(cameraRig.yaw)
        elasticoSnap(localBall, me, act.s, fx, fz)
        localBall.lastTouch = myId
        prevLastTouch = myId
        myKickT = 0.8
        myDribbler.touchTimer = 0.5
        audio.playCut(localBall.x, localBall.z)
        particles.grassBurst(localBall.x, localBall.z, 6, -rightXZ(cameraRig.yaw)[0] * act.s, -rightXZ(cameraRig.yaw)[1] * act.s, 0.7)
        if (mode === 'match' && !isHost()) {
          const [rx, rz] = rightXZ(cameraRig.yaw)
          const dx = fx * SKILL2.elastico.crossFwd - rx * act.s * SKILL2.elastico.crossSpeed
          const dz = fz * SKILL2.elastico.crossFwd - rz * act.s * SKILL2.elastico.crossSpeed
          const l = Math.hypot(dx, dz) || 1
          net?.sendKick({ id: myId, dx: dx / l, dz: dz / l, loftN: 0.05, power: 0.25, kind: 'kick', seq: mySeq++ })
        }
      }
    } else if (act.kind === 5) {
      // CRUYFF — after the fake-shot windup the sole drags the ball around
      const windU = SKILL2.crouyff.windup / act.total
      if (u > windU) {
        soleDrag(localBall, me, skillBall.fwd0X, skillBall.fwd0Z, skillBall.right0X, skillBall.right0Z, 0.92)
        localBall.lastTouch = myId
      }
    }
    void dt
  }

  /** Skill dispatch — phase 'play' only, never during restarts/countdowns. */
  function dispatchSkills(frame: InputFrame): void {
    const ballD = Math.hypot(localBall.x - player.x, localBall.z - player.z)
    const blocked = player.action !== null || player.busy || player.sliding
    const capture = (owned: boolean): SkillBallCapture => {
      const [fx, fz] = forwardXZ(cameraRig.yaw)
      const [rx, rz] = rightXZ(cameraRig.yaw)
      return { owned, startX: localBall.x, startZ: localBall.z, fwd0X: fx, fwd0Z: fz, right0X: rx, right0Z: rz, flicked: false, snapped: false }
    }

    if (frame.rabonaPressed) {
      if (chargeCache.held) {
        if (player.rabonaCooldown <= 0 && !blocked) {
          const held = input.cancelCharge()
          performRabona(clamp(held / KICK.chargeTime, KICK.minPower, 1))
        } else if (player.rabonaCooldown > 0) {
          skillFailFeedback()
        }
      } else {
        toast('Hold LMB to charge, then tap Z for a rabona')
      }
      return
    }

    if (frame.rainbowPressed) {
      if (player.rainbowCooldown > 0 || blocked) {
        skillFailFeedback()
      } else if (ballD < SKILL2.rainbow.range && localBall.y < 1.15) {
        stopJuggle(false)
        player.tryRainbow(cameraRig.yaw)
        skillBall = capture(true)
        audio.playTouch(localBall.x, localBall.z, false)
        cameraRig.landDip(0.4)
      } else {
        skillRangeFeedback()
      }
      return
    }

    if (frame.roulettePressed) {
      if (player.rouletteCooldown > 0 || blocked) {
        skillFailFeedback()
      } else {
        const dir = frame.moveX < -0.15 ? 1 : -1 // default spins right (clockwise)
        const owned = ballD < SKILL2.roulette.range && localBall.y < 0.6
        stopJuggle(false)
        player.tryRoulette(cameraRig.yaw, dir)
        skillBall = capture(owned)
        audio.playCut(player.x, player.z)
        particles.grassBurst(player.x, player.z, 6, 0, 0, 0.6)
      }
      return
    }

    if (frame.elasticoPressed) {
      if (player.elasticoCooldown > 0 || blocked) {
        skillFailFeedback()
      } else {
        const side = frame.moveX < -0.15 ? -1 : 1 // default pushes out right
        const owned = ballD < SKILL2.elastico.range && localBall.y < 0.6
        stopJuggle(false)
        player.tryElastico(cameraRig.yaw, side)
        skillBall = capture(owned)
      }
      return
    }

    if (frame.crouyffPressed) {
      if (player.crouyffCooldown > 0 || blocked) {
        skillFailFeedback()
      } else {
        const turnSide = frame.moveX >= 0.15 ? -1 : frame.moveX <= -0.15 ? 1 : -1 // default turns right
        const owned = ballD < SKILL2.crouyff.range && localBall.y < 0.6
        stopJuggle(false)
        player.tryCrouyff(cameraRig.yaw, turnSide)
        skillBall = capture(owned)
      }
      return
    }

    if (frame.backheelPressed) {
      if (player.backheelCooldown > 0 || blocked) {
        skillFailFeedback()
      } else if (ballD < SKILL2.backheel.range && localBall.y < 0.75) {
        stopJuggle(false)
        player.tryBackheel(cameraRig.yaw)
        const [fx, fz] = forwardXZ(cameraRig.yaw)
        skillBallGrace = 1
        backheelClip(localBall, { x: player.x, z: player.z, yaw: cameraRig.yaw, vx: player.vx, vz: player.vz }, fx, fz)
        localBall.lastTouch = myId
        prevLastTouch = myId
        myKickT = 0.85
        myDribbler.touchTimer = 0.5
        audio.playFlick(localBall.x, localBall.z)
        cameraRig.backheelJolt()
        particles.grassBurst(localBall.x, localBall.z, 5, -fx, -fz, 0.7)
        if (mode === 'match' && !isHost()) {
          net?.sendKick({ id: myId, dx: -fx, dz: -fz, loftN: 0.06, power: 0.3, kind: 'kick', seq: mySeq++ })
        }
      } else {
        skillRangeFeedback()
      }
      return
    }

    if (frame.jugglePressed) {
      if (player.juggling) {
        stopJuggle(false)
      } else if (!blocked) {
        const slow = Math.hypot(localBall.vx, localBall.vz) < SKILL2.juggle.maxBallSpeed && Math.abs(localBall.vy) < 3.2
        if (ballD < SKILL2.juggle.range && localBall.y < 0.6 && slow) {
          player.juggling = true
          player.jugglePhase = 0
          audio.playTouch(localBall.x, localBall.z, false)
        } else if (!juggleHintToasted) {
          juggleHintToasted = true
          toast('Bring the ball close and slow, then tap T to juggle')
        }
      }
    }
  }

  // ------------------------------------------------------------------ EGO supers
  //
  // Every super is ONE broadcast event from the caster; each client plays the
  // whole move and decides for itself whether it was caught (sealed, pulled,
  // bowled over, frozen). The ball stays host-authoritative except for two
  // scripted windows: the Crimson Dragon's flight (a deterministic curve every
  // client follows) and Zero Hour (the caster owns the ball while time stands).

  function superCost(kind: SuperKind): number {
    if (mode === 'free') return 0
    switch (kind) {
      case 1:
        return SUPER.dragon.cost
      case 2:
        return SUPER.mountain.cost
      case 3:
        return SUPER.eagle.cost
      case 4:
        return SUPER.thunder.cost
      case 5:
        return SUPER.timeStop.cost
      case 6:
        return SUPER.cyclone.cost
    }
  }

  function gainEgo(n: number): void {
    if (mode === 'free' || spectating || n <= 0) return
    const before = ego
    ego = Math.min(SUPER.egoMax, ego + n)
    if (before < SUPER.egoMax && ego >= SUPER.egoMax) {
      audio.playUI('goal-banner')
      manga.sfxScreen('エゴ全開', 0.5, 0.8, elapsed, { size: 0.55, color: PALETTE.saffron, dur: 1.5 })
    }
  }

  function superFeedback(msg: string): void {
    if (elapsed - lastSuperToast < 2.2) return
    lastSuperToast = elapsed
    toast(msg)
  }

  /** Solo modes only: a beat of slow motion on the big hits. */
  function slowMo(scale: number, realSecs: number): void {
    if (!solo()) return
    slowMoScale = scale
    slowMoUntil = elapsed + realSecs
  }

  function inkFrame(secs: number): void {
    inkUntil = Math.max(inkUntil, elapsed + secs)
  }

  function washWith(color: string, amount: number): void {
    washColor.set(color)
    washAmt = Math.max(washAmt, amount)
  }

  /** Knock MY player flat (dragon / eagle landing / erupting rock). */
  function knockMe(dirX: number, dirZ: number, power = 1): void {
    if (player.knockT > 0.2) return
    const l = Math.hypot(dirX, dirZ) || 1
    stopJuggle(false)
    player.knockDown(dirX / l, dirZ / l, power)
    const [rx, rz] = rightXZ(cameraRig.yaw)
    cameraRig.setKnocked(true, (dirX * rx + dirZ * rz) >= 0 ? 1 : -1)
    cameraRig.shake(0.7, 0.6)
    audio.playBounce(player.x, player.z, 0.9)
    particles.dustPuff(player.x, player.z, 1.2)
  }

  function knockAi(dirX: number, dirZ: number, power = 1): void {
    if (mode !== 'practice' || ai.knockT > 0.2) return
    const l = Math.hypot(dirX, dirZ) || 1
    ai.knockT = SUPER.knockTime
    ai.vx = (dirX / l) * 6.5 * power
    ai.vz = (dirZ / l) * 6.5 * power
    audio.playBounce(ai.x, ai.z, 0.8)
    particles.dustPuff(ai.x, ai.z, 1.2)
  }

  function trySuper(kind: SuperKind): void {
    if (phase !== 'play' || spectating) return
    if (timeStop && timeStop.by !== myId) return
    if (superLock > 0) {
      superFeedback('EGO still settling…')
      return
    }
    const cost = superCost(kind)
    if (ego < cost) {
      superFeedback(`${SUPER_STYLE[kind].name} needs ${cost} EGO — you have ${Math.floor(ego)}`)
      return
    }
    const ballD = Math.hypot(localBall.x - player.x, localBall.z - player.z)
    const eyeY = cameraRig.camera.position.y
    const m = kind === 6 ? SUPER.cyclone : SUPER.mountain
    const aim = aimGroundPoint(player.x, player.z, eyeY, cameraRig.yaw, cameraRig.visualPitch, m.minDist, m.maxDist, m.fallbackDist)
    const seed = Math.floor(Math.random() * 1e9)
    const msg: SuperEventMsg = {
      type: 'super',
      kind,
      from: myId,
      team: myTeam(),
      name: myName,
      x: player.x,
      z: player.z,
      yaw: cameraRig.yaw,
      ax: aim.x,
      az: aim.z,
      seed,
    }
    if (kind === 1) {
      if (dragon && !dragon.done) return
      if (ballD > SUPER.dragon.range || localBall.y > 1.3) {
        superFeedback('Crimson Dragon needs the ball at your feet')
        return
      }
      // the ball coils up in front of you, at chest height
      const [fx, fz] = forwardXZ(cameraRig.yaw)
      const { path, flight } = dragonPath(player.x + fx * 3.2, 1.25, player.z + fz * 3.2, myTeam(), seed)
      msg.path = path.map((v) => Math.round(v * 1000) / 1000)
      msg.flight = Math.round(flight * 1000) / 1000
    } else if (kind === 3) {
      if (dragon && !dragon.done) {
        superFeedback('Nothing catches the dragon')
        return
      }
      if (ballD > SUPER.eagle.maxDist) {
        superFeedback('The ball is too far even for the eagle')
        return
      }
    } else if (kind === 5) {
      if (timeStop) return
      msg.dur = solo() ? SUPER.timeStop.soloDur : SUPER.timeStop.matchDur
    }
    ego -= cost
    superLock = SUPER.lockout
    if (mode === 'match') net?.sendEvent(msg)
    applySuper(msg)
  }

  /** A super goes off (mine or anyone's). */
  function applySuper(msg: SuperEventMsg): void {
    if (screen !== 'game') return
    const mine = msg.from === myId
    const rival = msg.team !== myTeam()
    manga.cutIn(msg.kind, msg.name, mine, rival, elapsed)
    audio.playCutIn(mine)
    if (mine) {
      cameraRig.fovPunch(-5)
      cameraRig.shake(0.22, 0.35)
    }
    switch (msg.kind) {
      case 1:
        startDragon(msg, mine)
        break
      case 2:
        raiseMountain(msg)
        break
      case 3:
        // everyone else sees the eagle over the caster through their glide status
        if (mine) startGlide()
        break
      case 4:
        castThunder(msg)
        break
      case 5:
        startTimeStop(msg, mine)
        break
      case 6:
        spawnCyclone(msg)
        break
    }
    pushUi()
  }

  // ---- 1 · Crimson Dragon

  function startDragon(msg: SuperEventMsg, mine: boolean): void {
    if (!msg.path || !msg.flight) return
    if (dragon && !dragon.done) superFx.endDragon(dragon.key, simT)
    const key = superSeq++
    dragon = {
      key,
      from: msg.from,
      team: msg.team,
      path: msg.path,
      flight: msg.flight,
      castAt: simT,
      strikeAt: simT + SUPER.dragon.windup,
      bx: localBall.x,
      by: localBall.y,
      bz: localBall.z,
      struck: false,
      done: false,
      hit: new Set<string>(),
    }
    superFx.spawnDragon(key, msg.path, msg.flight, simT, dragon.strikeAt)
    audio.playWhoosh(msg.path[0], msg.path[2], 1.2)
    washWith('#e8532f', 0.18)
    if (mine) {
      stopJuggle(false)
      player.action = null
      player.dragonT = SUPER.dragon.windup
    }
  }

  /** Scripted dragon ball: coil during the wind-up, then the homing curve. */
  function stepDragon(): void {
    const d = dragon
    if (!d || d.done) return
    if (phase !== 'play') {
      endDragonFlight(false)
      return
    }
    if (simT < d.strikeAt) {
      const k = clamp((simT - d.castAt) / SUPER.dragon.windup, 0, 1)
      const e = k * k * (3 - 2 * k)
      localBall.x = d.bx + (d.path[0] - d.bx) * e
      localBall.y = d.by + (d.path[1] - d.by) * e + Math.sin(k * Math.PI) * 0.25
      localBall.z = d.bz + (d.path[2] - d.bz) * e
      localBall.vx = 0
      localBall.vy = 0
      localBall.vz = 0
      localBall.lastTouch = d.from
      return
    }
    if (!d.struck) {
      d.struck = true
      const mineStrike = d.from === myId
      audio.playRoar(localBall.x, localBall.z)
      audio.playKick(localBall.x, localBall.z, 1)
      if (mineStrike) {
        player.kickAnimT = KICK.followThrough
        cameraRig.kickDip(1.6)
        cameraRig.fovPunch(9)
      }
      cameraRig.shake(mineStrike ? 1.1 : 0.5, 0.7)
      inkFrame(0.07)
      washWith('#e8532f', 0.4)
      manga.sfxAt('ドォン!!', localBall.x, localBall.y + 0.7, localBall.z, elapsed, { size: 1.1, color: '#e8532f' })
      manga.pulseFocus(1, '#a52d1e')
      slowMo(0.22, 0.32)
    }
    const u = clamp((simT - d.strikeAt) / d.flight, 0, 1)
    const pu = dragonEase(u)
    bezierAt(d.path, pu, superTmpP)
    bezierTangent(d.path, pu, superTmpT)
    const slope = (dragonEase(Math.min(1, u + 0.01)) - pu) / 0.01
    localBall.x = superTmpP.x
    localBall.y = superTmpP.y
    localBall.z = superTmpP.z
    localBall.vx = (superTmpT.x * slope) / d.flight
    localBall.vy = (superTmpT.y * slope) / d.flight
    localBall.vz = (superTmpT.z * slope) / d.flight
    localBall.lastTouch = d.from
    // bowl over anyone in the way — each client for itself, the solo host for its AI
    const tl = Math.hypot(superTmpT.x, superTmpT.z) || 1
    if (d.team !== myTeam() && !d.hit.has(myId) && localBall.y < 2.6) {
      const dx = player.x - localBall.x
      const dz = player.z - localBall.z
      if (Math.hypot(dx, dz) < SUPER.dragon.knockRadius) {
        d.hit.add(myId)
        const side = dx * -superTmpT.z + dz * superTmpT.x >= 0 ? 1 : -1
        knockMe((-superTmpT.z / tl) * side + (superTmpT.x / tl) * 0.6, (superTmpT.x / tl) * side + (superTmpT.z / tl) * 0.6, 1.2)
      }
    }
    if (mode === 'practice' && d.team === 'A' && !d.hit.has(AI_ID) && localBall.y < 2.6) {
      const dx = ai.x - localBall.x
      const dz = ai.z - localBall.z
      if (Math.hypot(dx, dz) < SUPER.dragon.knockRadius + 0.3) {
        d.hit.add(AI_ID)
        const side = dx * -superTmpT.z + dz * superTmpT.x >= 0 ? 1 : -1
        knockAi((-superTmpT.z / tl) * side + (superTmpT.x / tl) * 0.6, (superTmpT.x / tl) * side + (superTmpT.z / tl) * 0.6, 1.2)
        manga.sfxAt('バキッ', ai.x, 1.8, ai.z, elapsed, { size: 0.8 })
      }
    }
    if (u >= 1) endDragonFlight(true)
  }

  function endDragonFlight(scored: boolean): void {
    const d = dragon
    if (!d || d.done) return
    d.done = true
    superFx.endDragon(d.key, simT)
    if (!scored) return
    // release deep in the net, still driving goalward (the net swallows it)
    bezierTangent(d.path, 1, superTmpT)
    const l = Math.hypot(superTmpT.x, superTmpT.y, superTmpT.z) || 1
    localBall.vx = (superTmpT.x / l) * 7
    localBall.vy = 0
    localBall.vz = (superTmpT.z / l) * 7
    const goalX = Math.sign(d.path[9]) * PITCH.halfL
    audio.playBoom(localBall.x, localBall.z)
    cameraRig.shake(d.from === myId ? 1.3 : 0.8, 1.0)
    world.wobbleNet(goalX, 1.6)
    particles.petalBurst(localBall.x, 1.1, localBall.z, 42)
    particles.dustPuff(localBall.x, localBall.z, 1.5)
    manga.sfxAt('ドン!!', localBall.x, 2.0, localBall.z, elapsed, { size: 1.35 })
    inkFrame(0.08)
    washWith('#e8532f', 0.35)
  }

  // ---- 2 · Mountain Bastion

  function raiseMountain(msg: SuperEventMsg): void {
    const { peaks, nx, nz } = mountainPeaks(msg.ax, msg.az, msg.x, msg.z, msg.seed)
    walls.push({ id: superSeq++, peaks, cx: msg.ax, cz: msg.az, nx, nz, age: 0, seed: msg.seed })
    while (walls.length > 4) walls.shift()
    audio.playRumble(msg.ax, msg.az)
    const d = Math.hypot(msg.ax - player.x, msg.az - player.z)
    cameraRig.shake(clamp(1.15 - d / 30, 0.25, 0.95), 1.0)
    manga.sfxAt('ゴゴゴ', msg.ax, 3.6, msg.az, elapsed, { size: 1, color: '#dcb27a', dur: 1.5 })
    washWith('#c98a3a', 0.15)
    for (const p of peaks) {
      particles.dustPuff(p.x, p.z, 1)
      particles.grassBurst(p.x, p.z, 10, 0, 0, 1.5)
    }
  }

  // ---- 3 · Eagle Talon

  function startGlide(): void {
    const d = Math.hypot(localBall.x - player.x, localBall.z - player.z)
    stopJuggle(false)
    player.action = null
    glide = { sx: player.x, sz: player.z, t: 0, total: eagleDuration(d), release: 0, landed: false }
    player.gliding = true
    audio.playScreech()
    audio.playWhoosh(player.x, player.z, 1.3)
    cameraRig.fovPunch(10)
    washWith('#2fa8a0', 0.15)
  }

  function stepGlide(dt: number): void {
    const g = glide
    if (!g) return
    if (!g.landed) {
      if (phase !== 'play') {
        player.gliding = false
        cameraRig.setLift(0)
        glide = null
        return
      }
      g.t += dt
      const u = clamp(g.t / g.total, 0, 1)
      const tx = localBall.x
      const tz = localBall.z
      const dx = tx - g.sx
      const dz = tz - g.sz
      const l = Math.hypot(dx, dz) || 1
      // talons first: arrive just behind the ball, facing it
      const ex = tx - (dx / l) * 0.6
      const ez = tz - (dz / l) * 0.6
      const e = u * u * (3 - 2 * u)
      player.x = g.sx + (ex - g.sx) * e
      player.z = g.sz + (ez - g.sz) * e
      player.vx = 0
      player.vz = 0
      cameraRig.setLift(eagleLift(u))
      if (Math.hypot(tx - player.x, tz - player.z) > 0.8) {
        cameraRig.yaw = dampAngle(cameraRig.yaw, yawFromDir(tx - player.x, tz - player.z), 7, dt)
      }
      if (u >= 1) landGlide()
    } else {
      g.release += dt
      if (g.release > 0.8) glide = null
    }
  }

  function landGlide(): void {
    const g = glide
    if (!g) return
    g.landed = true
    player.gliding = false
    cameraRig.setLift(0)
    const [fx, fz] = forwardXZ(cameraRig.yaw)
    const bx = player.x + fx * 0.55
    const bz = player.z + fz * 0.55
    // the talons take the ball
    if (!(dragon && !dragon.done)) {
      localBall.x = bx
      localBall.z = bz
      localBall.y = BALL.r
      localBall.vx = 0
      localBall.vy = 0
      localBall.vz = 0
      localBall.lastTouch = myId
      prevLastTouch = myId
      myKickT = 0.6
      myDribbler.touchTimer = 0.25
    }
    audio.playKick(player.x, player.z, 0.9)
    cameraRig.kickDip(1.2)
    cameraRig.shake(0.55, 0.5)
    particles.dustPuff(player.x, player.z, 1.4)
    particles.grassBurst(player.x, player.z, 14, fx, fz, 1.2)
    manga.sfxAt('ガッ!!', bx, 1.3, bz, elapsed, { size: 0.9, color: '#2fa8a0' })
    inkFrame(0.06)
    slowMo(0.35, 0.18)
    const claim: MatchEventMsg = { type: 'superClaim', from: myId, team: myTeam(), x: player.x, z: player.z, bx, bz }
    if (mode === 'match') net?.sendEvent(claim)
    applyClaim(claim)
  }

  /** Eagle landing: the host hands over the ball; opponents at the landing fall. */
  function applyClaim(msg: Extract<MatchEventMsg, { type: 'superClaim' }>): void {
    const mine = msg.from === myId
    if (!mine) {
      if (mode === 'match' && isHost() && phase === 'play' && !(dragon && !dragon.done)) {
        localBall.x = msg.bx
        localBall.z = msg.bz
        localBall.y = BALL.r
        localBall.vx = 0
        localBall.vy = 0
        localBall.vz = 0
        localBall.lastTouch = msg.from
        prevLastTouch = msg.from
      }
      particles.dustPuff(msg.x, msg.z, 1.3)
      audio.playKick(msg.x, msg.z, 0.8)
      manga.sfxAt('ガッ!!', msg.bx, 1.3, msg.bz, elapsed, { size: 0.8, color: '#2fa8a0' })
    }
    if (msg.team !== myTeam() && !mine) {
      const dx = player.x - msg.x
      const dz = player.z - msg.z
      if (Math.hypot(dx, dz) < SUPER.eagle.knockRadius) knockMe(dx, dz, 1)
    }
    if (mode === 'practice' && msg.team === 'A') {
      const dx = ai.x - msg.x
      const dz = ai.z - msg.z
      if (Math.hypot(dx, dz) < SUPER.eagle.knockRadius) knockAi(dx, dz, 1)
    }
  }

  // ---- 4 · Thunder Seal

  function castThunder(msg: SuperEventMsg): void {
    stormUntil = elapsed + SUPER.thunder.storm
    const at = simT + SUPER.thunder.windup
    const castKey = superSeq++
    let i = 0
    for (const p of rulesPlayers()) {
      if (p.team === msg.team) continue
      if (Math.hypot(p.x - msg.x, p.z - msg.z) > SUPER.thunder.range) continue
      pendingBolts.push({ at: at + i * 0.09, id: p.id, x: p.x, z: p.z, seed: msg.seed + i * 131, cast: castKey })
      i++
    }
    // nobody in range (or free play): the storm still answers where you aimed
    const extra = i === 0 ? 3 : 1
    const r = makeRng(msg.seed)
    for (let k = 0; k < extra; k++) {
      pendingBolts.push({
        at: at + (i + k) * 0.09,
        id: null,
        x: msg.ax + (k === 0 ? 0 : (r() - 0.5) * 7),
        z: msg.az + (k === 0 ? 0 : (r() - 0.5) * 7),
        seed: msg.seed + 977 * (k + 1),
        cast: castKey,
      })
    }
    audio.playWhoosh(msg.x, msg.z, 0.8)
  }

  function stepBolts(): void {
    for (let i = pendingBolts.length - 1; i >= 0; i--) {
      const b = pendingBolts[i]
      if (b.at > simT) continue
      pendingBolts.splice(i, 1)
      const pos = b.id ? posOf(b.id) : { x: b.x, z: b.z }
      if (!pos) continue
      superFx.bolt(pos.x, pos.z, b.seed, simT, cameraRig.camera)
      audio.playThunder(pos.x, pos.z)
      particles.dustPuff(pos.x, pos.z, 1.3)
      particles.grassBurst(pos.x, pos.z, 12, 0, 0, 1.4)
      const d = Math.hypot(pos.x - player.x, pos.z - player.z)
      cameraRig.shake(clamp(1.2 - d / 20, 0.2, 1), 0.6)
      if (b.cast !== lastInkCast) {
        lastInkCast = b.cast
        inkFrame(0.06)
      }
      manga.sfxAt('バリッ', pos.x, 2.6, pos.z, elapsed, { size: 0.9, color: '#f6d46a' })
      if (b.id === myId) {
        stopJuggle(false)
        player.action = null
        player.sealT = SUPER.thunder.seal
      } else if (b.id === AI_ID) {
        ai.sealT = SUPER.thunder.seal
        ai.vx = 0
        ai.vz = 0
      }
    }
  }

  // ---- 5 · Zero Hour

  function startTimeStop(msg: SuperEventMsg, mine: boolean): void {
    const dur = msg.dur ?? SUPER.timeStop.matchDur
    timeStop = { by: msg.from, until: simT + dur, mine, lastTick: 99 }
    manga.startClock(elapsed, dur, mine, msg.name)
    audio.playTimeStop(true)
    cameraRig.shake(0.3, 0.4)
    inkFrame(0.07)
    if (mine) {
      player.zapT = dur
      tsBall = { frozen: Math.hypot(localBall.x - player.x, localBall.z - player.z) > 2.5, held: null, driftAt: -1 }
    } else {
      stopJuggle(false)
      player.action = null
      player.stopT = dur
    }
    if (mode === 'practice') {
      ai.stopT = dur
      ai.vx = 0
      ai.vz = 0
    }
  }

  function stepTimeStop(): void {
    const ts = timeStop
    if (!ts) return
    const remain = ts.until - simT
    const tick = Math.ceil(remain)
    if (tick !== ts.lastTick) {
      ts.lastTick = tick
      audio.playTick(tick <= 1)
    }
    if (remain <= 0 || phase !== 'play') endTimeStop()
  }

  function endTimeStop(): void {
    const ts = timeStop
    if (!ts) return
    timeStop = null
    tsGraceUntil = simT + 0.6
    tsGraceFrom = ts.by
    manga.endClock(elapsed)
    audio.playTimeStop(false)
    cameraRig.shake(0.35, 0.4)
    inkFrame(0.05)
    player.stopT = 0
    player.zapT = 0
    ai.stopT = 0
    if (ts.mine && tsBall) {
      const held = tsBall.held
      tsBall = null
      if (held) {
        // everything you did while time stood still lands at once
        localBall.vx = held.vx
        localBall.vy = held.vy
        localBall.vz = held.vz
        manga.sfxAt('ドン!', localBall.x, localBall.y + 0.6, localBall.z, elapsed, { size: 0.9 })
      }
      if (mode === 'match' && !isHost()) sendBallNow()
    }
  }

  // ---- 6 · Gulmohar Cyclone

  function spawnCyclone(msg: SuperEventMsg): void {
    cyclones.push({ id: superSeq++, x: msg.ax, z: msg.az, age: 0, team: msg.team, from: msg.from, seed: msg.seed })
    while (cyclones.length > 3) cyclones.shift()
    audio.playWind(msg.ax, msg.az, SUPER.cyclone.life)
    manga.sfxAt('ゴオオッ', msg.ax, 4.2, msg.az, elapsed, { size: 1, color: '#f28a2e', dur: 1.5 })
    washWith('#e8532f', 0.14)
    particles.petalBurst(msg.ax, 0.6, msg.az, 24)
  }

  /** Cyclone pull on me (and the practice AI) — runs BEFORE the player steps. */
  function stepCyclones(dt: number): void {
    let grip = 0
    ai.grip = 0
    for (let i = cyclones.length - 1; i >= 0; i--) {
      const c = cyclones[i]
      if (!timeStop) c.age += dt
      if (c.age > SUPER.cyclone.life) {
        cyclones.splice(i, 1)
        continue
      }
      if (c.team !== myTeam() && c.from !== myId && !player.gliding) {
        const v = cycloneVelocity(player.x, player.z, c)
        if (v.k > 0) {
          player.push(v.vx, v.vz)
          grip = Math.max(grip, v.k)
        }
      }
      if (mode === 'practice' && c.team === 'A') {
        const v = cycloneVelocity(ai.x, ai.z, c)
        if (v.k > 0) {
          ai.x += v.vx * dt
          ai.z += v.vz * dt
          ai.grip = Math.max(ai.grip, v.k)
        }
      }
      if (Math.random() < dt * 6) particles.dustPuff(c.x + (Math.random() - 0.5) * 2, c.z + (Math.random() - 0.5) * 2, 0.8)
    }
    player.cycloneGrip = grip
    if (grip > 0.3) cameraRig.yaw += dt * 2.4 * grip
  }

  /** Walls age, bodies are kept out of the rock (and launched if caught in a heave). */
  function stepWalls(dt: number): void {
    for (let i = walls.length - 1; i >= 0; i--) {
      const w = walls[i]
      if (!timeStop) w.age += dt
      if (!mountainAlive(w)) {
        walls.splice(i, 1)
        continue
      }
      if (w.age < SUPER.mountain.rise && Math.random() < dt * 14) {
        const p = w.peaks[Math.floor(Math.random() * w.peaks.length)]
        particles.dustPuff(p.x + (Math.random() - 0.5) * 1.5, p.z + (Math.random() - 0.5) * 1.5, 0.9)
      }
    }
    if (walls.length === 0) return
    if (!player.gliding) {
      const r = pushOutOfWalls(player.x, player.z, PLAYER.r, walls)
      player.x = r.x
      player.z = r.z
      if (r.caught) {
        const side = (player.x - r.caught.cx) * r.caught.nx + (player.z - r.caught.cz) * r.caught.nz >= 0 ? 1 : -1
        knockMe(r.caught.nx * side, r.caught.nz * side, 1.1)
      }
    }
    if (mode === 'practice') {
      const r = pushOutOfWalls(ai.x, ai.z, PLAYER.r, walls)
      ai.x = r.x
      ai.z = r.z
      if (r.caught) {
        const side = (ai.x - r.caught.cx) * r.caught.nx + (ai.z - r.caught.cz) * r.caught.nz >= 0 ? 1 : -1
        knockAi(r.caught.nx * side, r.caught.nz * side, 1.1)
      }
    }
  }

  /** Immediate ball broadcast (Zero Hour hand-back). */
  function sendBallNow(): void {
    net?.sendBallState(
      { x: localBall.x, y: localBall.y, z: localBall.z, vx: localBall.vx, vy: localBall.vy, vz: localBall.vz, lastTouch: localBall.lastTouch, seq: ballSeq++, t: nowSec(), from: isHost() ? undefined : myId },
      { clock, phase, scoreA, scoreB },
    )
  }

  /** Drop every live super (session start, kickoff, restarts, leaving). */
  function clearSupers(resetEgo: boolean): void {
    walls.length = 0
    cyclones.length = 0
    pendingBolts.length = 0
    if (dragon && !dragon.done) superFx.endDragon(dragon.key, simT)
    dragon = null
    glide = null
    if (timeStop) manga.endClock(elapsed)
    timeStop = null
    tsBall = null
    player.clearStatuses()
    cameraRig.setLift(0)
    cameraRig.setKnocked(false)
    ai.sealT = 0
    ai.knockT = 0
    ai.stopT = 0
    ai.grip = 0
    superFx.clear()
    manga.clear()
    stormUntil = 0
    inkUntil = 0
    washAmt = 0
    superLock = 0
    remoteGlideStart.clear()
    if (resetEgo) ego = 0
  }

  /** The AI's super status → rig pose code. */
  function aiStatus(): { st: PlayerStatus; stT: number } {
    if (ai.stopT > 0) return { st: 3, stT: ai.stopT }
    if (ai.knockT > 0) return { st: 2, stT: ai.knockT }
    if (ai.sealT > 0) return { st: 1, stT: ai.sealT }
    if (ai.grip > 0.2) return { st: 4, stT: ai.grip }
    return { st: 0, stT: 0 }
  }

  /** Remote player's status is one that takes them out of play (no dribbling). */
  function remoteDisabled(id: string): boolean {
    const s = remote.latestStatus(id)
    return s !== null && s.st >= 1 && s.st <= 5
  }

  /** Mountain rock bounces the ball (every client — deterministic walls). */
  function wallBounce(): void {
    if (walls.length === 0) return
    const hit = collideBallWithWalls(localBall, walls)
    if (hit > 2) {
      audio.playBounce(localBall.x, localBall.z, Math.min(1, hit / 12))
      particles.dustPuff(localBall.x, localBall.z, 0.6)
    }
  }

  function copyBall(dst: BallState, src: BallStateMsg): void {
    dst.x = src.x
    dst.y = src.y
    dst.z = src.z
    dst.vx = src.vx
    dst.vy = src.vy
    dst.vz = src.vz
    dst.lastTouch = src.lastTouch
  }

  function blendBall(b: BallState, target: BallStateMsg, posL: number, velL: number, dt: number): void {
    b.x = damp(b.x, target.x, posL, dt)
    b.y = damp(b.y, target.y, posL, dt)
    b.z = damp(b.z, target.z, posL, dt)
    b.vx = damp(b.vx, target.vx, velL, dt)
    b.vy = damp(b.vy, target.vy, velL, dt)
    b.vz = damp(b.vz, target.vz, velL, dt)
  }

  function handleBallEvents(
    ev: { goal: Team | null; bounce: number; postHit: boolean; netTouch: boolean; playerTouch: string | null },
    authoritative: boolean,
  ): void {
    if (ev.bounce > 0.18) {
      audio.playBounce(localBall.x, localBall.z, ev.bounce)
      ballView.impact(ev.bounce, UP)
      if (ev.bounce > 0.5) particles.dustPuff(localBall.x, localBall.z, ev.bounce * 0.7)
    }
    if (ev.postHit) audio.playPost(localBall.x, localBall.z)
    if (ev.netTouch && ev.bounce < 0.18) audio.playBounce(localBall.x, localBall.z, 0.12)
    if (ev.goal && phase === 'play') {
      if (solo()) {
        if (ev.goal === 'A' && practiceResetAt === null) {
          practiceGoals++
          gainEgo(SUPER.egoGoal)
          celebrateGoal(PITCH.halfL, 'A', myName)
          practiceResetAt = nowSec() + 2.6
          pushUi()
        }
      } else if (authoritative && isHost()) {
        hostGoalScored(ev.goal)
      }
    }
    // grass flecks while it rolls fast
    const planar = Math.hypot(localBall.vx, localBall.vz)
    if (localBall.y <= BALL.r + 0.02 && planar > 4 && Math.random() < Math.min(0.4, (planar - 4) / 30)) {
      particles.grassBurst(localBall.x, localBall.z, 1, 0, 0, 0.3)
    }
  }

  // ------------------------------------------------------------------ aim overlay
  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  function drawAim(): void {
    if (!aimCtx) return
    const w = aimCanvas.clientWidth
    const h = aimCanvas.clientHeight
    if (w === 0 || h === 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (aimCanvas.width !== Math.round(w * dpr) || aimCanvas.height !== Math.round(h * dpr)) {
      aimCanvas.width = Math.round(w * dpr)
      aimCanvas.height = Math.round(h * dpr)
    }
    const ctx = aimCtx
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)
    if (screen !== 'game' || paused || phase === 'victory') return

    const cx = w / 2
    const cy = h / 2

    // center dot — a camera focus point
    ctx.beginPath()
    ctx.arc(cx, cy, 4.6, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(255, 248, 233, 0.8)'
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx, cy, 2.1, 0, Math.PI * 2)
    ctx.fillStyle = 'rgba(47, 40, 35, 0.95)'
    ctx.fill()

    // off-screen ball chevron — the ball is never lost while it's yours
    if (phase === 'play' && !spectating && !chargeCache.held) {
      const bd = Math.hypot(localBall.x - player.x, localBall.z - player.z)
      if (bd < PLAYER.dribbleRadius * 1.5) {
        const v = new THREE.Vector3(localBall.x, localBall.y, localBall.z).project(cameraRig.camera)
        const offscreen = v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1
        if (offscreen && v.z < 1) {
          const sx = clamp((v.x * 0.5 + 0.5) * w, 34, w - 34)
          ctx.globalAlpha = 0.75
          ctx.strokeStyle = 'rgba(47, 40, 35, 0.9)'
          ctx.lineWidth = 3.5
          ctx.lineCap = 'round'
          ctx.beginPath()
          ctx.moveTo(sx - 9, h - 26)
          ctx.lineTo(sx, h - 16)
          ctx.lineTo(sx + 9, h - 26)
          ctx.stroke()
          ctx.strokeStyle = 'rgba(255, 248, 233, 0.9)'
          ctx.lineWidth = 1.6
          ctx.beginPath()
          ctx.moveTo(sx - 9, h - 26)
          ctx.lineTo(sx, h - 16)
          ctx.lineTo(sx + 9, h - 26)
          ctx.stroke()
          ctx.globalAlpha = 1
        }
      }
    }

    // power ring while charging
    if (chargeCache.held) {
      const t = Math.max(KICK.minPower, chargeCache.power)
      const R = 23
      ctx.lineWidth = 4.5
      ctx.strokeStyle = 'rgba(47, 40, 35, 0.22)'
      ctx.beginPath()
      ctx.arc(cx, cy, R, 0, Math.PI * 2)
      ctx.stroke()
      const full = t >= 1
      ctx.strokeStyle = full ? '#e0492f' : t > 0.6 ? '#e8862d' : PALETTE.saffron
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2)
      ctx.stroke()
      if (full) {
        ctx.globalAlpha = 0.35 + 0.3 * Math.sin(nowSec() * 14)
        ctx.strokeStyle = '#ffdba8'
        ctx.lineWidth = 1.6
        ctx.beginPath()
        ctx.arc(cx, cy, R + 6, 0, Math.PI * 2)
        ctx.stroke()
        ctx.globalAlpha = 1
      }
    }

    // faint chip arc while charging with the camera pitched up
    if (chargeCache.held) {
      const loftN = loftFromPitch()
      if (loftN > 0.55) {
        const alpha = Math.min(0.75, (loftN - 0.55) * 2.2)
        const [fx, fz] = forwardXZ(cameraRig.yaw)
        const v0 = kickVelocity(Math.max(KICK.minPower, chargeCache.power), loftN, fx, fz)
        const y0 = Math.max(localBall.y, BALL.r)
        const g = 20
        const tLand = (v0.vy + Math.sqrt(Math.max(0, v0.vy * v0.vy + 2 * g * (y0 - BALL.r)))) / g
        const pts: Array<[number, number]> = []
        const N = 15
        for (let i = 0; i <= N; i++) {
          const t = (tLand * i) / N
          const wx = localBall.x + v0.vx * t
          const wy = y0 + v0.vy * t - 0.5 * g * t * t
          const wz = localBall.z + v0.vz * t
          const v = new THREE.Vector3(wx, Math.max(wy, BALL.r * 0.5), wz).project(cameraRig.camera)
          if (v.z > 1) break
          pts.push([(v.x * 0.5 + 0.5) * w, (-v.y * 0.5 + 0.5) * h])
        }
        if (pts.length > 2) {
          ctx.save()
          ctx.globalAlpha = alpha
          ctx.strokeStyle = 'rgba(253, 246, 230, 0.9)'
          ctx.lineWidth = 2
          ctx.setLineDash([5, 7])
          ctx.beginPath()
          ctx.moveTo(pts[0][0], pts[0][1])
          for (const p of pts.slice(1)) ctx.lineTo(p[0], p[1])
          ctx.stroke()
          const end = pts[pts.length - 1]
          ctx.setLineDash([3, 5])
          ctx.beginPath()
          ctx.ellipse(end[0], end[1], 13, 5.5, 0, 0, Math.PI * 2)
          ctx.stroke()
          ctx.restore()
        }
      }
    }

    // stamina bar (corner) — fades out when full
    const st = player.stamina / STAMINA.max
    if (st < 0.995 || player.sprinting) {
      const bw = 132
      const bh = 8
      const x = 18
      const y = h - 26
      ctx.globalAlpha = 0.9
      ctx.fillStyle = 'rgba(251, 243, 226, 0.75)'
      roundRect(ctx, x - 2, y - 2, bw + 4, bh + 4, 6)
      ctx.fill()
      ctx.fillStyle = st < 0.25 ? '#e0492f' : st < 0.55 ? '#e8a02d' : PALETTE.teal
      roundRect(ctx, x, y, bw * st, bh, 4)
      ctx.fill()
      ctx.strokeStyle = 'rgba(47, 40, 35, 0.55)'
      ctx.lineWidth = 1.4
      roundRect(ctx, x, y, bw, bh, 4)
      ctx.stroke()
      ctx.globalAlpha = 1
    }
  }

  // ------------------------------------------------------------------ super rendering
  const projV = new THREE.Vector3()

  function renderSupers(vdt: number): void {
    const inGame = screen === 'game'
    superFx.syncWalls(inGame ? walls : [])
    superFx.syncCyclones(inGame ? cyclones : [], timeStop ? 0 : vdt, elapsed)
    // eagles: mine while gliding / releasing, everyone else's from their glide status
    if (inGame && glide) {
      const u = glide.landed ? 1 + glide.release / 0.8 : clamp(glide.t / glide.total, 0, 1)
      superFx.setEagle(myId, { x: player.x, y: cameraRig.camera.position.y, z: player.z, yaw: cameraRig.yaw, u }, elapsed)
      manga.holdStreaks(glide.landed ? 0 : 1)
      if (!glide.landed) manga.holdFocus(0.45, '#1f847d')
    }
    for (const [id, rig] of rigs) {
      if (id === AI_ID) continue
      const st = remote.latestStatus(id)?.st ?? 0
      if (st === 5) {
        if (!remoteGlideStart.has(id)) {
          remoteGlideStart.set(id, elapsed)
          audio.playWhoosh(rig.group.position.x, rig.group.position.z, 1)
        }
        const u = clamp((elapsed - (remoteGlideStart.get(id) ?? elapsed)) / 1.0, 0, 1)
        superFx.setEagle(id, { x: rig.group.position.x, y: 2.6, z: rig.group.position.z, yaw: rig.group.rotation.y, u }, elapsed)
      } else {
        remoteGlideStart.delete(id)
      }
    }
    // seals
    const seals: Array<{ key: string; x: number; z: number; t: number }> = []
    if (inGame) {
      if (player.sealT > 0) seals.push({ key: myId, x: player.x, z: player.z, t: player.sealT })
      if (mode === 'practice' && ai.sealT > 0) seals.push({ key: AI_ID, x: ai.x, z: ai.z, t: ai.sealT })
      for (const [id, rig] of rigs) {
        if (id === AI_ID) continue
        const s = remote.latestStatus(id)
        if (s && s.st === 1) seals.push({ key: id, x: rig.group.position.x, z: rig.group.position.z, t: s.stT })
      }
    }
    superFx.setSeals(seals, elapsed, cameraRig.camera)
    superFx.update(vdt, simT, localBall)
    // dragon flight / zap: sustained ink lines
    if (dragon && !dragon.done && simT >= dragon.strikeAt) manga.holdFocus(dragon.from === myId ? 0.55 : 0.3, '#a52d1e')
    if (dragon && !dragon.done && simT < dragon.strikeAt && dragon.from === myId) manga.holdFocus(0.35, '#a52d1e')
    if (player.zapT > 0 && player.speed > 3) manga.holdStreaks(0.6)

    // grade
    storm = damp(storm, elapsed < stormUntil ? 1 : 0, elapsed < stormUntil ? 7 : 2.5, vdt)
    mono = damp(mono, timeStop ? 1 : 0, timeStop ? 9 : 5, vdt)
    washAmt = damp(washAmt, 0, 1.8, vdt)
    grade.setSuperFx({
      storm,
      mono,
      ink: elapsed < inkUntil ? 1 : 0,
      wash: washColor,
      washAmt,
      focus: manga.focusAmount(elapsed),
    })
  }

  function drawManga(vdt: number): void {
    const cam = cameraRig.camera
    const w = fxCanvas.clientWidth
    const h = fxCanvas.clientHeight
    const project = (x: number, y: number, z: number): { x: number; y: number; visible: boolean } => {
      projV.set(x, y, z).project(cam)
      return { x: (projV.x * 0.5 + 0.5) * w, y: (-projV.y * 0.5 + 0.5) * h, visible: projV.z < 1 && Math.abs(projV.x) < 1.3 && Math.abs(projV.y) < 1.3 }
    }
    const status: LocalStatus = {
      sealT: player.sealT,
      knockT: player.knockT,
      stopT: player.stopT,
      stopBy: '',
      grip: player.cycloneGrip,
      zapT: player.zapT,
      zapTotal: SUPER.timeStop.soloDur,
      glide: glide && !glide.landed ? 1 : 0,
    }
    manga.draw(elapsed, vdt, project, screen === 'game' ? status : null, screen === 'game' && !paused && phase !== 'victory')
  }

  // ------------------------------------------------------------------ loop
  let raf = 0
  let lastRaf = performance.now()
  let last = performance.now()
  let elapsed = 0
  let crowdLevel = 0.15
  let running = true
  let acc = 0
  const tmpVecA = new THREE.Vector3()
  const tmpVecB = new THREE.Vector3()
  const tmpSize = new THREE.Vector2()

  /** Advance the fixed-step simulation to real time `t` (ms). Returns the real dt (s). */
  const simulate = (t: number): number => {
    let realDt = (t - last) / 1000
    last = t
    if (realDt > 0.25) realDt = 0.25 // tab-switch guard
    if (realDt < 0.0001) realDt = 0.0001
    elapsed += realDt

    // fixed-timestep simulation: the match runs at real speed even when the
    // renderer struggles (weak phones, throttled tabs) — visual damp math is
    // framerate-independent, so the camera stays smooth either way.
    // solo slow-mo on the big super beats (the sim clock slows, the overlay doesn't)
    acc += realDt * (elapsed < slowMoUntil ? slowMoScale : 1)
    const STEP = 1 / 60
    let steps = 0
    while (acc >= STEP && steps < 18) {
      if (screen === 'game' && phase !== 'victory') stepGame(STEP)
      acc -= STEP
      steps++
    }
    if (acc > STEP * 2) acc = 0 // fell too far behind — drop the backlog
    return realDt
  }

  const frameLoop = (t: number): void => {
    if (!running) return
    raf = requestAnimationFrame(frameLoop)
    lastRaf = performance.now()
    const realDt = simulate(t)

    const vdt = Math.min(0.05, realDt)
    if (screen === 'game' && phase !== 'victory') {
      const speed01 = clamp(player.speed / PLAYER.sprintSpeed, 0, 1)
      const stepT = player.stepAnimT
      const stepEnv = stepT > 0 ? Math.sin(Math.min(1, (1 - stepT / 0.46) * 1.35) * Math.PI) : 0
      const stepSide = player.stepoverFeintSide * stepEnv
      const flickEnv = player.flickAnimT > 0 ? Math.sin((player.flickAnimT / 0.55) * Math.PI) : 0
      const throwHold = phase === 'restart' && restart?.kind === 'throwin' && restart.takerId === myId
      const actState = player.action
      const legAction: LegActionState | null =
        actState || player.juggling
          ? {
              kind: actState ? actState.kind : 0,
              t: actState ? actState.t : 0,
              total: actState ? actState.total : 1,
              s: actState ? actState.s : 0,
              juggle: player.juggling,
              jugglePhase: player.jugglePhase,
            }
          : null
      cameraRig.setKnocked(player.knockT > 0.1)
      cameraRig.setSlideBlend(player.sliding ? 1 : 0)
      cameraRig.setThrowBlend(throwHold || player.throwAnimT > 0 ? 1 : 0)
      cameraRig.update(vdt, { x: player.x, z: player.z, speed01, sprinting: player.sprinting, grounded: true }, elapsed)
      legs.update(vdt, speed01, player.kickAnimT, player.cutSide, throwHold, player.throwAnimT, player.sliding ? 1 : 0, stepSide, flickEnv, legAction, cameraRig.visualPitch)
      // world-space body anchor: hips under the player, spine a hand behind
      // the eye, yawed with the view — level gaze keeps it out of sight, a
      // look-down shows the chest at the bottom edge and the legs striding
      legs.group.visible = true
      legs.place(player.x, player.z, cameraRig.yaw)
    } else {
      legs.group.visible = false
      cameraRig.updateCinematic(vdt, elapsed)
    }

    if (aiThrowT > 0) aiThrowT = Math.max(0, aiThrowT - vdt)

    for (const [id, rig] of rigs) {
      if (id === AI_ID) {
        const st = aiStatus()
        rig.apply(
          { x: ai.x, z: ai.z, yaw: ai.yaw, spd: Math.hypot(ai.vx, ai.vz), spr: false, kickT: 0, cutS: 0, flickT: 0, stepT: 0, slideT: 0, throwT: aiThrowT, act: 0, actT: 0, actS: 0, jugl: 0, st: st.st, stT: st.stT },
          vdt,
        )
      } else {
        // a player we haven't heard from in a while fades out instead of freezing in place
        rig.group.visible = remote.age(id, nowSec()) <= STALE_AFTER
        const pose = remote.sample(id, nowSec())
        if (pose) rig.apply(pose, vdt)
      }
      if (rig.consumeFootsteps() > 0) {
        audio.playFootstep(rig.group.position.x, rig.group.position.z, false, false)
      }
    }

    ballView.update(vdt, tmpVecA.set(localBall.x, localBall.y, localBall.z), tmpVecB.set(localBall.vx, localBall.vy, localBall.vz))
    // stopped time: the maidan itself holds still (kites, motes, petals, crowd)
    if (!timeStop) {
      world.step(vdt, elapsed, cameraRig.camera.position.x, cameraRig.camera.position.z)
      particles.step(vdt, elapsed)
    }
    renderSupers(vdt)

    if (mode === 'match') lights.setSunProgress(clamp(clock / (MATCH.halfLen * MATCH.halves), 0, 1))
    else if (solo()) lights.setSunProgress(clamp(elapsed / 300, 0, 1))
    else lights.setSunProgress(0.42)

    audio.setListener({ x: cameraRig.camera.position.x, z: cameraRig.camera.position.z, yaw: cameraRig.yaw })
    const planar = Math.hypot(localBall.vx, localBall.vz)
    const rolling = localBall.y <= BALL.r + 0.03 && planar > 0.3 && screen === 'game'
    audio.setBallRoll(rolling ? planar : 0, localBall.x, localBall.z)
    audio.update(vdt)
    const targetCrowd = mode === 'match' ? (phase === 'goal' || phase === 'victory' ? 1 : 0.42) : 0.14
    crowdLevel = damp(crowdLevel, targetCrowd, 0.9, vdt)
    audio.setCrowdLevel(crowdLevel)

    renderer.getDrawingBufferSize(tmpSize)
    updateOutlineFrame(cameraRig.camera, tmpSize.x, tmpSize.y)
    grade.render(scene, cameraRig.camera, elapsed)

    drawAim()
    drawManga(vdt)

    uiTimer += realDt
    if (uiTimer > 0.1) {
      uiTimer = 0
      snapshot = buildUi()
      for (const fn of listeners) fn()
    }
  }

  // ------------------------------------------------------------------ resize
  const resize = (): void => {
    const w = Math.max(2, container.clientWidth)
    const h = Math.max(2, container.clientHeight)
    renderer.setSize(w, h, false)
    cameraRig.camera.aspect = w / h
    cameraRig.camera.updateProjectionMatrix()
    renderer.getDrawingBufferSize(tmpSize)
    grade.setSize(tmpSize.x, tmpSize.y)
  }
  const ro = new ResizeObserver(resize)
  ro.observe(container)
  resize()

  const unlockAudio = (): void => {
    audio.unlock().catch(() => undefined)
  }
  container.addEventListener('pointerdown', unlockAudio, { once: true })
  container.addEventListener('keydown', unlockAudio, { once: true })

  // hybrid devices: flip to touch controls on the first real touch
  window.addEventListener(
    'touchstart',
    () => {
      if (!touchMode) {
        touchMode = true
        pushUi()
      }
    },
    { once: true, passive: true },
  )

  raf = requestAnimationFrame(frameLoop)

  // Background tabs stop requestAnimationFrame. In a match that froze the whole
  // game (a backgrounded HOST stops the ball, clock and restarts for everyone; a
  // backgrounded player stops sending their position). A Web Worker timer isn't
  // paused, so while rAF is silent it keeps the simulation + networking ticking
  // at 30 Hz — rendering waits until the tab is visible again.
  let bgWorker: Worker | null = null
  try {
    const src = 'setInterval(function(){postMessage(0)},33)'
    bgWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    bgWorker.onmessage = () => {
      if (!running) return
      const now = performance.now()
      if (now - lastRaf > 150) simulate(now)
    }
  } catch {
    bgWorker = null
  }

  // ------------------------------------------------------------------ commands
  async function connectRoom(code: string): Promise<void> {
    if (!isNetConfigured()) {
      toast('Multiplayer is unavailable here. Practice works offline!')
      return
    }
    audio.unlock().catch(() => undefined)
    mode = 'match'
    screen = 'room'
    netCode = code
    pushUi()
    try {
      const client = new RelayNet(makeNetHandlers())
      await client.connect(code, { id: client.myId, name: myName, team: 'A', joinedAt: Date.now() })
      net = client
      myId = client.myId
      myDribbler.id = myId
      prevHostId = null
      toast(`Joined room ${code}`)
    } catch (e) {
      net?.disconnect()
      net = null
      mode = 'menu'
      screen = 'menu'
      netCode = ''
      toast(e instanceof Error ? e.message : 'Could not connect.')
    }
    pushUi()
  }

  function cmd(c: UiCmd): void {
    switch (c.type) {
      case 'setName': {
        const n = c.name.trim().slice(0, 14)
        if (n) {
          myName = n
          try {
            localStorage.setItem('gg-name', n)
          } catch {
            /* ignore */
          }
          net?.updatePresence({ name: n })
        }
        pushUi()
        break
      }
      case 'createRoom':
        void connectRoom(makeRoomCode())
        break
      case 'joinRoom': {
        const code = normalizeRoomCode(c.code)
        if (code.length !== 4) {
          toast('Room codes are 4 characters.')
          break
        }
        void connectRoom(code)
        break
      }
      case 'leaveRoom': {
        clearSupers(true)
        net?.disconnect()
        net = null
        roster = []
        prevHostId = null
        remote.clear()
        for (const [, rig] of [...rigs]) {
          scene.remove(rig.group)
          rig.dispose()
        }
        rigs.clear()
        rigTeams.clear()
        mode = 'menu'
        screen = 'menu'
        phase = 'lobby'
        netCode = ''
        paused = false
        victory = null
        banner = null
        restart = null
        offsideFlags.clear()
        slideCleanIds.clear()
        slidePokedIds.clear()
        countdownEndsAt = null
        hostTimers.length = 0
        setBall(0, 0)
        player.teleport(0, 0)
        pushUi()
        break
      }
      case 'startMatch': {
        if (!isHost() || mode !== 'match') break
        const a = roster.filter((r) => r.team === 'A').length
        const b = roster.filter((r) => r.team === 'B').length
        if (roster.length < 2 || a === 0 || b === 0) {
          toast('Need at least one player on each team (2+ total). Shuffle to balance.')
          break
        }
        scoreA = 0
        scoreB = 0
        clock = 0
        half = 1
        scorers = []
        victory = null
        restart = null
        screen = 'game'
        beginKickoff()
        pushUi()
        break
      }
      case 'shuffleTeams': {
        if (!isHost() || mode !== 'match') break
        const ids = roster.map((r) => r.id)
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1))
          const tmp = ids[i]
          ids[i] = ids[j]
          ids[j] = tmp
        }
        const teams: Record<string, Team> = {}
        ids.forEach((id, i) => {
          teams[id] = i % 2 === 0 ? 'A' : 'B'
        })
        const msg: MatchEventMsg = { type: 'teams', teams }
        net?.sendEvent(msg)
        applyEvent(msg)
        break
      }
      case 'setTeam': {
        if (!isHost() || mode !== 'match') break
        const teams: Record<string, Team> = {}
        for (const r of roster) teams[r.id] = r.id === c.id ? c.team : r.team
        const msg: MatchEventMsg = { type: 'teams', teams }
        net?.sendEvent(msg)
        applyEvent(msg)
        break
      }
      case 'rematch': {
        if (!isHost() || mode !== 'match') break
        scoreA = 0
        scoreB = 0
        clock = 0
        half = 1
        scorers = []
        victory = null
        banner = null
        restart = null
        offsideFlags.clear()
        beginKickoff()
        break
      }
      case 'startPractice': {
        mode = 'practice'
        clearSupers(true)
        screen = 'game'
        phase = 'play'
        paused = false
        spectating = false
        practiceGoals = 0
        practiceResetAt = null
        clock = 0
        half = 1
        victory = null
        restart = null
        offsideFlags.clear()
        player.teleport(-8, 0)
        cameraRig.yaw = -Math.PI / 2
        cameraRig.pitch = -0.06
        ai.x = 10
        ai.z = 0
        ai.vx = 0
        ai.vz = 0
        ai.kickCd = 1
        setBall(-7.2, 0)
        input.inputEnabled = true
        syncRigs()
        pushUi()
        toast('Practice — full rules on (offside is off). R resets the ball, C slides.')
        break
      }
      case 'startFreePlay': {
        mode = 'free'
        clearSupers(true)
        screen = 'game'
        phase = 'play'
        paused = false
        spectating = false
        practiceGoals = 0
        practiceResetAt = null
        clock = 0
        half = 1
        victory = null
        banner = null
        restart = null
        offsideFlags.clear()
        player.teleport(-8, 0)
        cameraRig.yaw = -Math.PI / 2
        cameraRig.pitch = -0.06
        setBall(-7.2, 0)
        input.inputEnabled = true
        syncRigs()
        pushUi()
        toast('Free play — just you and the ball. R brings it to your feet.')
        break
      }
      case 'practiceReset': {
        if (solo()) {
          const [fx, fz] = forwardXZ(cameraRig.yaw)
          setBall(player.x + fx * 0.6, player.z + fz * 0.6)
        }
        break
      }
      case 'leaveMatch': {
        clearSupers(true)
        if (solo()) {
          mode = 'menu'
          screen = 'menu'
          phase = 'lobby'
          input.inputEnabled = false
          input.exitLock()
          restart = null
          offsideFlags.clear()
          setBall(0, 0)
          player.teleport(0, 0)
          syncRigs()
        } else {
          endMatchToLobby()
        }
        pushUi()
        break
      }
      case 'toggleMute': {
        muted = !muted
        audio.setMuted(muted)
        pushUi()
        break
      }
      case 'requestLock': {
        paused = false
        input.inputEnabled = (phase === 'play' || phase === 'restart') && !spectating
        input.requestLock()
        pushUi()
        break
      }
      case 'setSettings': {
        applySettingsPatch(c.patch)
        break
      }
    }
  }

  function applySettingsPatch(patch: GameSettingsPatch): void {
    const prevQuality = settings.quality
    Object.assign(settings, patch)
    saveSettings(settings)
    cameraRig.setFov(settings.fov)
    audio.setMaster(settings.volume)
    if (patch.quality !== undefined && patch.quality !== prevQuality) {
      applyQuality(patch.quality)
    }
    pushUi()
  }

  // ------------------------------------------------------------------ handle
  const handle: GameHandle = {
    cmd,
    input,
    subscribe(fn: () => void): () => void {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getSnapshot: (): UiState => snapshot,
    dispose(): void {
      running = false
      cancelAnimationFrame(raf)
      bgWorker?.terminate()
      ro.disconnect()
      input.dispose()
      net?.disconnect()
      for (const [, rig] of [...rigs]) {
        scene.remove(rig.group)
        rig.dispose()
      }
      rigs.clear()
      particles.dispose()
      superFx.dispose()
      ballView.dispose()
      legs.dispose()
      world.dispose()
      lights.dispose()
      grade.dispose()
      renderer.dispose()
    },
  }

  // read-only diagnostics (bug reports / dev console)
  if (typeof window !== 'undefined') {
    ;(window as unknown as Record<string, unknown>).__gg = {
      get ball() {
        return { ...localBall }
      },
      get me() {
        return {
          x: player.x,
          z: player.z,
          yaw: cameraRig.yaw,
          pitch: cameraRig.pitch,
          stamina: player.stamina,
          act: player.action ? player.action.kind : 0,
          actT: player.action ? player.action.t : 0,
          actS: player.action ? player.action.s : 0,
          juggling: player.juggling,
          jugglePhase: player.jugglePhase,
          grace: skillBallGrace,
        }
      },
      get ai() {
        return { x: ai.x, z: ai.z, yaw: ai.yaw }
      },
      get match() {
        return { mode, screen, phase, scoreA, scoreB, practiceGoals, spectating, paused, restart, offside: [...offsideFlags], hostBall }
      },
      get settings() {
        return { ...settings }
      },
      get net() {
        const t = nowSec()
        const remotes: Record<string, { x: number; z: number; age: number; st: number }> = {}
        for (const id of remote.ids()) {
          const p = remote.latest(id)
          if (p) remotes[id] = { x: p.x, z: p.z, age: remote.age(id, t), st: remote.latestStatus(id)?.st ?? 0 }
        }
        return { myId, status: netStatus, code: netCode, isHost: isHost(), roster: roster.map((r) => ({ id: r.id, name: r.name, team: r.team })), remotes }
      },
    }
  }

  syncRigs()
  pushUi()
  return handle
}

export function formatMatchClock(seconds: number): string {
  return formatClock(Math.min(seconds, MATCH.halfLen * MATCH.halves))
}
