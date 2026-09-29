'use client'

/**
 * Touch controls, laid out for two thumbs in landscape:
 *  - LEFT half: a floating joystick — it appears wherever your thumb lands;
 *    pushing it to the rim auto-sprints (no RUN button to hold)
 *  - RIGHT half: drag anywhere to look; a big KICK sits in the corner with the
 *    skill buttons fanned in an arc around it, all within thumb reach
 *  - TRICKS and EGO open trays, so the screen stays clear while you play
 * Portrait shows a rotate hint — the game is built for landscape.
 */
import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { GameHandle } from '../Game'
import type { SuperKind, UiState } from '../core/types'
import { SUPER_STYLE } from '../render/mangaOverlay'
import { SUPER } from '../core/constants'

const LOOK_SCALE = 2.4 // touch pixels → mouse-like deltas
const JOY_R = 58 // joystick travel radius (px)
const SPRINT_AT = 0.92 // stick deflection that switches on sprint

const SUPER_NAMES: Record<SuperKind, string> = {
  1: 'Dragon',
  2: 'Mountain',
  3: 'Eagle',
  4: 'Thunder',
  5: 'Zero Hour',
  6: 'Cyclone',
}
const SUPER_COSTS: Record<SuperKind, number> = {
  1: SUPER.dragon.cost,
  2: SUPER.mountain.cost,
  3: SUPER.eagle.cost,
  4: SUPER.thunder.cost,
  5: SUPER.timeStop.cost,
  6: SUPER.cyclone.cost,
}

/** Fire-on-press button props (no ghost clicks, no context menu, no look-drag underneath). */
function press(run: () => void) {
  return {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      run()
    },
    onContextMenu: (e: React.SyntheticEvent) => e.preventDefault(),
  }
}

