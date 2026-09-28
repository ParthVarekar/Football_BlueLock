/**
 * Manga overlay — the 2D "ink over paint" layer for EGO supers.
 *
 * Everything is drawn like a printed page laid over the golden-hour painting:
 * ink (#2f2823) on paper (#fbf3e2), halftone screentone, brush lettering,
 * focus lines. No glow, no neon — the same rule as the grade pass.
 *
 *  - cut-in panels: a slanted page panel slams across the screen with the
 *    caster's EGO eye (iris flash + the trailing light streak), the move's
 *    kanji in brush, its name in the house hand font
 *  - rival banner: a smaller slanted chip when someone ELSE fires a super
 *  - focus lines (集中線) and flight streaks
 *  - onomatopoeia (ドォン!!) pinned to world positions
 *  - Zero Hour clock dial, the sealed / caught / knocked-down status frames
 */
import type { SuperKind } from '../core/types'

type Ctx = CanvasRenderingContext2D

const INK = '#2f2823'
const PAPER = '#fbf3e2'
const PAPER_DEEP = '#f3e6cc'
const BRUSH = '"Yuji Syuku", "Yu Mincho", "Hiragino Mincho ProN", "Noto Serif JP", serif'
const HAND = '"Caveat", "Segoe Script", cursive'
const BODY = '"Karla", ui-sans-serif, system-ui, sans-serif'

export interface SuperStyle {
  kanji: string
  name: string
  tag: string
  accent: string
  accent2: string
}

/** Per-move identity: kanji, name, a one-line tag and the two accent inks. */
export const SUPER_STYLE: Record<SuperKind, SuperStyle> = {
  1: { kanji: '紅龍', name: 'Crimson Dragon', tag: 'no one stops this ball', accent: '#e8532f', accent2: '#c93b1f' },
  2: { kanji: '山壁', name: 'Mountain Bastion', tag: 'the ground answers', accent: '#c98a3a', accent2: '#8a5a30' },
  3: { kanji: '鷲爪', name: 'Eagle Talon', tag: 'from anywhere on the pitch', accent: '#2fa8a0', accent2: '#1f847d' },
  4: { kanji: '雷封', name: 'Thunder Seal', tag: 'nobody moves', accent: '#e9b73c', accent2: '#6c5bb5' },
  5: { kanji: '刻止', name: 'Zero Hour', tag: 'the world holds its breath', accent: '#8b6f4e', accent2: '#2f2823' },
  6: { kanji: '旋風', name: 'Gulmohar Cyclone', tag: 'everyone, over here', accent: '#f28a2e', accent2: '#e8532f' },
}

interface CutIn {
  kind: SuperKind
  who: string
  mine: boolean
  rival: boolean
  born: number
  dur: number
  art: HTMLCanvasElement | null
  artW: number
  artH: number
}

interface Sfx {
  text: string
  /** World anchor (projected every frame) or fixed screen position. */
  wx: number
  wy: number
  wz: number
  world: boolean
  sx: number
  sy: number
  size: number
  color: string
  rot: number
  born: number
  dur: number
}

/** Local-player status frames drawn around the edges. */
export interface LocalStatus {
  sealT: number
  knockT: number
  stopT: number
  stopBy: string
  grip: number
  zapT: number
  zapTotal: number
  glide: number
}

export type Projector = (x: number, y: number, z: number) => { x: number; y: number; visible: boolean }

