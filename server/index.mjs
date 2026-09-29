/**
 * Gulmohar Ground relay — one tiny Node process that
 *  - serves the static game build (`out/`, from `next build`)
 *  - runs the multiplayer rooms over WebSocket at /ws
 *  - answers GET /health (Render health check + the cron-job.org keep-alive)
 *
 * The server owns ROOMS (roster, host = oldest member, team balance, the
 * player cap, dead-connection cleanup) but no game logic: it relays each
 * client's messages to the rest of its room. The game's host-authority model
 * (ball, score, rules) lives in the host's browser exactly as before.
 *
 * Wire protocol (JSON text frames):
 *   client → server
 *     { t: 'join', room, id, name, team? }     join / re-join (same id = reconnect)
 *     { t: 'm', d }                            relay envelope to the room
 *     { t: 'presence', name?, team? }          update my roster entry
 *     { t: 'ping' }                            app-level keep-alive
 *   server → client
 *     { t: 'joined', id }                      join accepted
 *     { t: 'full', max }                       room full (socket then closes)
 *     { t: 'roster', roster }                  full roster, sorted, host first
 *     { t: 'm', d }                            relayed envelope
 *     { t: 'pong' }
 */
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT || 3001)
const MAX_PLAYERS = 10
const HEARTBEAT_MS = 5000
/**
 * Batching tick. Instead of forwarding every message to every player (N×N
 * socket writes — ~1,900/s at 10 players, which chokes a small free server),
 * each tick sends ONE packet per player holding everything new: the latest
 * pose of each other player, the latest ball, and every event/kick in order.
 */
const TICK_MS = 66
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'out')

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

// ------------------------------------------------------------------ static files
async function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let rel = normalize(urlPath).replace(/^([/\\])+/, '')
  if (rel.includes('..')) rel = ''
  const candidates = rel === '' ? ['index.html'] : [rel, `${rel}.html`, join(rel, 'index.html')]
  for (const c of candidates) {
    const file = join(ROOT, c)
    try {
      const s = await stat(file)
      if (!s.isFile()) continue
      const body = await readFile(file)
      const immutable = c.startsWith('_next/static')
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      })
      res.end(body)
      return
    } catch {
      /* try next */
    }
  }
  try {
    const body = await readFile(join(ROOT, '404.html'))
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('not found')
  }
}

const server = createServer((req, res) => {
  if (req.url === '/health' || req.url?.startsWith('/health?')) {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, players: countPlayers(), uptime: Math.round(process.uptime()) }))
    return
  }
  serveStatic(req, res).catch(() => {
    res.writeHead(500)
    res.end()
  })
})

// ------------------------------------------------------------------ rooms
/** @type {Map<string, Map<string, {ws: import('ws').WebSocket, id: string, name: string, team: 'A'|'B', joinedAt: number, lastPos: unknown}>>} */
const rooms = new Map()

function countPlayers() {
  let n = 0
  for (const r of rooms.values()) n += r.size
  return n
}

function rosterOf(room) {
  const list = [...room.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt || (a.id < b.id ? -1 : 1))
    .map((m, i) => ({ id: m.id, name: m.name, team: m.team, joinedAt: m.joinedAt, isHost: i === 0 }))
  return list
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj))
}

function broadcastRoster(code) {
  const room = rooms.get(code)
  if (!room) return
  const roster = rosterOf(room)
  for (const m of room.values()) send(m.ws, { t: 'roster', roster })
}

function clean(str, max) {
  return String(str ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, max)
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 })

