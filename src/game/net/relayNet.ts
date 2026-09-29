/**
 * Multiplayer transport over our own WebSocket relay (server/index.mjs).
 *
 * The relay owns rooms: roster, host (oldest member), team balance, the
 * player cap, and dropping dead connections. It relays envelopes verbatim, so
 * every field a message carries arrives intact.
 *
 * Authority model (enforced by the Game, transported here):
 *  - every client owns + broadcasts its own transform at 20 Hz
 *  - the HOST is the sole arbiter of ball state, score, clock and phases
 *  - kicks are requests; the host validates range + power before applying
 *
 * Connection drops reconnect automatically with backoff, re-joining the same
 * room under the same id, so a hiccup never kicks you out of a match.
 */
import { NET } from '../core/constants'
import type {
  BallStateMsg,
  KickMsg,
  MatchEventMsg,
  NetClient,
  NetHandlers,
  PlayerStateMsg,
  PresencePayload,
  RosterEntry,
} from '../core/types'

type Envelope = { k: 'pos' | 'ball' | 'kick' | 'evt'; d: unknown }

/** Same origin in production; `next dev` on :3000 talks to the local relay on :3001. */
function relayUrl(): string {
  const env = process.env.NEXT_PUBLIC_RELAY_URL
  if (env) return env
  const { protocol, hostname, port } = window.location
  const wsProto = protocol === 'https:' ? 'wss:' : 'ws:'
  if (port === '3000') return `${wsProto}//${hostname}:3001/ws`
  return `${wsProto}//${window.location.host}/ws`
}

/** Multiplayer is always available — the relay ships with the site. */
export function isNetConfigured(): boolean {
  return typeof window !== 'undefined'
}

/** Round to 3 decimals: mm precision, a much smaller packet. */
const r3 = (v: number): number => Math.round(v * 1000) / 1000

export class RelayNet implements NetClient {
  readonly myId: string
  readonly configured = true

  private ws: WebSocket | null = null
  private handlers: NetHandlers
  private code = ''
  private me: PresencePayload | null = null
  private closedByUser = false
  private retry = 0
  private retryTimer = 0
  private pingTimer = 0
  private everJoined = false

  constructor(handlers: NetHandlers) {
    this.handlers = handlers
    this.myId = crypto.randomUUID()
  }