const ease = {
  outBack: (t: number): number => {
    const c1 = 1.9
    const c3 = c1 + 1
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
  },
  outCubic: (t: number): number => 1 - Math.pow(1 - t, 3),
  inCubic: (t: number): number => t * t * t,
}
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** Seeded jitter so the ink lines wobble consistently within one frame. */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export class MangaOverlay {
  private readonly ctx: Ctx | null
  private w = 0
  private h = 0
  private dpr = 1
  private cutins: CutIn[] = []
  private sfx: Sfx[] = []
  /** Focus-line intensity (decays) + a sustained floor set per frame. */
  private focus = 0
  private focusHold = 0
  private focusColor = INK
  private streak = 0
  private streakHold = 0
  /** Zero Hour dial: start/end times + who. */
  private clockStart = -1
  private clockEnd = -1
  private clockMine = false
  private clockWho = ''
  private shatterAt = -1
  private frame = 0

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')
    // warm the brush font so the first cut-in has it (subset loaded by layout)
    if (typeof document !== 'undefined' && document.fonts?.load) {
      document.fonts.load('64px "Yuji Syuku"', '紅龍山壁鷲爪雷封刻止旋風ドォンゴバリシュカチオ').catch(() => undefined)
      document.fonts.load('700 40px "Caveat"').catch(() => undefined)
    }
  }

  // ---------------------------------------------------------------- triggers

  /** A super goes off. `mine` = my own (full panel); others get the rival chip. */
  cutIn(kind: SuperKind, who: string, mine: boolean, rival: boolean, now: number): void {
    const dur = mine ? 1.3 : 1.7
    const c: CutIn = { kind, who, mine, rival, born: now, dur, art: null, artW: 0, artH: 0 }
    this.cutins = this.cutins.filter((x) => x.mine !== mine)
    this.cutins.push(c)
    if (mine) this.pulseFocus(1, SUPER_STYLE[kind].accent2)
  }

  /** Onomatopoeia pinned to a world point. */
  sfxAt(text: string, x: number, y: number, z: number, now: number, opts: { size?: number; color?: string; dur?: number } = {}): void {
    this.sfx.push({
      text,
      wx: x,
      wy: y,
      wz: z,
      world: true,
      sx: 0,
      sy: 0,
      size: opts.size ?? 1,
      color: opts.color ?? PAPER,
      rot: (Math.random() - 0.5) * 0.35,
      born: now,
      dur: opts.dur ?? 1.1,
    })
    if (this.sfx.length > 10) this.sfx.shift()
  }

  /** Onomatopoeia at a fixed screen fraction (0..1). */
  sfxScreen(text: string, fx: number, fy: number, now: number, opts: { size?: number; color?: string; dur?: number } = {}): void {
    this.sfx.push({
      text,
      wx: 0,
      wy: 0,
      wz: 0,
      world: false,
      sx: fx,
      sy: fy,
      size: opts.size ?? 1,
      color: opts.color ?? PAPER,
      rot: (Math.random() - 0.5) * 0.3,
      born: now,
      dur: opts.dur ?? 1.1,
    })
    if (this.sfx.length > 10) this.sfx.shift()
  }

  /** Burst of focus lines that decays (0..1). */
  pulseFocus(amount: number, color = INK): void {
    this.focus = Math.max(this.focus, amount)
    this.focusColor = color
  }

  /** Sustained focus lines this frame (dragon flight, eagle glide, zap). */
  holdFocus(amount: number, color = INK): void {
    this.focusHold = Math.max(this.focusHold, amount)
    this.focusColor = color
  }

  /** Sustained horizontal motion streaks this frame (glides, dashes). */
  holdStreaks(amount: number): void {
    this.streakHold = Math.max(this.streakHold, amount)
  }

  pulseStreaks(amount: number): void {
    this.streak = Math.max(this.streak, amount)
  }

  startClock(now: number, dur: number, mine: boolean, who: string): void {
    this.clockStart = now
    this.clockEnd = now + dur
    this.clockMine = mine
    this.clockWho = who
    this.shatterAt = -1
  }

  endClock(now: number): void {
    if (this.clockStart < 0) return
    this.clockStart = -1
    this.shatterAt = now
  }

  /** 0..1 cut-in presence (the grade pass tightens its vignette with it). */
  focusAmount(now: number): number {
    let f = 0
    for (const c of this.cutins) {
      if (!c.mine) continue
      const u = (now - c.born) / c.dur
      if (u >= 0 && u <= 1) f = Math.max(f, Math.sin(Math.min(1, u * 1.2) * Math.PI))
    }
    return f
  }

  clear(): void {
    this.cutins = []
    this.sfx = []
    this.focus = 0
    this.streak = 0
    this.clockStart = -1
    this.shatterAt = -1
  }

  // ---------------------------------------------------------------- frame

  draw(now: number, dt: number, project: Projector, status: LocalStatus | null, active: boolean): void {
    const ctx = this.ctx
    if (!ctx) return
    const cw = this.canvas.clientWidth
    const ch = this.canvas.clientHeight
    if (cw === 0 || ch === 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    if (this.canvas.width !== Math.round(cw * dpr) || this.canvas.height !== Math.round(ch * dpr)) {
      this.canvas.width = Math.round(cw * dpr)
      this.canvas.height = Math.round(ch * dpr)
    }
    this.w = cw
    this.h = ch
    this.dpr = dpr
    this.frame++
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)
    if (!active) {
      this.focusHold = 0
      this.streakHold = 0
      return
    }

    // decay the pulses; holds are per-frame floors
    this.focus = Math.max(0, this.focus - dt * 1.6)
    this.streak = Math.max(0, this.streak - dt * 2.2)
    const focus = Math.max(this.focus, this.focusHold)
    const streak = Math.max(this.streak, this.streakHold)
    this.focusHold = 0
    this.streakHold = 0

    if (status) this.drawStatus(ctx, now, status)
    if (streak > 0.02) this.drawStreaks(ctx, streak)
    if (focus > 0.02) this.drawFocusLines(ctx, focus, this.focusColor)
    this.drawClock(ctx, now)
    this.drawSfx(ctx, now, project)
    this.cutins = this.cutins.filter((c) => now - c.born < c.dur)
    for (const c of this.cutins) {
      if (c.mine) this.drawCutIn(ctx, c, now)
      else this.drawRivalChip(ctx, c, now)
    }
  }

  // ---------------------------------------------------------------- focus lines

  /** 集中線: ink wedges converging on the centre, re-jittered every frame. */
  private drawFocusLines(ctx: Ctx, amount: number, color: string): void {
    const { w, h } = this
    const cx = w / 2
    const cy = h / 2
    const R = Math.hypot(w, h) * 0.62
    const r = rng(this.frame * 7919)
    const n = Math.round(46 + 44 * amount)
    ctx.save()
    ctx.globalAlpha = Math.min(0.5, 0.12 + amount * 0.38)
    ctx.fillStyle = color
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + (r() - 0.5) * 0.09
      const inner = R * (0.42 + r() * 0.3 - amount * 0.12)
      const wdt = (0.004 + r() * 0.012) * (0.6 + amount)
      ctx.beginPath()
      ctx.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner)
      ctx.lineTo(cx + Math.cos(a - wdt) * R, cy + Math.sin(a - wdt) * R)
      ctx.lineTo(cx + Math.cos(a + wdt) * R, cy + Math.sin(a + wdt) * R)
      ctx.closePath()
      ctx.fill()
    }
    ctx.restore()
  }

  /** Horizontal-ish speed streaks (paper + ink) for glides and dashes. */
  private drawStreaks(ctx: Ctx, amount: number): void {
    const { w, h } = this
    const r = rng(this.frame * 104729)
    ctx.save()
    ctx.lineCap = 'round'
    const n = Math.round(10 + 26 * amount)
    for (let i = 0; i < n; i++) {
      const y = r() * h
      const edge = Math.abs(y / h - 0.5) * 2
      if (edge < 0.25 && r() < 0.7) continue // keep the centre readable
      const len = w * (0.12 + r() * 0.35) * amount
      const x = r() < 0.5 ? -20 + r() * w * 0.25 : w - r() * w * 0.25 - len
      ctx.globalAlpha = (0.25 + r() * 0.5) * amount
      ctx.strokeStyle = r() < 0.6 ? PAPER : INK
      ctx.lineWidth = 1 + r() * 2.4
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + len, y + (r() - 0.5) * 6)
      ctx.stroke()
    }
    ctx.restore()
  }

  // ---------------------------------------------------------------- cut-in

  /** Paint the static panel art once per cut-in (halftone, eye, lettering). */
  private buildArt(c: CutIn, pw: number, ph: number): void {
    const st = SUPER_STYLE[c.kind]
    const s = this.dpr
    const cv = document.createElement('canvas')
    cv.width = Math.max(2, Math.round(pw * s))
    cv.height = Math.max(2, Math.round(ph * s))
    const g = cv.getContext('2d')
    if (!g) return
    g.scale(s, s)
    // paper ground with an accent wash toward the eye side
    const grd = g.createLinearGradient(0, 0, pw, 0)
    grd.addColorStop(0, st.accent)
    grd.addColorStop(0.42, PAPER_DEEP)
    grd.addColorStop(1, PAPER)
    g.fillStyle = grd
    g.fillRect(0, 0, pw, ph)

    // screentone: halftone dots fading across the panel
    g.fillStyle = st.accent2
    const step = 9
    for (let y = step / 2; y < ph; y += step) {
      for (let x = step / 2 + ((y / step) % 2) * (step / 2); x < pw; x += step) {
        const k = Math.max(0, 1 - x / (pw * 0.62))
        const rad = k * k * step * 0.46
        if (rad < 0.4) continue
        g.globalAlpha = 0.55
        g.beginPath()
        g.arc(x, y, rad, 0, Math.PI * 2)
        g.fill()
      }
    }
    g.globalAlpha = 1

    // horizontal speed hatching behind the lettering
    const r = rng(c.kind * 7331 + 17)
    g.strokeStyle = INK
    g.lineCap = 'round'
    for (let i = 0; i < 26; i++) {
      const y = r() * ph
      const x0 = pw * (0.35 + r() * 0.2)
      g.globalAlpha = 0.08 + r() * 0.14
      g.lineWidth = 1 + r() * 2
      g.beginPath()
      g.moveTo(x0, y)
      g.lineTo(pw, y)
      g.stroke()
    }
    g.globalAlpha = 1

    // the EGO eye
    const eyeW = Math.min(pw * 0.34, ph * 1.55)
    drawEgoEye(g, pw * 0.2, ph * 0.52, eyeW, st.accent, st.accent2)

    // kanji — huge brush, paper stroke under ink
    const kSize = Math.min(ph * 0.66, pw * 0.13)
    g.font = `${kSize}px ${BRUSH}`
    g.textBaseline = 'middle'
    g.textAlign = 'left'
    const kx = pw * 0.44
    const ky = ph * 0.43
    g.lineJoin = 'round'
    g.lineWidth = kSize * 0.14
    g.strokeStyle = PAPER
    g.strokeText(st.kanji, kx, ky)
    g.fillStyle = INK
    g.fillText(st.kanji, kx, ky)
    const kw = g.measureText(st.kanji).width

    // move name — house hand, accent fill with ink outline
    const nSize = Math.min(ph * 0.26, pw * 0.055)
    g.font = `700 ${nSize}px ${HAND}`
    g.lineWidth = nSize * 0.2
    g.strokeStyle = INK
    const nx = kx + Math.min(kw + 18, pw * 0.3)
    g.strokeText(st.name.toUpperCase(), nx, ph * 0.33)
    g.fillStyle = st.accent
    g.fillText(st.name.toUpperCase(), nx, ph * 0.33)
    // tag + caster
    const tSize = Math.max(11, nSize * 0.42)
    g.font = `800 ${tSize}px ${BODY}`
    g.fillStyle = INK
    g.globalAlpha = 0.8
    g.fillText(`— ${st.tag}`, nx + 4, ph * 0.33 + nSize * 0.78)
    g.globalAlpha = 1
    g.font = `800 ${Math.max(10, tSize * 0.9)}px ${BODY}`
    g.fillStyle = st.accent2
    const egoLabel = `EGO · ${c.who.toUpperCase()}`
    g.fillText(egoLabel, kx + 4, ph * 0.86)

    // panel border — heavy ink
    g.strokeStyle = INK
    g.lineWidth = 5
    g.strokeRect(2.5, 2.5, pw - 5, ph - 5)
    c.art = cv
    c.artW = pw
    c.artH = ph
  }

  private drawCutIn(ctx: Ctx, c: CutIn, now: number): void {
    const { w, h } = this
    const t = now - c.born
    const u = t / c.dur
    const pw = w * 1.18
    const ph = Math.max(84, Math.min(h * 0.17, 150))
    if (!c.art || Math.abs(c.artW - pw) > 2 || Math.abs(c.artH - ph) > 2) this.buildArt(c, pw, ph)
    const st = SUPER_STYLE[c.kind]

    // letterbox bars
    const bar = Math.min(1, t / 0.14) * (u > 0.82 ? 1 - (u - 0.82) / 0.18 : 1)
    ctx.save()
    ctx.fillStyle = INK
    ctx.globalAlpha = 0.6
    ctx.fillRect(0, 0, w, h * 0.04 * bar)
    ctx.fillRect(0, h - h * 0.04 * bar, w, h * 0.04 * bar)
    ctx.restore()

    // slam in from the right with an overshoot, drift, then slice out left
    const inT = clamp01(t / 0.2)
    const outT = clamp01((u - 0.78) / 0.22)
    const slide = (1 - ease.outBack(inT)) * w * 1.1 - ease.inCubic(outT) * w * 1.3 - t * 16
    const cy = h * 0.2
    const skew = -0.16
    ctx.save()
    ctx.globalAlpha = 0.78
    ctx.translate(w / 2 + slide, cy)
    ctx.transform(1, skew * 0.35, 0, 1, 0, 0)
    ctx.rotate(-0.05)
    // drop shadow slab in the accent, offset
    ctx.fillStyle = st.accent2
    ctx.globalAlpha = 0.6
    ctx.fillRect(-pw / 2 + 12, -ph / 2 + 12, pw, ph)
    ctx.globalAlpha = 0.78
    if (c.art) ctx.drawImage(c.art, -pw / 2, -ph / 2, pw, ph)
    // live streaks across the panel
    const r = rng(this.frame * 31 + c.kind)
    ctx.strokeStyle = PAPER
    ctx.lineCap = 'round'
    for (let i = 0; i < 7; i++) {
      const y = -ph / 2 + r() * ph
      const x = -pw / 2 + r() * pw
      ctx.globalAlpha = 0.35 + r() * 0.35
      ctx.lineWidth = 1.5 + r() * 2
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + 60 + r() * 160, y)
      ctx.stroke()
    }
    ctx.restore()
  }

  /** Someone else fired a super — a slanted chip under the score. */
  private drawRivalChip(ctx: Ctx, c: CutIn, now: number): void {
    const st = SUPER_STYLE[c.kind]
    const { w, h } = this
    const t = now - c.born
    const u = t / c.dur
    const inT = ease.outBack(clamp01(t / 0.22))
    const alpha = (u > 0.85 ? 1 - (u - 0.85) / 0.15 : 1) * 0.75
    const cw = Math.min(w * 0.6, 330)
    const chh = 46
    const x = w / 2 - cw / 2 + (1 - inT) * -w * 0.6
    const y = h * 0.14
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(x, y)
    ctx.transform(1, 0, -0.18, 1, 0, 0)
    ctx.fillStyle = INK
    ctx.fillRect(6, 6, cw, chh)
    ctx.fillStyle = c.rival ? st.accent : PAPER
    ctx.fillRect(0, 0, cw, chh)
    ctx.strokeStyle = INK
    ctx.lineWidth = 3
    ctx.strokeRect(0, 0, cw, chh)
    // kanji block
    ctx.fillStyle = INK
    ctx.fillRect(0, 0, chh * 1.5, chh)
    ctx.font = `${chh * 0.62}px ${BRUSH}`
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'center'
    ctx.fillStyle = PAPER
    ctx.fillText(st.kanji, chh * 0.75, chh * 0.52)
    ctx.textAlign = 'left'
    ctx.font = `700 ${chh * 0.46}px ${HAND}`
    ctx.lineWidth = 4
    ctx.strokeStyle = INK
    ctx.lineJoin = 'round'
    const label = st.name.toUpperCase()
    ctx.strokeText(label, chh * 1.5 + 14, chh * 0.4)
    ctx.fillStyle = PAPER
    ctx.fillText(label, chh * 1.5 + 14, chh * 0.4)
    ctx.font = `800 12px ${BODY}`
    ctx.fillStyle = INK
    ctx.fillText(`${c.who}${c.rival ? ' · RIVAL EGO!' : ' · teammate'}`, chh * 1.5 + 16, chh * 0.8)
    ctx.restore()
  }

  // ---------------------------------------------------------------- sfx

  private drawSfx(ctx: Ctx, now: number, project: Projector): void {
    this.sfx = this.sfx.filter((s) => now - s.born < s.dur)
    for (const s of this.sfx) {
      let x: number
      let y: number
      if (s.world) {
        const p = project(s.wx, s.wy, s.wz)
        if (!p.visible) continue
        x = p.x
        y = p.y
      } else {
        x = s.sx * this.w
        y = s.sy * this.h
      }
      const t = (now - s.born) / s.dur
      const pop = t < 0.14 ? ease.outBack(t / 0.14) : 1
      const alpha = (t > 0.7 ? 1 - (t - 0.7) / 0.3 : 1) * 0.72
      const size = Math.min(this.h * 0.1, 44 + 26 * s.size) * s.size * pop
      const shake = t < 0.35 ? (1 - t / 0.35) * 5 : 0
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.translate(x + (Math.random() - 0.5) * shake, y + (Math.random() - 0.5) * shake - t * 18)
      ctx.rotate(s.rot)
      ctx.font = `${size}px ${BRUSH}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineJoin = 'round'
      ctx.lineWidth = size * 0.2
      ctx.strokeStyle = INK
      ctx.strokeText(s.text, 0, 0)
      ctx.fillStyle = s.color
      ctx.fillText(s.text, 0, 0)
      ctx.restore()
    }
  }

  // ---------------------------------------------------------------- Zero Hour

  private drawClock(ctx: Ctx, now: number): void {
    const { w, h } = this
    const cx = w / 2
    const cy = h / 2
    const R = Math.min(w, h) * 0.36
    if (this.clockStart >= 0) {
      const t = now - this.clockStart
      const dur = this.clockEnd - this.clockStart
      const remain = Math.max(0, this.clockEnd - now)
      // shockwave ring sweeping out on the stop
      if (t < 0.6) {
        const k = ease.outCubic(t / 0.6)
        ctx.save()
        ctx.strokeStyle = INK
        ctx.globalAlpha = 1 - k
        ctx.lineWidth = 14 * (1 - k) + 2
        ctx.beginPath()
        ctx.arc(cx, cy, Math.hypot(w, h) * 0.6 * k, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }
      const appear = ease.outCubic(clamp01(t / 0.45))
      ctx.save()
      ctx.globalAlpha = 0.3 * appear
      ctx.translate(cx, cy)
      ctx.scale(0.8 + 0.2 * appear, 0.8 + 0.2 * appear)
      ctx.strokeStyle = INK
      ctx.fillStyle = INK
      // double ring
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.arc(0, 0, R, 0, Math.PI * 2)
      ctx.stroke()
      ctx.lineWidth = 1.2
      ctx.beginPath()
      ctx.arc(0, 0, R * 0.93, 0, Math.PI * 2)
      ctx.stroke()
      // ticks + numerals
      const numerals = ['XII', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI']
      ctx.font = `700 ${Math.max(12, R * 0.09)}px ${HAND}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      for (let i = 0; i < 60; i++) {
        const a = (i / 60) * Math.PI * 2 - Math.PI / 2
        const major = i % 5 === 0
        const r0 = R * (major ? 0.84 : 0.89)
        ctx.lineWidth = major ? 3 : 1
        ctx.beginPath()
        ctx.moveTo(Math.cos(a) * r0, Math.sin(a) * r0)
        ctx.lineTo(Math.cos(a) * R * 0.93, Math.sin(a) * R * 0.93)
        ctx.stroke()
        if (major) ctx.fillText(numerals[i / 5], Math.cos(a) * R * 0.74, Math.sin(a) * R * 0.74)
      }
      // hands: the minute hand crawls BACKWARD, the second hand is stuck
      // twitching on one tick — time is held, not running
      const back = -t * 0.9
      const twitch = Math.sin(now * 38) * 0.02
      ctx.lineCap = 'round'
      ctx.lineWidth = 6
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(Math.cos(back - Math.PI / 2) * R * 0.62, Math.sin(back - Math.PI / 2) * R * 0.62)
      ctx.stroke()
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(0, 0)
      ctx.lineTo(Math.cos(0.9 + twitch) * R * 0.8, Math.sin(0.9 + twitch) * R * 0.8)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(0, 0, 7, 0, Math.PI * 2)
      ctx.fill()
      // remaining-time arc
      ctx.globalAlpha = 0.85 * appear
      ctx.lineWidth = 7
      ctx.strokeStyle = INK
      ctx.beginPath()
      ctx.arc(0, 0, R * 1.06, -Math.PI / 2, -Math.PI / 2 + (remain / Math.max(0.01, dur)) * Math.PI * 2)
      ctx.stroke()
      ctx.restore()

      // stamp
      ctx.save()
      ctx.globalAlpha = appear * 0.7
      ctx.translate(w * 0.5, h * 0.12)
      ctx.rotate(-0.04)
      ctx.font = `${Math.min(38, h * 0.05)}px ${BRUSH}`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.lineWidth = 10
      ctx.lineJoin = 'round'
      ctx.strokeStyle = PAPER
      const label = this.clockMine ? '刻止 — ZERO HOUR' : `刻止 — ${this.clockWho.toUpperCase()} STOPPED TIME`
      ctx.strokeText(label, 0, 0)
      ctx.fillStyle = INK
      ctx.fillText(label, 0, 0)
      ctx.font = `700 ${Math.min(40, h * 0.05)}px ${HAND}`
      ctx.lineWidth = 6
      ctx.strokeText(remain.toFixed(1), 0, h * 0.07)
      ctx.fillText(remain.toFixed(1), 0, h * 0.07)
      ctx.restore()
    }

    // time resumes: the dial shatters into ink shards
    if (this.shatterAt >= 0) {
      const t = (now - this.shatterAt) / 0.6
      if (t >= 1) {
        this.shatterAt = -1
        return
      }
      const r = rng(4242)
      ctx.save()
      ctx.strokeStyle = INK
      ctx.globalAlpha = 1 - t
      ctx.lineWidth = 3
      for (let i = 0; i < 28; i++) {
        const a = r() * Math.PI * 2
        const d0 = R * (0.3 + r() * 0.8) + t * R * (0.8 + r())
        const len = 20 + r() * 50
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(a) * d0, cy + Math.sin(a) * d0)
        ctx.lineTo(cx + Math.cos(a + 0.05) * (d0 + len), cy + Math.sin(a + 0.05) * (d0 + len))
        ctx.stroke()
      }
      ctx.restore()
    }
  }

  // ---------------------------------------------------------------- statuses

  private drawStatus(ctx: Ctx, now: number, s: LocalStatus): void {
    const { w, h } = this
    // sealed: ink lightning crawling round the frame + stamp
    if (s.sealT > 0) {
      const r = rng(Math.floor(now * 14) * 13)
      ctx.save()
      ctx.lineJoin = 'miter'
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass === 0 ? INK : '#f6d46a'
        ctx.lineWidth = pass === 0 ? 6 : 2.2
        for (let i = 0; i < 6; i++) {
          const side = i % 4
          ctx.beginPath()
          let x = side === 0 ? r() * w : side === 1 ? w - 8 : side === 2 ? r() * w : 8
          let y = side === 0 ? 8 : side === 1 ? r() * h : side === 2 ? h - 8 : r() * h
          ctx.moveTo(x, y)
          for (let k = 0; k < 6; k++) {
            x += side % 2 === 0 ? 30 + r() * 40 : (r() - 0.5) * 40 + (side === 1 ? -14 : 14)
            y += side % 2 === 0 ? (r() - 0.5) * 40 + (side === 0 ? 12 : -12) : 30 + r() * 40
            ctx.lineTo(x, y)
          }
          ctx.stroke()
        }
      }
      ctx.restore()
      this.stamp(ctx, `雷封  SEALED ${s.sealT.toFixed(1)}`, w / 2, h * 0.78, '#f6d46a')
    }
    if (s.knockT > 0) {
      this.stamp(ctx, 'DOWN!', w / 2, h * 0.3, PAPER)
    }
    if (s.grip > 0.25) {
      // caught in the cyclone: swirl strokes wheeling round the centre
      ctx.save()
      ctx.translate(w / 2, h / 2)
      ctx.rotate(now * 3.2)
      ctx.strokeStyle = INK
      ctx.lineCap = 'round'
      for (let i = 0; i < 9; i++) {
        const a = (i / 9) * Math.PI * 2
        const rr = Math.min(w, h) * (0.32 + (i % 3) * 0.08)
        ctx.globalAlpha = 0.25 * s.grip
        ctx.lineWidth = 3 + (i % 3) * 2
        ctx.beginPath()
        ctx.arc(0, 0, rr, a, a + 0.8)
        ctx.stroke()
      }
      ctx.restore()
    }
    if (s.zapT > 0) {
      // zapping through stopped time: a thin ink frame + corner brackets
      const k = Math.min(1, s.zapT / 0.3)
      ctx.save()
      ctx.globalAlpha = 0.7 * k
      ctx.strokeStyle = INK
      ctx.lineWidth = 4
      const m = 14
      const L = Math.min(w, h) * 0.08
      for (const [x, y, dx, dy] of [
        [m, m, 1, 1],
        [w - m, m, -1, 1],
        [m, h - m, 1, -1],
        [w - m, h - m, -1, -1],
      ] as const) {
        ctx.beginPath()
        ctx.moveTo(x, y + dy * L)
        ctx.lineTo(x, y)
        ctx.lineTo(x + dx * L, y)
        ctx.stroke()
      }
      ctx.restore()
    }
  }

  private stamp(ctx: Ctx, text: string, x: number, y: number, fill: string): void {
    ctx.save()
    ctx.globalAlpha = 0.7
    ctx.translate(x, y)
    ctx.rotate(-0.05)
    ctx.font = `${Math.min(30, this.h * 0.04)}px ${BRUSH}`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    ctx.lineWidth = 9
    ctx.strokeStyle = INK
    ctx.strokeText(text, 0, 0)
    ctx.fillStyle = fill
    ctx.fillText(text, 0, 0)
    ctx.restore()
  }
}