export function TouchControls({ game, snap }: { game: GameHandle; snap: UiState }) {
  // ------------------------------------------------------------- floating joystick
  const [joy, setJoy] = useState<{ active: boolean; ox: number; oy: number; x: number; y: number }>({
    active: false,
    ox: 0,
    oy: 0,
    x: 0,
    y: 0,
  })
  const joyId = useRef<number | null>(null)
  const origin = useRef({ x: 0, y: 0 })

  const onJoyDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (joyId.current !== null) return
    joyId.current = e.pointerId
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    origin.current = { x: e.clientX, y: e.clientY }
    setJoy({ active: true, ox: e.clientX, oy: e.clientY, x: 0, y: 0 })
  }
  const onJoyMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (joyId.current !== e.pointerId) return
    let dx = (e.clientX - origin.current.x) / JOY_R
    let dy = (e.clientY - origin.current.y) / JOY_R
    const l = Math.hypot(dx, dy)
    if (l > 1) {
      // drag past the rim: the base follows the thumb, so you never "run out" of stick
      origin.current.x += (dx / l) * (l - 1) * JOY_R
      origin.current.y += (dy / l) * (l - 1) * JOY_R
      dx /= l
      dy /= l
    }
    setJoy({ active: true, ox: origin.current.x, oy: origin.current.y, x: dx, y: dy })
    game.input.setTouchMove(dx, -dy)
    game.input.setTouchSprint(Math.hypot(dx, dy) >= SPRINT_AT)
  }
  const onJoyUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (joyId.current !== e.pointerId) return
    joyId.current = null
    setJoy((j) => ({ ...j, active: false, x: 0, y: 0 }))
    game.input.setTouchMove(0, 0)
    game.input.setTouchSprint(false)
  }

  // ------------------------------------------------------------- look drag (right half)
  const lookId = useRef<number | null>(null)
  const lookLast = useRef<{ x: number; y: number } | null>(null)
  const onLookDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (lookId.current !== null) return
    lookId.current = e.pointerId
    lookLast.current = { x: e.clientX, y: e.clientY }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onLookMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (lookId.current !== e.pointerId || !lookLast.current) return
    const dx = e.clientX - lookLast.current.x
    const dy = e.clientY - lookLast.current.y
    lookLast.current = { x: e.clientX, y: e.clientY }
    game.input.addTouchLook(dx * LOOK_SCALE, dy * LOOK_SCALE)
  }
  const onLookUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (lookId.current !== e.pointerId) return
    lookId.current = null
    lookLast.current = null
  }

  // ------------------------------------------------------------- kick (hold to charge)
  const [charging, setCharging] = useState(false)
  const kickProps = {
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault()
      e.stopPropagation()
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
      setCharging(true)
      game.input.setTouchCharge(true)
    },
    onPointerUp: () => {
      setCharging(false)
      game.input.setTouchCharge(false)
    },
    onPointerCancel: () => {
      setCharging(false)
      game.input.setTouchCharge(false)
    },
    onContextMenu: (e: React.SyntheticEvent) => e.preventDefault(),
  }

  const [tray, setTray] = useState<'none' | 'tricks' | 'ego'>('none')
  const ego = snap.ego
  const egoPct = Math.round(ego.fill * 100)

  // skill arc around KICK: angles measured from the kick centre, fanning up-left
  const arc: Array<{ label: string; run: () => void; angle: number }> = [
    { label: 'CUT', run: () => game.input.triggerCut(), angle: 178 },
    { label: 'FLICK', run: () => game.input.triggerFlick(), angle: 212 },
    { label: 'STEP', run: () => game.input.triggerStep(), angle: 246 },
    { label: 'SLIDE', run: () => game.input.triggerSlide(), angle: 280 },
  ]
  const ARC_R = 124

  return (
    <>
      {/* portrait: ask for landscape */}
      <div className="gg-rotate-hint pointer-events-none absolute inset-x-0 top-1/3 z-40 hidden justify-center">
        <div className="gg-chip font-hand text-xl font-bold">Turn your phone sideways ↻</div>
      </div>

      {/* LEFT: floating joystick zone */}
      <div
        className="pointer-events-auto absolute top-16 bottom-0 left-0 z-10 w-[45%]"
        style={{ touchAction: 'none' }}
        onPointerDown={onJoyDown}
        onPointerMove={onJoyMove}
        onPointerUp={onJoyUp}
        onPointerCancel={onJoyUp}
        role="application"
        aria-label="Movement — touch and drag anywhere on the left"
      >
        {joy.active ? (
          <div
            className="pointer-events-none absolute rounded-full border-2 border-[#2f2823]/50 bg-[#fbf3e2]/25"
            style={{ left: joy.ox - JOY_R - 10, top: joy.oy - JOY_R - 10, width: (JOY_R + 10) * 2, height: (JOY_R + 10) * 2 }}
          >
            <div
              className="absolute h-16 w-16 rounded-full border-2 border-[#2f2823] shadow-[0_2px_0_0_#2f2823]"
              style={{
                left: JOY_R + 10 - 32 + joy.x * JOY_R,
                top: JOY_R + 10 - 32 + joy.y * JOY_R,
                background: Math.hypot(joy.x, joy.y) >= SPRINT_AT ? '#f28a2e' : 'rgba(251,243,226,0.92)',
              }}
            />
            {Math.hypot(joy.x, joy.y) >= SPRINT_AT && (
              <span className="absolute -top-6 left-1/2 -translate-x-1/2 text-[10px] font-extrabold tracking-widest text-[#2f2823]">
                SPRINT
              </span>
            )}
          </div>
        ) : (
          // resting hint where the stick usually lives
          <div
            className="pointer-events-none absolute rounded-full border-2 border-dashed border-[#2f2823]/30"
            style={{ left: 'max(28px, env(safe-area-inset-left))', bottom: 28, width: 116, height: 116 }}
          >
            <span className="absolute inset-0 flex items-center justify-center text-[10px] font-extrabold tracking-widest text-[#2f2823]/45">
              MOVE
            </span>
          </div>
        )}
      </div>

      {/* RIGHT: look zone (behind the buttons) */}
      <div
        className="pointer-events-auto absolute top-16 right-0 bottom-0 left-[45%] z-10"
        style={{ touchAction: 'none' }}
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
      />

      {/* KICK + skill arc, anchored to the bottom-right corner */}
      <div
        className="pointer-events-none absolute z-20"
        style={{ right: 'max(20px, env(safe-area-inset-right))', bottom: 20, width: 96, height: 96 }}
      >
        <button
          className="gg-touch-btn pointer-events-auto absolute inset-0 text-lg tracking-wide"
          style={{ width: 96, height: 96 }}
          {...kickProps}
          aria-label="Hold to charge kick, release to strike"
        >
          KICK
          {charging && (
            <span className="absolute inset-1.5 overflow-hidden rounded-full">
              <span
                className="absolute bottom-0 left-0 w-full bg-[#f28a2e]/50 transition-[height] duration-100"
                style={{ height: `${Math.round(snap.chargePower * 100)}%` }}
              />
            </span>
          )}
        </button>
        {arc.map((b) => {
          const rad = (b.angle * Math.PI) / 180
          const cx = 48 + Math.cos(rad) * ARC_R
          const cy = 48 + Math.sin(rad) * ARC_R
          return (
            <button
              key={b.label}
              className="gg-touch-btn pointer-events-auto absolute text-[11px]"
              style={{ width: 58, height: 58, left: cx - 29, top: cy - 29 }}
              {...press(b.run)}
            >
              {b.label}
            </button>
          )
        })}
      </div>

      {/* tray openers: TRICKS + EGO, stacked above the arc on the right edge */}
      <div
        className="pointer-events-none absolute z-20 flex flex-col items-end gap-2"
        style={{ right: 'max(16px, env(safe-area-inset-right))', top: 72 }}
      >
        <button className="gg-touch-btn pointer-events-auto h-12 w-[92px] rounded-xl! text-[11px]" {...press(() => setTray('tricks'))}>
          TRICKS
        </button>
        <button
          className="gg-touch-btn pointer-events-auto relative h-12 w-[92px] overflow-hidden rounded-xl! text-[11px]"
          {...press(() => setTray('ego'))}
          aria-label={`EGO supers, ${egoPct}% charged`}
        >
          <span
            className="absolute inset-y-0 left-0"
            style={{
              width: `${ego.infinite ? 100 : egoPct}%`,
              background: 'repeating-linear-gradient(-45deg, rgba(47,40,35,0.12) 0 4px, transparent 4px 9px), linear-gradient(90deg,#f28a2e,#e8532f)',
              opacity: 0.85,
            }}
          />
          <span className="relative flex items-center gap-1">
            <span className="font-brush text-sm">エゴ</span> {ego.infinite ? '∞' : `${egoPct}%`}
          </span>
        </button>
      </div>

      {/* trays — rendered only while open so the look zone stays free */}
      {tray !== 'none' && (
        <div
          className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-[#2f2823]/25 p-4 backdrop-blur-[1px]"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setTray('none')
          }}
        >
          <div
            className="gg-rise w-full max-w-md rounded-2xl border-2 border-[#2f2823] bg-[#fbf3e2] p-3 shadow-[0_4px_0_0_#2f2823]"
            role="dialog"
            aria-label={tray === 'ego' ? 'EGO supers' : 'Flair tricks'}
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="font-hand text-2xl font-bold">{tray === 'ego' ? 'EGO supers' : 'Tricks'}</span>
              <button
                className="flex h-10 w-10 items-center justify-center rounded-lg border-2 border-[#2f2823]/50 bg-white/50"
                {...press(() => setTray('none'))}
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </div>
            {tray === 'tricks' ? (
              <>
                <div className="grid grid-cols-4 gap-2">
                  {(
                    [
                      { label: 'RAINBOW', run: () => game.input.triggerRainbow() },
                      { label: 'RABONA', run: () => game.input.triggerRabona() },
                      { label: 'SPIN', run: () => game.input.triggerRoulette() },
                      { label: 'ELASTICO', run: () => game.input.triggerElastico() },
                      { label: 'CRUYFF', run: () => game.input.triggerCrouyff() },
                      { label: 'HEEL', run: () => game.input.triggerBackheel() },
                      { label: snap.juggling ? 'DROP' : 'JUGGLE', run: () => game.input.triggerJuggle() },
                    ] as const
                  ).map((t) => (
                    <button
                      key={t.label}
                      className="gg-touch-btn h-14 rounded-xl! text-[10px] leading-tight"
                      {...press(() => {
                        t.run()
                        setTray('none')
                      })}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <p className="mt-2 px-1 text-[10px] leading-snug font-bold text-[#2f2823]/60">
                  RABONA works with KICK: hold KICK to charge, then tap RABONA.
                </p>
              </>
            ) : (
              <>
                <div className="grid grid-cols-3 gap-2">
                  {([1, 2, 3, 4, 5, 6] as SuperKind[]).map((k) => {
                    const st = SUPER_STYLE[k]
                    const ready = ego.ready[k] && ego.lock >= 0.999
                    return (
                      <button
                        key={k}
                        className="flex h-16 flex-col items-center justify-center rounded-xl border-2 border-[#2f2823] shadow-[0_3px_0_0_#2f2823]"
                        style={{ background: ready ? st.accent : 'rgba(251,243,226,0.9)', opacity: ready ? 1 : 0.55 }}
                        {...press(() => {
                          game.input.triggerSuper(k)
                          setTray('none')
                        })}
                      >
                        <span className="font-brush text-lg leading-none" style={{ color: ready ? '#fbf3e2' : '#2f2823' }}>
                          {st.kanji}
                        </span>
                        <span className="text-[11px] font-extrabold" style={{ color: ready ? '#fbf3e2' : '#2f2823' }}>
                          {SUPER_NAMES[k]}
                        </span>
                        <span className="text-[9px] font-bold opacity-70" style={{ color: ready ? '#fbf3e2' : '#2f2823' }}>
                          {ego.infinite ? 'free' : `${SUPER_COSTS[k]} EGO`}
                        </span>
                      </button>
                    )
                  })}
                </div>
                <p className="mt-2 px-1 text-[10px] leading-snug font-bold text-[#2f2823]/60">
                  The EGO bar fills as you play — skills, shots, tackles and goals charge it faster.
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
