'use client'

/**
 * Touch controls: left virtual joystick = move, right-side drag = look,
 * hold-to-charge KICK button + sprint / cut / flick / stepover buttons, and a
 * TRICKS tray with the seven flair skills.
 */
import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { GameHandle } from '../Game'
import type { UiState } from '../core/types'

const LOOK_SCALE = 2.4 // touch pixels → mouse-like deltas

export function TouchControls({ game, snap }: { game: GameHandle; snap: UiState }) {
  const joyRef = useRef<HTMLDivElement>(null)
  const [joy, setJoy] = useState<{ active: boolean; x: number; y: number }>({ active: false, x: 0, y: 0 })
  const joyId = useRef<number | null>(null)
  const lookId = useRef<number | null>(null)
  const lookLast = useRef<{ x: number; y: number } | null>(null)
  const [charging, setCharging] = useState(false)
  const [tricksOpen, setTricksOpen] = useState(false)

  // ------------------------------------------------------------- joystick
  const onJoyDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (joyId.current !== null) return
    joyId.current = e.pointerId
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    updateJoy(e)
  }
  const updateJoy = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = joyRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const cx = r.left + r.width / 2
    const cy = r.top + r.height / 2
    const rad = r.width / 2
    let dx = (e.clientX - cx) / rad
    let dy = (e.clientY - cy) / rad
    const l = Math.hypot(dx, dy)
    if (l > 1) {
      dx /= l
      dy /= l
    }
    setJoy({ active: true, x: dx, y: dy })
    game.input.setTouchMove(dx, -dy)
  }
  const onJoyMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (joyId.current !== e.pointerId) return
    updateJoy(e)
  }
  const onJoyUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (joyId.current !== e.pointerId) return
    joyId.current = null
    setJoy({ active: false, x: 0, y: 0 })
    game.input.setTouchMove(0, 0)
  }

  // ------------------------------------------------------------- look drag (right side)
  const onLookDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (lookId.current !== null) return
    lookId.current = e.pointerId
    lookLast.current = { x: e.clientX, y: e.clientY }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
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

  const hold = (setter: (on: boolean) => void) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault()
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      setter(true)
    },
    onPointerUp: () => setter(false),
    onPointerCancel: () => setter(false),
    onContextMenu: (e: React.SyntheticEvent) => e.preventDefault(),
  })

  return (
    <>
      {/* look zone — right half, below the top bar, behind the buttons */}
      <div
        className="pointer-events-auto absolute top-14 right-0 bottom-0 left-1/2 z-10"
        onPointerDown={onLookDown}
        onPointerMove={onLookMove}
        onPointerUp={onLookUp}
        onPointerCancel={onLookUp}
      />

      {/* joystick */}
      <div
        ref={joyRef}
        className="pointer-events-auto absolute bottom-6 left-5 z-20 h-32 w-32 rounded-full border-2 border-[#2f2823]/45 bg-[#fbf3e2]/35 backdrop-blur-[1px]"
        style={{ touchAction: 'none' }}
        onPointerDown={onJoyDown}
        onPointerMove={onJoyMove}
        onPointerUp={onJoyUp}
        onPointerCancel={onJoyUp}
        role="application"
        aria-label="Movement joystick"
      >
        <div
          className="pointer-events-none absolute h-14 w-14 rounded-full border-2 border-[#2f2823] bg-[#fbf3e2]/90 shadow-[0_2px_0_0_#2f2823]"
          style={{
            left: `calc(50% - 1.75rem + ${joy.x * 34}px)`,
            top: `calc(50% - 1.75rem + ${joy.y * 34}px)`,
            transition: joy.active ? 'none' : 'left 0.15s ease, top 0.15s ease',
          }}
        />
      </div>

      {/* action buttons */}
      <div className="pointer-events-auto absolute right-5 bottom-6 z-20 flex flex-col items-end gap-2.5">
        <div className="flex gap-2.5">
          <button className="gg-touch-btn h-12 w-12 text-[11px]" {...hold((on) => game.input.setTouchSprint(on))}>
            RUN
          </button>
          <button className="gg-touch-btn h-12 w-12 text-[11px]" {...hold(() => undefined)} onPointerDown={(e) => { e.preventDefault(); game.input.triggerStep() }}>
            STEP
          </button>
          <button className="gg-touch-btn h-12 w-12 text-[11px]" onPointerDown={(e) => { e.preventDefault(); setTricksOpen(true) }}>
            TRICKS
          </button>
        </div>
        <div className="flex gap-2.5">
          <button className="gg-touch-btn h-14 w-14 text-xs" onPointerDown={(e) => { e.preventDefault(); game.input.triggerCut() }}>
            CUT
          </button>
          <button className="gg-touch-btn h-14 w-14 text-xs" onPointerDown={(e) => { e.preventDefault(); game.input.triggerFlick() }}>
            FLICK
          </button>
        </div>
        <div className="flex gap-2.5">
          <button className="gg-touch-btn h-14 w-14 text-xs" onPointerDown={(e) => { e.preventDefault(); game.input.triggerSlide() }}>
            SLIDE
          </button>
          <button
            className="gg-touch-btn relative h-24 w-24 text-base tracking-wide"
            {...hold((on) => {
              setCharging(on)
              game.input.setTouchCharge(on)
            })}
            aria-label="Hold to charge kick, release to strike"
          >
            KICK
            {charging && (
              <span className="absolute inset-1.5 overflow-hidden rounded-full">
                <span
                  className="absolute bottom-0 left-0 w-full bg-[#f28a2e]/45 transition-[height] duration-100"
                  style={{ height: `${Math.round(snap.chargePower * 100)}%` }}
                />
              </span>
            )}
          </button>
        </div>
      </div>

      {/* tricks tray — only rendered while open, so the look zone stays free */}
      {tricksOpen && (
        <div className="pointer-events-auto absolute inset-0 z-30 flex items-center justify-center bg-[#2f2823]/25 p-4 backdrop-blur-[1px]">
          <div
            className="gg-rise w-full max-w-xs rounded-2xl border-2 border-[#2f2823] bg-[#fbf3e2] p-3 shadow-[0_4px_0_0_#2f2823]"
            role="dialog"
            aria-label="Flair tricks"
          >
            <div className="mb-2 flex items-center justify-between px-1">
              <span className="font-hand text-2xl font-bold">Tricks</span>
              <button
                className="flex h-8 w-8 items-center justify-center rounded-lg border-2 border-[#2f2823]/50 bg-white/50"
                onPointerDown={(e) => {
                  e.preventDefault()
                  setTricksOpen(false)
                }}
                aria-label="Close tricks"
              >
                <X size={16} />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
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
                  className="gg-touch-btn h-14 text-[10px] leading-tight"
                  onPointerDown={(e) => {
                    e.preventDefault()
                    t.run()
                    setTricksOpen(false)
                  }}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <p className="mt-2 px-1 text-[10px] leading-snug font-bold text-[#2f2823]/60">
              RABONA works with the KICK button: hold KICK to charge, then tap RABONA.
            </p>
          </div>
        </div>
      )}
    </>
  )
}