/**
 * The Blue Lock EGO eye: an almond ink eye, accent iris with radial
 * striations, and the sharp light streak trailing off the glint.
 */
function drawEgoEye(g: Ctx, x: number, y: number, width: number, accent: string, accent2: string): void {
  const s = width / 2
  g.save()
  g.translate(x, y)
  g.scale(s, s)
  // light streak (behind the eye, trailing right)
  g.fillStyle = PAPER
  g.strokeStyle = accent2
  g.lineWidth = 0.025
  g.beginPath()
  g.moveTo(0.18, -0.26)
  g.lineTo(2.9, -0.5)
  g.lineTo(2.9, -0.43)
  g.lineTo(0.3, -0.12)
  g.closePath()
  g.fill()
  g.stroke()
  g.beginPath()
  g.moveTo(0.22, -0.1)
  g.lineTo(2.2, -0.05)
  g.lineTo(0.28, -0.02)
  g.closePath()
  g.fill()
  g.stroke()

  // brow slash
  g.fillStyle = INK
  g.beginPath()
  g.moveTo(-1.05, -0.78)
  g.quadraticCurveTo(0.1, -1.2, 1.15, -0.86)
  g.lineTo(1.05, -0.74)
  g.quadraticCurveTo(0.05, -1.0, -0.98, -0.66)
  g.closePath()
  g.fill()

  // almond
  const almond = new Path2D()
  almond.moveTo(-1, 0.05)
  almond.bezierCurveTo(-0.55, -0.62, 0.45, -0.72, 1.05, -0.12)
  almond.bezierCurveTo(0.55, 0.36, -0.5, 0.42, -1, 0.05)
  g.fillStyle = PAPER
  g.fill(almond)
  g.save()
  g.clip(almond)
  // iris
  g.fillStyle = accent
  g.beginPath()
  g.arc(0.04, -0.1, 0.38, 0, Math.PI * 2)
  g.fill()
  g.strokeStyle = accent2
  g.lineWidth = 0.03
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2
    g.beginPath()
    g.moveTo(0.04 + Math.cos(a) * 0.16, -0.1 + Math.sin(a) * 0.16)
    g.lineTo(0.04 + Math.cos(a) * 0.36, -0.1 + Math.sin(a) * 0.36)
    g.stroke()
  }
  g.lineWidth = 0.05
  g.strokeStyle = INK
  g.beginPath()
  g.arc(0.04, -0.1, 0.38, 0, Math.PI * 2)
  g.stroke()
  // pupil
  g.fillStyle = INK
  g.beginPath()
  g.arc(0.04, -0.1, 0.15, 0, Math.PI * 2)
  g.fill()
  // lid shadow
  g.fillStyle = 'rgba(47,40,35,0.35)'
  g.beginPath()
  g.moveTo(-1, 0.05)
  g.bezierCurveTo(-0.55, -0.62, 0.45, -0.72, 1.05, -0.12)
  g.lineTo(1.05, -0.3)
  g.bezierCurveTo(0.45, -0.5, -0.55, -0.42, -1, -0.1)
  g.closePath()
  g.fill()
  // glint
  g.fillStyle = PAPER
  g.beginPath()
  g.arc(0.2, -0.24, 0.085, 0, Math.PI * 2)
  g.fill()
  g.beginPath()
  g.arc(-0.1, 0.04, 0.04, 0, Math.PI * 2)
  g.fill()
  g.restore()
  // lash line (heavy) + lower lid (light)
  g.strokeStyle = INK
  g.lineCap = 'round'
  g.lineWidth = 0.1
  g.beginPath()
  g.moveTo(-1.02, 0.07)
  g.bezierCurveTo(-0.55, -0.62, 0.45, -0.72, 1.12, -0.14)
  g.stroke()
  g.lineWidth = 0.035
  g.beginPath()
  g.moveTo(1.05, -0.12)
  g.bezierCurveTo(0.55, 0.36, -0.5, 0.42, -1, 0.05)
  g.stroke()
  // under-eye hatching
  g.lineWidth = 0.022
  for (let i = 0; i < 5; i++) {
    g.beginPath()
    g.moveTo(-0.5 + i * 0.16, 0.42)
    g.lineTo(-0.42 + i * 0.16, 0.3)
    g.stroke()
  }
  g.restore()
}
