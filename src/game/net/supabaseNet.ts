/**
 * Supabase Realtime networking: presence for the lobby/rosters, broadcast for
 * transforms + events. Zero server code — this all runs client-side against
 * Supabase's hosted realtime service.
 *
 * Authority model (enforced by the Game, transported here):
 *  - every client owns + broadcasts its own transform at 20 Hz
 *  - the HOST is the sole arbiter of ball state, score, clock and phases
 *  - kicks are requests; the host validates range + power before applying
 */
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
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
  Team,
} from '../core/types'

/** Supabase credentials come ONLY from build-time env vars (see .env.example):
 *  NEXT_PUBLIC_SUPABASE_URL + NEXT_PUBLIC_SUPABASE_ANON_KEY. No in-game paste. */
function resolveCreds(): { url: string; key: string } {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
    key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  }
}

export function isSupabaseConfigured(): boolean {
  const { url, key } = resolveCreds()
  return url.length > 8 && key.length > 20
}

type Envelope = { k: 'pos' | 'ball' | 'kick' | 'evt'; d: unknown }

export class SupabaseNet implements NetClient {
  readonly myId: string
  readonly configured = true

  private supabase: SupabaseClient
  private channel: RealtimeChannel | null = null
  private presence: PresencePayload | null = null
  private handlers: NetHandlers
  private code = ''

  constructor(handlers: NetHandlers) {
    const creds = resolveCreds()
    if (!isSupabaseConfigured()) throw new Error('Supabase is not configured')
    this.handlers = handlers
    this.myId = crypto.randomUUID()
    this.supabase = createClient(creds.url, creds.key, {
      realtime: { params: { eventsPerSecond: 60 } },
    })
  }

  async connect(code: string, me: PresencePayload): Promise<void> {
    this.code = code
    this.presence = me
    this.handlers.onStatus('connecting')
    const channel = this.supabase.channel(`gg-room-${code}`, {
      config: { broadcast: { self: false }, presence: { key: this.myId } },
    })
    this.channel = channel

    channel.on('broadcast', { event: 'm' }, ({ payload }) => {
      this.onEnvelope(payload as Envelope)
    })
    channel.on('presence', { event: 'sync' }, () => this.syncPresence())

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Realtime connection timed out — check your Supabase keys.'))
      }, 12000)
      channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          clearTimeout(timeout)
          channel.track(me).catch(() => undefined)
          this.handlers.onStatus('connected')
          resolve()
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          clearTimeout(timeout)
          this.handlers.onStatus('error', status)
          reject(new Error(`Realtime ${status}`))
        }
      })
    })

    // announce so the host sends a snapshot
    this.sendEvent({ type: 'hello', from: this.myId })
  }

  disconnect(): void {
    if (this.channel) {
      this.channel.unsubscribe().catch(() => undefined)
      this.supabase.removeChannel(this.channel)
      this.channel = null
    }
    this.handlers.onStatus('closed')
  }

  updatePresence(partial: Partial<PresencePayload>): void {
    if (!this.channel || !this.presence) return
    this.presence = { ...this.presence, ...partial }
    this.channel.track(this.presence).catch(() => undefined)
  }

  private syncPresence(): void {
    if (!this.channel) return
    const state = this.channel.presenceState() as Record<string, Array<Record<string, unknown>>>
    const roster: RosterEntry[] = []
    for (const items of Object.values(state)) {
      const item = items[0]
      if (!item || typeof item.id !== 'string') continue
      roster.push({
        id: item.id as string,
        name: typeof item.name === 'string' ? item.name : 'Player',
        team: item.team === 'B' ? 'B' : 'A',
        joinedAt: typeof item.joinedAt === 'number' ? item.joinedAt : Date.now(),
        isHost: false,
      })
    }
    roster.sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))
    if (roster.length > 0) roster[0].isHost = true
    this.handlers.onRoster(roster)
  }

  private onEnvelope(env: Envelope | null): void {
    if (!env || typeof env !== 'object') return
    const d = env.d as Record<string, unknown>
    switch (env.k) {
      case 'pos': {
        if (typeof d.id !== 'string') return
        const msg: PlayerStateMsg = {
          id: d.id,
          x: num(d.x),
          z: num(d.z),
          yaw: num(d.yaw),
          spd: num(d.spd),
          spr: d.spr === 1 ? 1 : 0,
          kickT: num(d.kickT),
          cutS: d.cutS === -1 ? -1 : d.cutS === 1 ? 1 : 0,
          flickT: num(d.flickT),
          stepT: num(d.stepT),
          slideT: num(d.slideT),
          throwT: num(d.throwT),
          act: num(d.act),
          actT: num(d.actT),
          actS: num(d.actS),
          jugl: d.jugl === 1 ? 1 : 0,
          seq: num(d.seq),
          t: num(d.t),
        }
        this.handlers.onPlayerState(msg)
        break
      }
      case 'ball': {
        const msg: BallStateMsg = {
          x: num(d.x),
          y: num(d.y),
          z: num(d.z),
          vx: num(d.vx),
          vy: num(d.vy),
          vz: num(d.vz),
          lastTouch: typeof d.lastTouch === 'string' ? d.lastTouch : null,
          seq: num(d.seq),
          t: num(d.t),
        }
        this.handlers.onBallState(msg, {
          clock: num(d.clock),
          phase: (d.phase as never) ?? 'play',
          scoreA: num(d.scoreA),
          scoreB: num(d.scoreB),
        })
        break
      }
      case 'kick': {
        const msg: KickMsg = {
          id: typeof d.id === 'string' ? d.id : '',
          dx: num(d.dx),
          dz: num(d.dz),
          loftN: num(d.loftN),
          power: num(d.power),
          kind: d.kind === 'throw' ? 'throw' : 'kick',
          seq: num(d.seq),
        }
        this.handlers.onKick(msg)
        break
      }
      case 'evt': {
        const msg = d as unknown as MatchEventMsg
        if (msg && typeof msg.type === 'string') this.handlers.onEvent(msg)
        break
      }
    }
  }

  sendPlayerState(msg: PlayerStateMsg): void {
    this.send({ k: 'pos', d: msg })
  }

  sendBallState(msg: BallStateMsg, meta: { clock: number; phase: string; scoreA: number; scoreB: number }): void {
    this.send({ k: 'ball', d: { ...msg, ...meta } })
  }

  sendKick(msg: KickMsg): void {
    this.send({ k: 'kick', d: msg })
  }

  sendEvent(msg: MatchEventMsg): void {
    this.send({ k: 'evt', d: msg })
  }

  private send(env: Envelope): void {
    if (!this.channel) return
    this.channel.send({ type: 'broadcast', event: 'm', payload: env }).catch(() => undefined)
  }
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Deterministic room code from the unambiguous alphabet. */
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
