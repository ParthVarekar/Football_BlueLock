'use client'

/** Menu + room lobby — cream paper panels over the live painted pitch. */
import { useState } from 'react'
import { Copy, Crown, Dices, LogOut, Play, Shuffle, SlidersHorizontal, Users, Wind } from 'lucide-react'
import type { GameHandle } from '../Game'
import type { UiState } from '../core/types'
import { TEAM_NAME } from '../core/types'
import { QUALITY_LABELS, SETTINGS_LIMITS, type GameSettings } from '../core/settings'

interface ScreenProps {
  game: GameHandle
  snap: UiState
}

function TitleBlock() {
  return (
    <div className="text-center">
      <h1 className="font-hand text-5xl leading-[0.9] font-bold tracking-tight sm:text-6xl">
        Gulmohar
        <br />
        Ground
      </h1>
      <svg className="gg-swash mx-auto mt-0.5 h-3.5 w-52" viewBox="0 0 224 16" fill="none" aria-hidden="true">
        <path d="M3 9 C 40 3, 90 13, 122 7 S 200 4, 221 9" stroke="#f28a2e" strokeWidth="5" strokeLinecap="round" />
      </svg>
      <p className="mt-1.5 text-[10px] font-bold tracking-[0.28em] uppercase opacity-70">
        first-person gully football
      </p>
    </div>
  )
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  const fill = ((value - min) / (max - min)) * 100
  return (
    <label className="mt-3 block">
      <span className="mb-0.5 flex items-baseline justify-between text-xs font-bold tracking-widest uppercase opacity-60">
        {label}
        <span className="font-hand text-base tracking-normal normal-case opacity-90">{format(value)}</span>
      </span>
      <input
        type="range"
        className="gg-slider"
        style={{ '--gg-fill': `${fill}%` } as React.CSSProperties}
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  )
}

/** Shared settings block — used by the menu and the pause screen. */
export function SettingsBlock({ game, snap }: ScreenProps) {
  const s = snap.settings
  const set = (patch: Partial<GameSettings>): void => game.cmd({ type: 'setSettings', patch })
  return (
    <div>
      <Slider
        label="Field of view"
        value={s.fov}
        min={SETTINGS_LIMITS.fov.min}
        max={SETTINGS_LIMITS.fov.max}
        step={SETTINGS_LIMITS.fov.step}
        format={(v) => `${Math.round(v)}°`}
        onChange={(fov) => set({ fov })}
      />
      <Slider
        label="Mouse sensitivity"
        value={s.sens}
        min={SETTINGS_LIMITS.sens.min}
        max={SETTINGS_LIMITS.sens.max}
        step={SETTINGS_LIMITS.sens.step}
        format={(v) => (v >= 1 ? v.toFixed(2) : v.toFixed(2))}
        onChange={(sens) => set({ sens })}
      />
      <Slider
        label="Volume"
        value={s.volume}
        min={SETTINGS_LIMITS.volume.min}
        max={SETTINGS_LIMITS.volume.max}
        step={SETTINGS_LIMITS.volume.step}
        format={(v) => `${Math.round(v * 100)}%`}
        onChange={(volume) => set({ volume })}
      />

      <button
        type="button"
        className="mt-3 flex w-full items-center justify-between rounded-xl border-2 border-[#2f2823]/25 bg-white/40 px-3 py-2"
        onClick={() => set({ invertY: !s.invertY })}
        aria-pressed={s.invertY}
      >
        <span className="text-xs font-bold tracking-widest uppercase opacity-70">Invert look (Y axis)</span>
        <span className="gg-toggle" data-on={s.invertY} aria-hidden="true" />
      </button>

      <div className="mt-3">
        <span className="mb-1 block text-xs font-bold tracking-widest uppercase opacity-60">Graphics</span>
        <div className="grid grid-cols-3 gap-1.5" role="radiogroup" aria-label="Graphics quality">
          {QUALITY_LABELS.map((q) => (
            <button
              key={q.id}
              type="button"
              role="radio"
              aria-checked={s.quality === q.id}
              className={`rounded-lg border-2 px-2 py-1.5 text-sm font-bold transition-colors ${
                s.quality === q.id
                  ? 'border-[#2f2823] bg-[#f28a2e] text-white'
                  : 'border-[#2f2823]/25 bg-white/40 hover:border-[#2f2823]/60'
              }`}
              onClick={() => set({ quality: q.id })}
              title={q.blurb}
            >
              {q.label}
            </button>
          ))}
        </div>
        <p className="mt-1 text-[11px] leading-snug font-semibold opacity-55">
          {QUALITY_LABELS.find((q) => q.id === s.quality)?.blurb}
        </p>
      </div>
    </div>
  )
}

