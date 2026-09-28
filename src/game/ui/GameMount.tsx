'use client'

/**
 * Mounts the game engine onto the two canvases and bridges it to React.
 * All gameplay lives in src/game — this file is purely lifecycle + overlays.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { GameHandle } from '../Game'
import type { UiState } from '../core/types'
import { MenuScreen, RoomScreen } from './Menu'
import { Hud } from './Hud'

const EMPTY: UiState = {
  screen: 'menu',
  practice: false,
  freePlay: false,
  netConfigured: false,
  connected: false,
  netStatus: '',
  roomCode: '',
  roster: [],
  isHost: false,
  myId: '',
  myName: '',
  myTeam: 'A',
  phase: 'lobby',
  scoreA: 0,
  scoreB: 0,
  clock: 0,
  half: 1,
  spectating: false,
  banner: null,
  countdown: null,
  victory: null,
  practiceGoals: 0,
  muted: false,
  pointerLocked: false,
  touchMode: false,
  paused: false,
  charging: false,
  chargePower: 0,
  stamina: 1,
  settings: {
    fov: 78,
    sens: 1,
    invertY: false,
    quality: 'high',
    volume: 0.9,
  },
  restart: null,
  skills: { cut: 1, step: 1, flick: 1, slide: 1, rainbow: 1, roulette: 1, elastico: 1, crouyff: 1, backheel: 1 },
  sliding: false,
  juggling: false,
  ego: { fill: 0, infinite: false, ready: [false, false, false, false, false, false, false], lock: 1 },
}

const noopSubscribe = (): (() => void) => () => undefined

interface ToastItem {
  id: number
  msg: string
}

let toastId = 0

export default function GameMount() {
  const containerRef = useRef<HTMLDivElement>(null)
  const webglRef = useRef<HTMLCanvasElement>(null)
  const aimRef = useRef<HTMLCanvasElement>(null)
  const fxRef = useRef<HTMLCanvasElement>(null)
  const [game, setGame] = useState<GameHandle | null>(null)
  const [toasts, setToasts] = useState<ToastItem[]>([])

  useEffect(() => {
    let disposed = false
    let handle: GameHandle | null = null
    void import('../Game').then(({ createGame }) => {
      if (disposed || !containerRef.current || !webglRef.current || !aimRef.current || !fxRef.current) return
      handle = createGame({
        webglCanvas: webglRef.current,
        aimCanvas: aimRef.current,
        fxCanvas: fxRef.current,
        container: containerRef.current,
        onToast: (msg) => {
          const id = ++toastId
          setToasts((t) => [...t.slice(-3), { id, msg }])
          window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2800)
        },
      })
      setGame(handle)
    })
    return () => {
      disposed = true
      handle?.dispose()
      setGame(null)
    }
  }, [])

  const subscribe = game ? (fn: () => void) => game.subscribe(fn) : noopSubscribe
  const getSnapshot = game ? () => game.getSnapshot() : () => EMPTY
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  return (
    <div ref={containerRef} className="gg-canvas-root relative h-dvh w-full overflow-hidden bg-[#f2ddbe]">
      <canvas ref={webglRef} className="absolute inset-0 block h-full w-full" aria-label="Football pitch" />
      {/* manga ink layer for the EGO supers — cut-ins, focus lines, sound effects */}
      <canvas ref={fxRef} className="pointer-events-none absolute inset-0 block h-full w-full" aria-hidden="true" />
      <canvas ref={aimRef} className="pointer-events-none absolute inset-0 block h-full w-full" aria-hidden="true" />

      {game && snap.screen === 'menu' && <MenuScreen game={game} snap={snap} />}
      {game && snap.screen === 'room' && <RoomScreen game={game} snap={snap} />}
      {game && snap.screen === 'game' && <Hud game={game} snap={snap} />}

      {/* toasts */}
      <div className="pointer-events-none absolute bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div key={t.id} className="gg-chip gg-rise font-hand text-lg" role="status">
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  )
}
