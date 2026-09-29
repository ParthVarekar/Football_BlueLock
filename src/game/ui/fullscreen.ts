/**
 * Fullscreen helpers — the only way to get the browser's address bar and
 * toolbars out of the way. Phones also get the screen locked to landscape
 * (where the browser allows it; iOS Safari ignores both, so it falls back to
 * "Add to Home Screen", which launches fullscreen via the web-app manifest).
 */
type FsDoc = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void }
type FsEl = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

export function isFullscreen(): boolean {
  const d = document as FsDoc
  return !!(d.fullscreenElement ?? d.webkitFullscreenElement)
}

export function fullscreenSupported(): boolean {
  const el = document.documentElement as FsEl
  return typeof el.requestFullscreen === 'function' || typeof el.webkitRequestFullscreen === 'function'
}

/** Must be called from a user gesture (tap / click / key). Never throws. */
export async function enterFullscreen(lockLandscape: boolean): Promise<void> {
  const el = document.documentElement as FsEl
  try {
    if (!isFullscreen()) {
      if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' })
      else await el.webkitRequestFullscreen?.()
    }
  } catch {
    return
  }
  if (lockLandscape) {
    try {
      const o = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }
      await o.lock?.('landscape')
    } catch {
      /* not allowed here — the rotate hint covers it */
    }
  }
}

export async function exitFullscreen(): Promise<void> {
  const d = document as FsDoc
  try {
    if (d.fullscreenElement) await d.exitFullscreen()
    else await d.webkitExitFullscreen?.()
  } catch {
    /* already out */
  }
}