/** Offline note shown instead of the removed key form — env-only config. */
function EnvOnlyNote() {
  return (
    <p className="mt-2.5 rounded-xl border-2 border-dashed border-[#2f2823]/25 bg-[#2f2823]/5 px-3 py-2 text-center text-[11px] leading-relaxed font-semibold opacity-75">
      Online rooms need Supabase keys set as environment variables in{' '}
      <code className="rounded bg-[#2f2823]/10 px-1">.env.local</code> (
      <code className="rounded bg-[#2f2823]/10 px-1">NEXT_PUBLIC_SUPABASE_URL</code> +{' '}
      <code className="rounded bg-[#2f2823]/10 px-1">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> — see
      README). Practice &amp; free play work fully offline.
    </p>
  )
}

export function MenuScreen({ game, snap }: ScreenProps) {
  // the game is created (and its snapshot populated) before this screen mounts
  const [name, setName] = useState(snap.myName)
  const [code, setCode] = useState('')
  const [showSettings, setShowSettings] = useState(false)

  const commitName = (): void => {
    if (name.trim()) game.cmd({ type: 'setName', name })
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col">
      <div className="flex flex-1 overflow-y-auto p-4">
        <div className="gg-panel gg-rise m-auto w-full max-w-md p-6 sm:p-8">
          <TitleBlock />

          <label className="mt-4 block">
            <span className="mb-1 block text-xs font-bold tracking-widest uppercase opacity-60">Your name</span>
            <input
              className="gg-input font-hand w-full text-xl"
              value={name}
              maxLength={14}
              placeholder="Arjun"
              onChange={(e) => setName(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  commitName()
                  e.currentTarget.blur()
                }
              }}
            />
          </label>

          <button
            className="gg-btn gg-btn-primary mt-4 w-full text-lg"
            onClick={() => {
              commitName()
              game.cmd({ type: 'createRoom' })
            }}
            disabled={!snap.netConfigured}
          >
            <Play size={19} strokeWidth={2.6} /> Create a room
          </button>

          {/* two solo ways to play — side by side */}
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <button
              className="gg-btn gg-btn-teal flex-col px-2 py-2"
              style={{ gap: '0.15rem' }}
              onClick={() => {
                commitName()
                game.cmd({ type: 'startPractice' })
              }}
            >
              <Dices size={19} strokeWidth={2.6} />
              <span className="text-base leading-tight">Practice</span>
              <span className="text-[10px] font-bold tracking-wide uppercase opacity-70">vs AI defender</span>
            </button>
            <button
              className="gg-btn gg-btn-teal flex-col px-2 py-2"
              style={{ gap: '0.15rem' }}
              onClick={() => {
                commitName()
                game.cmd({ type: 'startFreePlay' })
              }}
            >
              <Wind size={19} strokeWidth={2.6} />
              <span className="text-base leading-tight">Free play</span>
              <span className="text-[10px] font-bold tracking-wide uppercase opacity-70">just you · no rules</span>
            </button>
          </div>

          <div className="mt-2.5 flex gap-2">
            <input
              className="gg-input gg-code-input w-full"
              value={code}
              maxLength={4}
              placeholder="CODE"
              inputMode="text"
              autoCapitalize="characters"
              disabled={!snap.netConfigured}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && code.length === 4) {
                  commitName()
                  game.cmd({ type: 'joinRoom', code })
                }
              }}
            />
            <button
              className="gg-btn shrink-0"
              disabled={!snap.netConfigured || code.length !== 4}
              onClick={() => {
                commitName()
                game.cmd({ type: 'joinRoom', code })
              }}
            >
              Join
            </button>
          </div>

          {!snap.netConfigured && <EnvOnlyNote />}

          <button
            className="gg-btn mt-3 w-full text-sm"
            onClick={() => setShowSettings((v) => !v)}
            aria-expanded={showSettings}
          >
            <SlidersHorizontal size={15} /> {showSettings ? 'Hide settings' : 'Settings'}
          </button>
          {showSettings && (
            <div className="mt-1 rounded-xl bg-[#2f2823]/5 p-3">
              <SettingsBlock game={game} snap={snap} />
            </div>
          )}

          <p className="mt-3 text-center text-[11px] leading-relaxed font-semibold opacity-60">
            2–6 players · 3v3 is the sweet spot
            <br />
            first to 5 goals, or two 3-minute halves
          </p>
        </div>
      </div>

      <footer className="mt-auto border-t-2 border-[#2f2823]/70 bg-[#fbf3e2]/90 px-4 py-2.5 backdrop-blur-sm">
        {/* compact touch hint on phones — the full desktop key list would wrap
            into a clipped wall of text on a small screen */}
        <p className="mx-auto max-w-3xl text-center text-[11px] font-bold tracking-wide text-[#2f2823]/80 sm:hidden">
          Touch: stick moves · drag to look · hold KICK to charge · TRICKS for skills
        </p>
        <div className="mx-auto hidden max-w-3xl flex-wrap items-center justify-center gap-x-4 gap-y-1 text-[11px] font-bold tracking-wide text-[#2f2823]/80 sm:flex">
          <span>WASD move</span>
          <span className="opacity-40">·</span>
          <span>Mouse aim</span>
          <span className="opacity-40">·</span>
          <span>LMB hold = charge kick</span>
          <span className="opacity-40">·</span>
          <span>RMB cut</span>
          <span className="opacity-40">·</span>
          <span>Q stepover</span>
          <span className="opacity-40">·</span>
          <span>F flick</span>
          <span className="opacity-40">·</span>
          <span>C slide tackle</span>
          <span className="opacity-40">·</span>
          <span>E rainbow</span>
          <span className="opacity-40">·</span>
          <span>X roulette</span>
          <span className="opacity-40">·</span>
          <span>V elastico</span>
          <span className="opacity-40">·</span>
          <span>G Cruyff turn</span>
          <span className="opacity-40">·</span>
          <span>B backheel</span>
          <span className="opacity-40">·</span>
          <span>T juggle</span>
          <span className="opacity-40">·</span>
          <span>1–6 EGO supers</span>
          <span className="opacity-40">·</span>
          <span>Shift sprint</span>
        </div>
      </footer>
    </div>
  )
}