wss.on('connection', (ws) => {
  ws.isAlive = true
  ws.on('pong', () => {
    ws.isAlive = true
  })
  /** @type {{code: string, id: string} | null} */
  let me = null

  const leave = () => {
    if (!me) return
    const room = rooms.get(me.code)
    const entry = room?.get(me.id)
    // only remove if this socket still owns the entry (a reconnect may have replaced it)
    if (room && entry && entry.ws === ws) {
      room.delete(me.id)
      if (room.size === 0) {
        rooms.delete(me.code)
        queues.delete(me.code)
      }
      else broadcastRoster(me.code)
    }
    me = null
  }

  ws.on('message', (raw) => {
    ws.isAlive = true
    let msg
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }
    if (!msg || typeof msg !== 'object') return

    if (msg.t === 'join') {
      const code = clean(msg.room, 8).toUpperCase()
      const id = clean(msg.id, 64)
      if (!code || !id) return
      let room = rooms.get(code)
      if (!room) {
        room = new Map()
        rooms.set(code, room)
      }
      const existing = room.get(id)
      if (!existing && room.size >= MAX_PLAYERS) {
        send(ws, { t: 'full', max: MAX_PLAYERS })
        ws.close(4001, 'room full')
        return
      }
      if (existing && existing.ws !== ws) {
        // reconnect: the new socket takes over the old seat (keeps join order + team)
        try {
          existing.ws.close(4002, 'replaced')
        } catch {
          /* already gone */
        }
      }
      let team = msg.team === 'B' ? 'B' : msg.team === 'A' ? 'A' : null
      if (!existing) {
        let a = 0
        let b = 0
        for (const m of room.values()) {
          if (m.team === 'A') a++
          else b++
        }
        if (team === null || (team === 'A' && a > b) || (team === 'B' && b > a)) team = a <= b ? 'A' : 'B'
      }
      const entry = {
        ws,
        id,
        name: clean(msg.name, 14) || 'Player',
        team: existing ? existing.team : team,
        joinedAt: existing ? existing.joinedAt : Date.now(),
        lastPos: existing ? existing.lastPos : null,
      }
      room.set(id, entry)
      me = { code, id }
      send(ws, { t: 'joined', id })
      // roster FIRST (the client ignores poses from players it doesn't know yet),
      // then everyone's last pose so nobody standing still is invisible
      broadcastRoster(code)
      for (const m of room.values()) {
        if (m.id !== id && m.lastPos) send(ws, { t: 'm', d: m.lastPos })
      }
      return
    }

    if (!me) return
    const room = rooms.get(me.code)
    const self = room?.get(me.id)
    if (!room || !self || self.ws !== ws) return

    if (msg.t === 'm') {
      const d = msg.d
      if (!d || typeof d !== 'object') return
      const q = queueOf(me.code)
      const str = JSON.stringify(d)
      if (d.k === 'pos') {
        // only the newest pose matters — older ones in the same tick are dropped
        self.lastPos = d
        q.pos.set(me.id, str)
      } else if (d.k === 'ball') {
        q.ball = { from: me.id, str }
      } else {
        q.ordered.push({ from: me.id, str })
      }
    } else if (msg.t === 'presence') {
      if (typeof msg.name === 'string') self.name = clean(msg.name, 14) || self.name
      if (msg.team === 'A' || msg.team === 'B') self.team = msg.team
      broadcastRoster(me.code)
    } else if (msg.t === 'teams') {
      // atomic team assignment — only the room's host (oldest member) may send it
      const host = rosterOf(room)[0]
      if (!host || host.id !== me.id || !msg.teams || typeof msg.teams !== 'object') return
      for (const [id, team] of Object.entries(msg.teams)) {
        const m = room.get(id)
        if (m && (team === 'A' || team === 'B')) m.team = team
      }
      broadcastRoster(me.code)
    } else if (msg.t === 'ping') {
      send(ws, { t: 'pong' })
    }
  })

  ws.on('close', leave)
  ws.on('error', leave)
})

// ------------------------------------------------------------------ batching
/** @type {Map<string, {pos: Map<string, string>, ball: {from: string, str: string} | null, ordered: Array<{from: string, str: string}>}>} */
const queues = new Map()

function queueOf(code) {
  let q = queues.get(code)
  if (!q) {
    q = { pos: new Map(), ball: null, ordered: [] }
    queues.set(code, q)
  }
  return q
}

setInterval(() => {
  for (const [code, q] of queues) {
    const room = rooms.get(code)
    if (!room) {
      queues.delete(code)
      continue
    }
    if (q.pos.size === 0 && !q.ball && q.ordered.length === 0) continue
    for (const m of room.values()) {
      if (m.ws.readyState !== 1) continue
      const parts = []
      for (const item of q.ordered) if (item.from !== m.id) parts.push(item.str)
      if (q.ball && q.ball.from !== m.id) parts.push(q.ball.str)
      for (const [from, str] of q.pos) if (from !== m.id) parts.push(str)
      if (parts.length === 0) continue
      // envelopes are already JSON — splice them in without re-encoding
      m.ws.send(`{"t":"b","m":[${parts.join(',')}]}`)
    }
    q.pos.clear()
    q.ball = null
    q.ordered.length = 0
  }
}, TICK_MS)

// dead-connection sweep: anything silent for two heartbeats is dropped
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate()
      continue
    }
    ws.isAlive = false
    try {
      ws.ping()
    } catch {
      /* closed */
    }
  }
}, HEARTBEAT_MS)

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[!] Port ${PORT} is already used by another program. Close it, or run with a different PORT.\n`)
    process.exit(1)
  }
  throw e
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Gulmohar Ground relay on :${PORT} (static from ${ROOT})`)
  if (process.env.LAN) {
    // LAN host: print every address friends on the same Wi-Fi can open
    // real Wi-Fi / Ethernet first; virtual adapters (WSL, Hyper-V, VMs, VPNs) last
    const virtual = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|Docker|TAP|Tailscale|ZeroTier|Npcap/i
    const real = []
    const other = []
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const a of list ?? []) {
        if (a.family !== 'IPv4' || a.internal) continue
        ;(virtual.test(name) ? other : real).push({ name, address: a.address })
      }
    }
    console.log('')
    console.log('  ===============================================')
    console.log('   LAN GAME IS UP. Friends on the same Wi-Fi open:')
    for (const a of real) console.log(`     http://${a.address}:${PORT}    (${a.name})`)
    if (other.length > 0) {
      console.log('   (virtual adapters — only if the above fails:')
      for (const a of other) console.log(`     http://${a.address}:${PORT}    (${a.name})`)
      console.log('   )')
    }
    console.log('   (you can use http://localhost:' + PORT + ')')
    console.log('   Keep this window open while you play.')
    console.log('  ===============================================')
    console.log('')
  }
})
