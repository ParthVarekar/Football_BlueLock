/**
 * Player settings — persisted in localStorage, hot-swappable at runtime.
 * FOV + mouse sensitivity + invert-Y + graphics quality + volume.
 */
import type { Quality } from './constants'

export interface GameSettings {
  /** Base camera FOV in degrees (60..100). */
  fov: number
  /** Mouse / touch look sensitivity multiplier (0.25..3). */
  sens: number
  /** Invert vertical look. */
  invertY: boolean
  /** Graphics quality preset. */
  quality: Quality
  /** Master volume 0..1. */
  volume: number
}

export type GameSettingsPatch = Partial<GameSettings>

const KEY = 'gg-settings-v1'

export const SETTINGS_LIMITS = {
  fov: { min: 60, max: 100, step: 1 },
  sens: { min: 0.25, max: 3, step: 0.05 },
  volume: { min: 0, max: 1, step: 0.05 },
} as const

function defaultQuality(): Quality {
  if (typeof window === 'undefined') return 'high'
  const touch = window.matchMedia?.('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
  return touch ? 'low' : 'high'
}

export function defaultSettings(): GameSettings {
  return {
    fov: 78,
    sens: 1,
    invertY: false,
    quality: defaultQuality(),
    volume: 0.9,
  }
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

/** Parse + sanitize settings from untrusted storage. */
export function parseSettings(raw: unknown): GameSettings {
  const d = defaultSettings()
  if (typeof raw !== 'object' || raw === null) return d
  const r = raw as Record<string, unknown>
  const q = r.quality
  return {
    fov: Math.round(clampNumber(r.fov, SETTINGS_LIMITS.fov.min, SETTINGS_LIMITS.fov.max, d.fov)),
    sens: clampNumber(r.sens, SETTINGS_LIMITS.sens.min, SETTINGS_LIMITS.sens.max, d.sens),
    invertY: typeof r.invertY === 'boolean' ? r.invertY : d.invertY,
    quality: q === 'low' || q === 'medium' || q === 'high' ? q : d.quality,
    volume: clampNumber(r.volume, 0, 1, d.volume),
  }
}

export function loadSettings(): GameSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return defaultSettings()
    return parseSettings(JSON.parse(raw))
  } catch {
    return defaultSettings()
  }
}

export function saveSettings(s: GameSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* private mode — settings live for this tab only */
  }
}

/** Quality preset labels for the UI. */
export const QUALITY_LABELS: Array<{ id: Quality; label: string; blurb: string }> = [
  { id: 'low', label: 'Low', blurb: 'Best for phones & weak laptops — no ink outlines, fewer props' },
  { id: 'medium', label: 'Medium', blurb: 'Balanced — thinner outlines, softer shadows' },
  { id: 'high', label: 'High', blurb: 'The full hand-painted look — thick ink, full props' },
]