  connect(code: string, me: PresencePayload): Promise<void> {
    this.code = code
    this.me = { ...me, id: this.myId }
    this.closedByUser = false
    this.handlers.onStatus('connecting')
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error('Could not reach the game server — try again in a moment.'))
        this.disconnect()
      }, 20000)
      this.open(
        () => {
          window.clearTimeout(timeout)
          resolve()
        },
        (err) => {
          window.clearTimeout(timeout)
          reject(err)
        },
      )
    })
  }

  private open(onJoined?: () => void, onFail?: (e: Error) => void): void {
    let ws: WebSocket
    try {
      ws = new WebSocket(relayUrl())
    } catch (e) {
      onFail?.(e instanceof Error ? e : new Error('WebSocket failed'))
      return
    }
    this.ws = ws
    ws.onopen = () => {
      const me = this.me
      if (!me) return
      ws.send(JSON.stringify({ t: 'join', room: this.code, id: this.myId, name: me.name, team: me.team }))
    }
    ws.onmessage = (ev) => {
      let msg: { t?: string; [k: string]: unknown }
      try {
        msg = JSON.parse(String(ev.data))
      } catch {
        return
      }
      switch (msg.t) {
        case 'joined': {
          const first = !this.everJoined
          this.everJoined = true
          this.retry = 0
          this.handlers.onStatus('connected')
          this.startPing()
          if (first) onJoined?.()
          // (re)announce so the host sends a snapshot
          this.sendEvent({ type: 'hello', from: this.myId })
          break
        }
        case 'full': {
          this.closedByUser = true
          onFail?.(new Error(`Room is full (${NET.maxPlayers} players).`))
          break
        }
        case 'roster': {
          const roster = (msg.roster as RosterEntry[] | undefined) ?? []
          const mine = roster.find((r) => r.id === this.myId)
          if (mine && this.me) this.me.team = mine.team
          this.handlers.onRoster(roster)
          break
        }
        case 'm':
          this.onEnvelope(msg.d as Envelope)
          break
        case 'b':
          // one batched packet per server tick: events/kicks (in order), ball, poses
          for (const env of (msg.m as Envelope[] | undefined) ?? []) this.onEnvelope(env)
          break
      }
    }
    ws.onclose = () => {
      window.clearInterval(this.pingTimer)
      if (this.ws !== ws) return
      this.ws = null
      if (this.closedByUser) return
      if (!this.everJoined) {
        onFail?.(new Error('Could not reach the game server — try again in a moment.'))
        return
      }
      // drop → reconnect with backoff; the seat is kept under the same id
      this.handlers.onStatus('connecting', 'reconnecting')
      const delay = Math.min(5000, 500 * Math.pow(1.7, this.retry++))
      this.retryTimer = window.setTimeout(() => this.open(), delay)
    }
    ws.onerror = () => {
      /* onclose follows */
    }
  }

  private startPing(): void {
    window.clearInterval(this.pingTimer)
    this.pingTimer = window.setInterval(() => this.raw({ t: 'ping' }), 4000)
  }

  disconnect(): void {
    this.closedByUser = true
    window.clearTimeout(this.retryTimer)
    window.clearInterval(this.pingTimer)
    if (this.ws) {
      try {
        this.ws.close(1000, 'bye')
      } catch {
        /* already closed */
      }
      this.ws = null
    }
    this.handlers.onStatus('closed')
  }

  updatePresence(partial: Partial<PresencePayload>): void {
    if (!this.me) return
    this.me = { ...this.me, ...partial }
    this.raw({ t: 'presence', name: partial.name, team: partial.team })
  }

  /** Host only: set everyone's team in one step (the relay applies it atomically). */
  setTeams(teams: Record<string, 'A' | 'B'>): void {
    this.raw({ t: 'teams', teams })
  }

  private onEnvelope(env: Envelope | null): void {
    if (!env || typeof env !== 'object' || !env.d || typeof env.d !== 'object') return
    const d = env.d as Record<string, unknown>
    switch (env.k) {
      case 'pos':
        if (typeof d.id === 'string') this.handlers.onPlayerState(d as unknown as PlayerStateMsg)
        break
      case 'ball': {
        const { clock, phase, scoreA, scoreB, ...ball } = d
        this.handlers.onBallState(ball as unknown as BallStateMsg, {
          clock: Number(clock) || 0,
          phase: (phase as never) ?? 'play',
          scoreA: Number(scoreA) || 0,
          scoreB: Number(scoreB) || 0,
        })
        break
      }
      case 'kick':
        if (typeof d.id === 'string') this.handlers.onKick(d as unknown as KickMsg)
        break
      case 'evt':
        if (typeof d.type === 'string') this.handlers.onEvent(d as unknown as MatchEventMsg)
        break
    }
  }

  sendPlayerState(msg: PlayerStateMsg): void {
    this.send({
      k: 'pos',
      d: {
        ...msg,
        x: r3(msg.x),
        z: r3(msg.z),
        yaw: r3(msg.yaw),
        spd: r3(msg.spd),
        kickT: r3(msg.kickT),
        flickT: r3(msg.flickT),
        stepT: r3(msg.stepT),
        slideT: r3(msg.slideT),
        throwT: r3(msg.throwT),
        actT: r3(msg.actT),
        stT: msg.stT !== undefined ? r3(msg.stT) : undefined,
      },
    })
  }

  sendBallState(msg: BallStateMsg, meta: { clock: number; phase: string; scoreA: number; scoreB: number }): void {
    this.send({
      k: 'ball',
      d: { ...msg, x: r3(msg.x), y: r3(msg.y), z: r3(msg.z), vx: r3(msg.vx), vy: r3(msg.vy), vz: r3(msg.vz), ...meta },
    })
  }

  sendKick(msg: KickMsg): void {
    this.send({ k: 'kick', d: msg })
  }

  sendEvent(msg: MatchEventMsg): void {
    this.send({ k: 'evt', d: msg })
  }

  private send(env: Envelope): void {
    this.raw({ t: 'm', d: env })
  }

  private raw(obj: unknown): void {
    const ws = this.ws
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
  }
}

/** Room code from the unambiguous alphabet. */
export function makeRoomCode(): string {
  const bytes = new Uint32Array(4)
  crypto.getRandomValues(bytes)
  let code = ''
  for (let i = 0; i < 4; i++) code += NET.codeChars[bytes[i] % NET.codeChars.length]
  return code
}

export function normalizeRoomCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4)
}