function TeamColumn({
  team,
  snap,
  game,
}: {
  team: 'A' | 'B'
  snap: UiState
  game: GameHandle
}) {
  const players = snap.roster.filter((r) => r.team === team)
  const color = team === 'A' ? '#f28a2e' : '#2fa8a0'
  return (
    <div className="flex-1 rounded-xl border-2 border-[#2f2823]/25 bg-white/40 p-2">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="h-3.5 w-3.5 rounded-full border-2 border-[#2f2823]" style={{ background: color }} />
        <span className="font-hand text-xl font-bold">{TEAM_NAME[team]}</span>
        <span className="ml-auto text-xs font-bold opacity-50">{players.length}</span>
      </div>
      <div className="flex min-h-[76px] flex-col gap-1.5">
        {players.map((p) => (
          <button
            key={p.id}
            className={`flex min-h-[38px] w-full items-center gap-1.5 rounded-lg border-2 px-2 py-1 text-left text-sm font-bold transition-colors ${
              snap.isHost ? 'cursor-pointer hover:border-[#2f2823] hover:bg-white/70' : 'cursor-default'
            } ${p.id === snap.myId ? 'border-[#2f2823] bg-white/80' : 'border-[#2f2823]/20 bg-white/50'}`}
            title={snap.isHost ? 'Move player (host)' : undefined}
            onClick={() => {
              if (snap.isHost) game.cmd({ type: 'setTeam', id: p.id, team: team === 'A' ? 'B' : 'A' })
            }}
          >
            {p.isHost && <Crown size={13} className="shrink-0 text-[#b8860b]" />}
            <span className="truncate">{p.name}</span>
            {p.id === snap.myId && <span className="ml-auto text-[10px] tracking-widest uppercase opacity-50">you</span>}
          </button>
        ))}
        {players.length === 0 && (
          <div className="flex min-h-[38px] items-center justify-center rounded-lg border-2 border-dashed border-[#2f2823]/20 text-xs font-semibold opacity-40">
            empty
          </div>
        )}
      </div>
    </div>
  )
}

