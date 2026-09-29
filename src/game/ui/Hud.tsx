'use client'

/** In-match HUD: score chip, banner, countdown, restart indicator, cooldown
 * pips, pause + victory overlays (with settings), touch controls. */
import { useEffect, useState } from 'react'
import { LogOut, Maximize, Menu as MenuIcon, Minimize, MousePointerClick, RotateCcw, Volume2, VolumeX, Wind } from 'lucide-react'
import { enterFullscreen, exitFullscreen, fullscreenSupported, isFullscreen } from './fullscreen'
import type { GameHandle } from '../Game'
import type { UiState } from '../core/types'
import { TEAM_NAME } from '../core/types'
import { formatMatchClock } from '../Game'
import { formatClock } from '../core/math'
import { TouchControls } from './TouchControls'
import { SettingsBlock } from './Menu'
import { SUPER_STYLE } from '../render/mangaOverlay'
import { SUPER } from '../core/constants'
import type { SuperKind } from '../core/types'

/** Short English labels for the gauge chips (the kanji alone is hard to read). */
const SUPER_SHORT: Record<SuperKind, string> = {
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

/** EGO gauge: a brushed ink bar + the six slanted super chips (tappable on touch). */
function EgoGauge({ game, snap }: { game: GameHandle; snap: UiState }) {
  const e = snap.ego
  const full = e.fill >= 0.999
  const kinds: SuperKind[] = [1, 2, 3, 4, 5, 6]
  return (
    <div
      className={`absolute left-3 flex w-[min(92vw,330px)] flex-col gap-1.5 ${snap.touchMode ? 'top-16' : 'bottom-12'}`}
    >
      <div className="flex items-baseline gap-2 px-1 text-[#2f2823]">
        <span className="font-brush text-xl leading-none" style={{ WebkitTextStroke: '0.5px #2f2823' }}>
          エゴ
        </span>
        <span className="text-[10px] font-extrabold tracking-[0.25em]">EGO</span>
        <span className="ml-auto text-[10px] font-extrabold tracking-widest opacity-70">
          {e.infinite ? '∞ SANDBOX' : full ? 'FLOW — 1–6' : `${Math.floor(e.fill * 100)}`}
        </span>
      </div>
      <div className={`gg-ego-bar ${full ? 'gg-ego-full' : ''}`}>
        <div className="gg-ego-fill" style={{ width: `${Math.round(e.fill * 100)}%` }} />
        {!e.infinite &&
          [50, 60, 70].map((c) => (
            <span key={c} className="absolute inset-y-0 w-px bg-[#2f2823]/45" style={{ left: `${c}%` }} />
          ))}
      </div>
      <div className="grid grid-cols-3 gap-1.5">
        {kinds.map((k) => {
          const st = SUPER_STYLE[k]
          const ready = e.ready[k] && e.lock >= 0.999
          return (
            <button
              key={k}
              className={`gg-ego-chip ${snap.touchMode ? 'pointer-events-auto' : 'pointer-events-none'}`}
              style={{ background: ready ? st.accent : 'rgba(251,243,226,0.7)', opacity: ready ? 1 : 0.6 }}
              title={`${k} — ${st.name} (${SUPER_COSTS[k]} EGO)`}
              onPointerDown={(ev) => {
                ev.preventDefault()
                game.input.triggerSuper(k)
              }}
              aria-label={`${st.name}, costs ${SUPER_COSTS[k]} EGO`}
            >
              <span className="text-[10px] font-extrabold">{k}</span>
              <span className="font-brush text-xs leading-none" style={{ color: ready ? '#fbf3e2' : '#2f2823' }}>
                {st.kanji}
              </span>
              <span
                className="truncate text-[10px] leading-none font-extrabold tracking-wide"
                style={{ color: ready ? '#fbf3e2' : '#2f2823' }}
              >
                {SUPER_SHORT[k]}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

interface HudProps {
  game: GameHandle
  snap: UiState
}

function ScoreChip({ snap }: { snap: UiState }) {
  // free play: session timer + goal tally — no opponents, no scoreline
  if (snap.freePlay) {
    return (
      <div className="gg-chip pointer-events-none flex items-center gap-2.5 text-sm font-extrabold sm:gap-3.5 sm:text-base">
        <span className="flex items-center gap-1.5 text-[#1f847d]">
          <Wind size={15} strokeWidth={2.8} />
        </span>
        <span className="font-hand text-xl leading-none">{formatClock(snap.clock)}</span>
        <span className="flex items-center gap-1.5">
          <span className="h-3 w-3 rounded-full border border-[#2f2823] bg-[#f28a2e]" />
          {snap.practiceGoals}
        </span>
        <span className="text-[10px] font-bold tracking-widest uppercase opacity-50">free play</span>
      </div>
    )
  }
  return (
    <div className="gg-chip pointer-events-none flex items-center gap-2.5 text-sm font-extrabold sm:gap-3.5 sm:text-base">
      <span className="flex items-center gap-1.5">
        <span className="h-3 w-3 rounded-full border border-[#2f2823] bg-[#f28a2e]" />
        {snap.scoreA}
      </span>
      <span className="font-hand text-xl leading-none">{formatMatchClock(snap.clock)}</span>
      <span className="flex items-center gap-1.5">
        {snap.scoreB}
        <span className="h-3 w-3 rounded-full border border-[#2f2823] bg-[#2fa8a0]" />
      </span>
      <span className="text-[10px] font-bold tracking-widest uppercase opacity-50">
        {snap.practice ? 'practice' : snap.half === 1 ? '1st half' : '2nd half'}
      </span>
    </div>
  )
}

function ControlsList() {
  const rows: Array<[string, string]> = [
    ['WASD / arrows', 'move'],
    ['Mouse', 'aim — this is your kicking direction'],
    ['LMB hold + release', 'charge and strike (power = hold time)'],
    ['Look down / up', 'driven shot / chip over opponents'],
    ['RMB', 'quick sidestep cut'],
    ['Q', 'stepover feint'],
    ['F', 'flick the ball over a tackle'],
    ['C / Ctrl', 'slide tackle — catch the ball first or it\u2019s a foul!'],
    ['E', 'rainbow — roll it up your leg and flick it over'],
    ['Z while holding LMB', 'rabona — the charged kick, cross-legged'],
    ['X', 'roulette — 360° spin with the ball under your sole'],
    ['V', 'elastico — push out, snap across'],
    ['G', 'Cruyff turn — fake shot, drag, 180°'],
    ['B', 'backheel — clip it behind you'],
    ['T', 'juggle on/off — LMB volleys it mid-bounce'],
    ['1', 'EGO: Crimson Dragon — unstoppable shot along your crosshair (ball at your feet)'],
    ['2', 'EGO: Mountain Bastion — a rock wall where you look'],
    ['3', 'EGO: Eagle Talon — swoop onto the ball from anywhere'],
    ['4', 'EGO: Thunder Seal — lightning roots nearby rivals'],
    ['5', 'EGO: Zero Hour — stop time for everyone else'],
    ['6', 'EGO: Gulmohar Cyclone — drag rivals into a tornado'],
    ['Shift', 'sprint (watch your stamina)'],
    ['R', 'reset the ball to your feet (solo modes)'],
    ['Esc / P', 'this menu'],
  ]
  return (
    <div className="mt-3 grid grid-cols-1 gap-1 text-xs font-semibold sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-2">
          <span className="rounded-md border border-[#2f2823]/40 bg-white/60 px-1.5 py-0.5 font-bold">{k}</span>
          <span className="opacity-75">{v}</span>
        </div>
      ))}
    </div>
  )
}

/** Skill readiness grid — bottom-right, desktop only (touch has the TRICKS tray). */
function SkillPips({ snap }: { snap: UiState }) {
  if (snap.touchMode) return null
  const pips: Array<{ key: string; label: string; name: string; v: number; active?: boolean }> = [
    { key: 'cut', label: 'RMB', name: 'cut', v: snap.skills.cut },
    { key: 'step', label: 'Q', name: 'step', v: snap.skills.step },
    { key: 'flick', label: 'F', name: 'flick', v: snap.skills.flick },
    { key: 'slide', label: 'C', name: 'slide', v: snap.skills.slide },
    { key: 'rainbow', label: 'E', name: 'rainbow', v: snap.skills.rainbow },
    { key: 'roulette', label: 'X', name: 'spin', v: snap.skills.roulette },
    { key: 'elastico', label: 'V', name: 'elastico', v: snap.skills.elastico },
    { key: 'crouyff', label: 'G', name: 'Cruyff', v: snap.skills.crouyff },
    { key: 'backheel', label: 'B', name: 'heel', v: snap.skills.backheel },
    { key: 'juggle', label: 'T', name: 'juggle', v: 1, active: snap.juggling },
  ]
  return (
    <div className="pointer-events-none absolute right-3 bottom-3 flex flex-col items-end gap-1">
      <div className="grid grid-cols-2 gap-1">
        {pips.map((p) => {
          const ready = p.v >= 0.999
          const on = p.active === true
          return (
            <div
              key={p.key}
              className="flex h-6 w-[84px] items-center gap-1 overflow-hidden rounded-md border-2 border-[#2f2823]/70 bg-[#fbf3e2]/80 px-1"
              style={{ boxShadow: '0 2px 0 0 rgba(47,40,35,0.55)' }}
              title={on ? `${p.name} juggling` : ready ? `${p.name} ready` : `${p.name} recharging`}
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full border border-[#2f2823]"
                style={{ background: on ? '#2fa8a0' : ready ? '#3d9a4e' : '#d9a13d' }}
              />
              <span className="w-6 shrink-0 text-[9px] leading-none font-extrabold tracking-wide">{p.label}</span>
              <span className="relative h-1.5 flex-1 overflow-hidden rounded-full border border-[#2f2823]/50 bg-[#f3e6cc]">
                <span
                  className="absolute inset-y-0 left-0 rounded-full"
                  style={{
                    width: `${Math.round(p.v * 100)}%`,
                    background: on ? '#2fa8a0' : ready ? '#3d9a4e' : '#e8a02d',
                    transition: 'width 0.12s linear',
                  }}
                />
              </span>
            </div>
          )
        })}
      </div>
      <div
        className="rounded-md border-2 border-[#2f2823]/60 bg-[#fbf3e2]/75 px-1.5 py-0.5 text-[9px] leading-none font-extrabold tracking-wide text-[#2f2823]/85"
        style={{ boxShadow: '0 2px 0 0 rgba(47,40,35,0.45)' }}
      >
        Z + LMB = rabona
      </div>
    </div>
  )
}

export function Hud({ game, snap }: HudProps) {
  const [fs, setFs] = useState(false)
  useEffect(() => {
    const on = (): void => setFs(isFullscreen())
    document.addEventListener('fullscreenchange', on)
    document.addEventListener('webkitfullscreenchange', on)
    return () => {
      document.removeEventListener('fullscreenchange', on)
      document.removeEventListener('webkitfullscreenchange', on)
    }
  }, [])
  const [showClickHint, setShowClickHint] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setShowClickHint(false), 9000)
    return () => window.clearTimeout(t)
  }, [])

  const banner = snap.banner
  const winnerName =
    snap.victory?.winner === 'A' ? TEAM_NAME.A : snap.victory?.winner === 'B' ? TEAM_NAME.B : null
  const restart = snap.restart

  return (
    <div className="pointer-events-none absolute inset-0 z-30 select-none">
      {/* score + clock */}
      <div className="absolute top-3 left-1/2 -translate-x-1/2">
        <ScoreChip snap={snap} />
      </div>

      {/* top-right buttons */}
      <div className="pointer-events-auto absolute top-3 right-3 flex gap-2">
        {fullscreenSupported() && (
          <button
            className="gg-btn gg-btn-ghost !min-h-11 !w-11 !p-0"
            style={{ background: 'rgba(251,243,226,0.85)', border: '2px solid #2f2823', boxShadow: '0 2px 0 0 #2f2823' }}
            onClick={() => {
              if (isFullscreen()) void exitFullscreen()
              else void enterFullscreen(snap.touchMode)
            }}
            title="Fullscreen"
            aria-label="Toggle fullscreen"
          >
            {fs ? <Minimize size={19} /> : <Maximize size={19} />}
          </button>
        )}
        <button
          className="gg-btn gg-btn-ghost !min-h-11 !w-11 !p-0"
          style={{ background: 'rgba(251,243,226,0.85)', border: '2px solid #2f2823', boxShadow: '0 2px 0 0 #2f2823' }}
          onClick={() => game.cmd({ type: 'toggleMute' })}
          title={snap.muted ? 'Unmute' : 'Mute'}
        >
          {snap.muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
        </button>
        <button
          className="gg-btn gg-btn-ghost !min-h-11 !w-11 !p-0"
          style={{ background: 'rgba(251,243,226,0.85)', border: '2px solid #2f2823', boxShadow: '0 2px 0 0 #2f2823' }}
          onClick={() => game.input.triggerPause()}
          title="Menu (Esc)"
        >
          <MenuIcon size={19} />
        </button>
      </div>

      {/* connection dropped — the relay client is reconnecting */}
      {snap.netStatus === 'reconnecting' && !snap.practice && !snap.freePlay && (
        <div className="gg-chip gg-breathe absolute top-28 left-1/2 -translate-x-1/2 text-xs font-bold">
          Connection dropped — reconnecting…
        </div>
      )}

      {/* spectating chip */}
      {snap.spectating && !snap.paused && (
        <div className="gg-chip gg-breathe absolute top-16 left-1/2 -translate-x-1/2 text-xs font-bold">
          Spectating — you join at the next kickoff
        </div>
      )}

      {/* solo chip — on touch there's no R key, so tapping the chip resets the ball */}
      {(snap.practice || snap.freePlay) && !snap.paused && !snap.victory && (
        <button
          className="gg-chip pointer-events-auto absolute top-3 left-3 flex items-center gap-2 text-xs font-bold"
          onPointerDown={(e) => {
            e.preventDefault()
            if (snap.touchMode) game.cmd({ type: 'practiceReset' })
          }}
          aria-label="Reset the ball to your feet"
        >
          {snap.practice ? `Practice · ${snap.practiceGoals} goal${snap.practiceGoals === 1 ? '' : 's'}` : 'Just you & the ball'}
          <span className="opacity-55">{snap.touchMode ? '↺ tap: ball to feet' : 'R resets the ball'}</span>
        </button>
      )}

      {/* restart chip — who takes it */}
      {restart && !snap.paused && !snap.victory && (
        <div
          className={`gg-chip absolute top-16 left-1/2 flex -translate-x-1/2 items-center gap-2 text-xs font-bold ${
            restart.mine ? 'gg-breathe' : 'opacity-85'
          }`}
        >
          <span
            className="h-2.5 w-2.5 rounded-full border border-[#2f2823]"
            style={{ background: restart.team === 'A' ? '#f28a2e' : '#2fa8a0' }}
          />
          {restart.hint}
        </div>
      )}

      {/* click-to-play hint */}
      {showClickHint && !snap.touchMode && !snap.pointerLocked && !snap.paused && !snap.victory && (
        <div className="gg-chip gg-breathe absolute bottom-24 left-1/2 flex -translate-x-1/2 items-center gap-2 text-sm font-bold">
          <MousePointerClick size={17} /> Click to capture the mouse
        </div>
      )}

      {/* countdown */}
      {snap.countdown !== null && snap.countdown > 0 && (
        <div key={snap.countdown} className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="gg-count-num gg-pop">{snap.countdown}</span>
        </div>
      )}

      {/* goal / restart banner */}
      {banner && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <div
            className="absolute inset-0"
            style={{
              background:
                banner.tone === 'A'
                  ? 'radial-gradient(60% 50% at 50% 45%, rgba(242,138,46,0.32), transparent 70%)'
                  : banner.tone === 'B'
                    ? 'radial-gradient(60% 50% at 50% 45%, rgba(47,168,160,0.30), transparent 70%)'
                    : 'transparent',
            }}
          />
          <span className="gg-goal-title gg-pop">{banner.title}</span>
          {banner.sub && <span className="gg-chip gg-rise mt-3 font-hand text-2xl font-bold">{banner.sub}</span>}
        </div>
      )}

      {/* EGO gauge */}
      {/* touch has its own compact EGO button + tray in TouchControls */}
      {!snap.paused && !snap.victory && snap.phase === 'play' && !snap.spectating && !snap.touchMode && <EgoGauge game={game} snap={snap} />}

      {/* skill cooldown pips */}
      {!snap.paused && !snap.victory && snap.phase === 'play' && <SkillPips snap={snap} />}

      {/* touch controls */}
      {snap.touchMode && !snap.paused && !snap.victory && <TouchControls game={game} snap={snap} />}

      {/* pause menu */}
      {snap.paused && !snap.victory && (
        <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center overflow-y-auto bg-[#2f2823]/35 p-4 backdrop-blur-[2px]">
          <div className="gg-panel gg-rise my-auto w-full max-w-sm p-6">
            <h2 className="font-hand text-4xl font-bold">Paused… sort of</h2>
            <p className="mt-1 text-xs font-semibold opacity-60">
              {snap.practice || snap.freePlay
                ? 'Take your time — the ball isn\u2019t going anywhere.'
                : 'The match keeps running for everyone else!'}
            </p>
            <button className="gg-btn gg-btn-primary mt-4 w-full text-lg" onClick={() => game.cmd({ type: 'requestLock' })}>
              <MousePointerClick size={19} /> Back to the pitch
            </button>
            <ControlsList />
            <button
              className="gg-btn mt-3 w-full text-sm"
              onClick={() => setShowSettings((v) => !v)}
              aria-expanded={showSettings}
            >
              {showSettings ? 'Hide settings' : 'Settings (FOV · sensitivity · graphics)'}
            </button>
            {showSettings && (
              <div className="mt-1 rounded-xl bg-[#2f2823]/5 p-3">
                <SettingsBlock game={game} snap={snap} />
              </div>
            )}
            <div className="mt-4 flex gap-2">
              <button className="gg-btn flex-1" onClick={() => game.cmd({ type: 'toggleMute' })}>
                {snap.muted ? <VolumeX size={16} /> : <Volume2 size={16} />} {snap.muted ? 'Unmute' : 'Mute'}
              </button>
              <button className="gg-btn flex-1" onClick={() => game.cmd({ type: 'leaveMatch' })}>
                <LogOut size={16} /> Leave match
              </button>
            </div>
          </div>
        </div>
      )}

      {/* victory */}
      {snap.victory && (
        <div className="pointer-events-auto absolute inset-0 z-40 flex items-center justify-center bg-[#2f2823]/30 p-4 backdrop-blur-[2px]">
          <div className="gg-panel gg-rise w-full max-w-md p-7 text-center">
            <p className="text-xs font-bold tracking-[0.3em] uppercase opacity-60">full time</p>
            <h2 className="font-hand mt-1 text-5xl font-bold">
              {winnerName ? `${winnerName} wins!` : 'A draw!'}
            </h2>
            <p className="font-hand mt-2 text-4xl font-bold">
              <span style={{ color: '#d96f16' }}>{snap.scoreA}</span>
              <span className="mx-2 opacity-40">–</span>
              <span style={{ color: '#1f847d' }}>{snap.scoreB}</span>
            </p>
            {snap.victory.scorers.length > 0 && (
              <div className="mx-auto mt-4 max-h-36 w-full max-w-xs overflow-y-auto rounded-xl bg-white/40 p-2 text-sm font-bold">
                {Object.values(
                  snap.victory.scorers.reduce<Record<string, { name: string; team: string; n: number }>>((acc, s) => {
                    acc[s.name] = acc[s.name]
                      ? { ...acc[s.name], n: acc[s.name].n + 1 }
                      : { name: s.name, team: s.team, n: 1 }
                    return acc
                  }, {}),
                ).map((s) => (
                  <div key={s.name} className="flex items-center justify-between px-2 py-0.5">
                    <span className="flex items-center gap-1.5 truncate">
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full border border-[#2f2823]"
                        style={{ background: s.team === 'A' ? '#f28a2e' : '#2fa8a0' }}
                      />
                      {s.name}
                    </span>
                    <span className="opacity-60">×{s.n}</span>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-5 flex gap-2">
              {snap.isHost && !snap.practice ? (
                <button className="gg-btn gg-btn-primary flex-1 text-lg" onClick={() => game.cmd({ type: 'rematch' })}>
                  <RotateCcw size={18} /> Rematch
                </button>
              ) : (
                <div className="gg-breathe flex flex-1 items-center justify-center rounded-xl border-2 border-dashed border-[#2f2823]/30 px-4 py-2 text-sm font-bold opacity-70">
                  {snap.practice || snap.freePlay ? 'Solo play never ends' : 'Waiting for the host…'}
                </div>
              )}
              <button className="gg-btn" onClick={() => game.cmd({ type: 'leaveMatch' })}>
                <LogOut size={16} /> Leave
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