export function RoomScreen({ game, snap }: ScreenProps) {
  const [copied, setCopied] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const canStart =
    snap.roster.length >= 2 &&
    snap.roster.some((r) => r.team === 'A') &&
    snap.roster.some((r) => r.team === 'B')

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(snap.roomCode)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center overflow-y-auto p-4">
      <div className="gg-panel gg-rise flex w-full max-w-lg flex-col p-6 sm:p-7">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-xs font-bold tracking-[0.25em] uppercase opacity-60">room code</p>
            <p className="font-hand text-5xl leading-none font-bold tracking-[0.18em]">{snap.roomCode}</p>
          </div>
          <button className="gg-btn" onClick={() => void copy()}>
            <Copy size={16} /> {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>

        <div className="mt-2 flex items-center gap-2 text-xs font-bold opacity-70">
          <span className={`h-2.5 w-2.5 rounded-full ${snap.connected ? 'bg-[#3d9a4e]' : 'bg-[#d9a13d] gg-breathe'}`} />
          {snap.connected ? 'connected' : 'connecting…'}
          <span className="opacity-40">·</span>
          <Users size={13} /> {snap.roster.length}/6 players
        </div>

        <div className="mt-4 flex gap-3">
          <TeamColumn team="A" snap={snap} game={game} />
          <TeamColumn team="B" snap={snap} game={game} />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button className="gg-btn text-sm" disabled={!snap.isHost} onClick={() => game.cmd({ type: 'shuffleTeams' })}>
            <Shuffle size={15} /> Shuffle
          </button>
          {snap.isHost ? (
            <button
              className="gg-btn gg-btn-primary flex-1"
              disabled={!canStart}
              onClick={() => game.cmd({ type: 'startMatch' })}
            >
              <Play size={17} strokeWidth={2.6} /> Start match
            </button>
          ) : (
            <div className="gg-breathe flex flex-1 items-center justify-center rounded-xl border-2 border-dashed border-[#2f2823]/30 px-4 py-2 text-sm font-bold opacity-70">
              Waiting for the host to start…
            </div>
          )}
          <button className="gg-btn" onClick={() => game.cmd({ type: 'leaveRoom' })} title="Leave room">
            <LogOut size={16} />
          </button>
        </div>

        {snap.isHost && !canStart && (
          <p className="mt-2 text-center text-xs font-semibold opacity-60">
            Need at least one player per side — hit Shuffle, or tap a name to move them.
          </p>
        )}

        <button
          className="gg-btn mt-3 w-full text-sm"
          onClick={() => setShowSettings((v) => !v)}
          aria-expanded={showSettings}
        >
          <SlidersHorizontal size={15} /> {showSettings ? 'Hide settings' : 'Settings'}
        </button>
        {showSettings && (
          <div className="mt-1 rounded-xl bg-[#2f2823]/5 p-3">
            <SettingsBlock game={game} snap={snap} />
          </div>
        )}

        <div className="mt-4 rounded-xl bg-[#2f2823]/5 p-3 text-[11px] leading-relaxed font-semibold opacity-75">
          <p className="mb-1 font-hand text-base font-bold opacity-80">How to play</p>
          Move with WASD, aim with the mouse. <b>Hold LMB</b> to charge a kick — look down for a driven shot, look
          up for a chip. <b>RMB</b> cuts sideways, <b>Q</b> stepover, <b>F</b> flicks the ball over a tackle,{' '}
          <b>C</b> slide tackles (miss the ball and it&apos;s a foul — penalties included), <b>Shift</b> sprints.
          Flair: <b>E</b> rainbow over your head, <b>Z</b>+LMB rabona, <b>X</b> roulette spin, <b>V</b> elastico,{' '}
          <b>G</b> Cruyff turn, <b>B</b> backheel, <b>T</b> juggle (kick mid-bounce for a volley).
          EGO supers on <b>1–6</b> once your gauge fills: dragon shot, mountain wall, eagle talon, thunder
          seal, zero hour, cyclone.
          Throw-ins, corners, goal kicks, offside — the real rules. First to 5, or most goals after two 3-minute
          halves.
        </div>
      </div>
    </div>
  )
}
