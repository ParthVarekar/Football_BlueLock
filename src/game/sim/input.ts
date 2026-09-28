/**
 * Input: keyboard + pointer-lock mouse on desktop, bridged touch on mobile.
 * Edge events (kick release, cut, stepover, flick, pause) are consumed on poll.
 *
 * If pointer lock is unavailable (iOS, some webviews, headless), we fall back
 * to drag-look: hold any mouse button and move to aim. RMB click without drag
 * still performs a cut.
 */
export interface InputFrame {
  moveX: number
  moveY: number
  sprint: boolean
  chargeHeld: boolean
  chargeTime: number
  kickRelease: boolean
  kickReleasePower: number
  cutPressed: boolean
  stepPressed: boolean
  flickPressed: boolean
  slidePressed: boolean
  rainbowPressed: boolean
  rabonaPressed: boolean
  roulettePressed: boolean
  elasticoPressed: boolean
  crouyffPressed: boolean
  backheelPressed: boolean
  jugglePressed: boolean
  /** EGO super requested this frame: 1..6, 0 = none (keys 1–6 / touch tray). */
  superPressed: number
  pausePressed: boolean
  practiceReset: boolean
  lookDx: number
  lookDy: number
}

export class InputManager {
  private keys = new Set<string>()
  private chargeHeld = false
  private chargeTime = 0
  private kickRelease = false
  private lastChargeTime = 0
  private cutPressed = false
  private stepPressed = false
  private flickPressed = false
  private slidePressed = false
  private rainbowPressed = false
  private rabonaPressed = false
  private roulettePressed = false
  private elasticoPressed = false
  private crouyffPressed = false
  private backheelPressed = false
  private jugglePressed = false
  private superPressed = 0
  private pausePressed = false
  private practiceReset = false
  private lookDx = 0
  private lookDy = 0

  private touchMoveX = 0
  private touchMoveY = 0
  private touchSprint = false
  private touchCharge = false
  private touchChargeTime = 0

  private rmbDown = false
  private rmbDownAt = 0
  private rmbDragDist = 0
  private anyDragLook = false
  private lockFallbackTimer = 0

  private el: HTMLElement
  private onLockChange: () => void
  lookMode: 'lock' | 'drag' = 'lock'
  private _pointerLocked = false
  /** Set by the Game: only capture charge input while in active play. */
  inputEnabled = true

  constructor(el: HTMLElement, private readonly onRequestPause: () => void) {
    this.el = el
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    el.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('mouseup', this.onMouseUp)
    window.addEventListener('mousemove', this.onMouseMove)
    el.addEventListener('contextmenu', this.onContextMenu)
    this.onLockChange = () => {
      const was = this._pointerLocked
      this._pointerLocked = document.pointerLockElement === el
      // Esc exits pointer lock mid-match -> show the menu
      if (was && !this._pointerLocked) this.onRequestPause()
      if (!this._pointerLocked && this.chargeHeld) {
        this.chargeHeld = false
        this.kickRelease = false // cancelled, not fired
        this.chargeTime = 0
      }
    }
    document.addEventListener('pointerlockchange', this.onLockChange)
  }

  get pointerLocked(): boolean {
    return this._pointerLocked
  }

  requestLock(): void {
    const anyEl = this.el as HTMLElement & { requestPointerLock?: (opts?: unknown) => Promise<void> | void }
    if (!anyEl.requestPointerLock) {
      this.lookMode = 'drag'
      return
    }
    // some browsers "accept" the request but never lock (webviews, headless) —
    // if no lock materialises shortly, fall back to drag-look
    window.clearTimeout(this.lockFallbackTimer)
    this.lockFallbackTimer = window.setTimeout(() => {
      if (document.pointerLockElement !== this.el) this.lookMode = 'drag'
    }, 350)
    try {
      const r = anyEl.requestPointerLock({ unadjustedMovement: true })
      if (r && typeof (r as Promise<void>).catch === 'function') {
        ;(r as Promise<void>).catch(() => {
          try {
            const r2 = anyEl.requestPointerLock?.()
            if (r2 && typeof (r2 as Promise<void>).catch === 'function') {
              ;(r2 as Promise<void>).catch(() => undefined)
            }
          } catch {
            this.lookMode = 'drag'
          }
        })
      }
    } catch {
      try {
        anyEl.requestPointerLock()
      } catch {
        this.lookMode = 'drag'
      }
    }
  }

  exitLock(): void {
    if (document.pointerLockElement) document.exitPointerLock()
  }

  // ------------------------------------------------------------------ desktop
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return
    this.trackKey(e, true)
    const k = this.keyName(e)
    if (k === 'KeyQ') this.stepPressed = this.inputEnabled && true
    if (k === 'KeyF') this.flickPressed = this.inputEnabled && true
    if (k === 'KeyC' || k === 'ControlLeft' || k === 'ControlRight') this.slidePressed = this.inputEnabled && true
    if (k === 'KeyE') this.rainbowPressed = this.inputEnabled && true
    if (k === 'KeyZ') this.rabonaPressed = this.inputEnabled && true
    if (k === 'KeyX') this.roulettePressed = this.inputEnabled && true
    if (k === 'KeyV') this.elasticoPressed = this.inputEnabled && true
    if (k === 'KeyG') this.crouyffPressed = this.inputEnabled && true
    if (k === 'KeyB') this.backheelPressed = this.inputEnabled && true
    if (k === 'KeyT') this.jugglePressed = this.inputEnabled && true
    if (k === 'KeyR') this.practiceReset = true
    // EGO supers on the number row (and numpad)
    const digit = /^(?:Digit|Numpad)([1-6])$/.exec(k)
    if (digit && this.inputEnabled) this.superPressed = Number(digit[1])
    if (k === 'KeyP') {
      this.pausePressed = true
      this.onRequestPause()
    }
    if (e.key === 'Escape' && !this._pointerLocked) {
      this.pausePressed = true
      this.onRequestPause()
    }
    if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault()
  }

  private onKeyUp = (e: KeyboardEvent) => {
    this.trackKey(e, false)
  }

  /** Accept both e.code and normalized e.key so odd keyboards / synthetic events work. */
  private keyName(e: KeyboardEvent): string {
    if (e.code) return e.code
    if (e.key) {
      const k = e.key.toLowerCase()
      if (k.length === 1 && k >= 'a' && k <= 'z') return `Key${k.toUpperCase()}`
      return k
    }
    return ''
  }

  private trackKey(e: KeyboardEvent, down: boolean): void {
    const names = new Set<string>()
    const n = this.keyName(e)
    if (n) names.add(n)
    if (e.key && e.key.length === 1) names.add(`Key${e.key.toUpperCase()}`)
    if (e.key === 'Shift') names.add('ShiftLeft')
    for (const name of names) {
      if (down) this.keys.add(name)
      else this.keys.delete(name)
    }
  }

  private onBlur = () => {
    this.keys.clear()
    this.chargeHeld = false
    this.touchCharge = false
    this.rmbDown = false
    this.touchMoveX = 0
    this.touchMoveY = 0
    this.touchSprint = false
  }

  private onContextMenu = (e: Event) => e.preventDefault()

  private onMouseDown = (e: MouseEvent) => {
    if (!this.inputEnabled) return
    // any click on the canvas tries to capture the mouse (lock mode) — that
    // first "capture click" must NOT also fire a tap-kick
    let captureClick = false
    if (this.lookMode === 'lock' && !this._pointerLocked && document.pointerLockElement === null) {
      this.requestLock()
      captureClick = true
    }
    if (e.button === 0) {
      if (!captureClick && (this._pointerLocked || this.lookMode === 'drag')) {
        this.chargeHeld = true
        this.chargeTime = 0
      }
    } else if (e.button === 2) {
      this.rmbDown = true
      this.rmbDownAt = performance.now()
      this.rmbDragDist = 0
    }
  }

  private onMouseUp = (e: MouseEvent) => {
    if (e.button === 0) {
      if (this.chargeHeld) {
        this.kickRelease = true
        this.lastChargeTime = this.chargeTime
      }
      this.chargeHeld = false
    } else if (e.button === 2) {
      const quick = performance.now() - this.rmbDownAt < 260 && this.rmbDragDist < 7
      if (quick && this.inputEnabled) this.cutPressed = true
      this.rmbDown = false
    }
  }

  private onMouseMove = (e: MouseEvent) => {
    if (!this.inputEnabled) return
    if (this._pointerLocked) {
      this.lookDx += e.movementX
      this.lookDy += e.movementY
    } else if (this.lookMode === 'drag' && (e.buttons & 7) !== 0) {
      // any held button drags the view (left, right, middle)
      this.anyDragLook = true
      this.lookDx += e.movementX
      this.lookDy += e.movementY
      if (this.rmbDown) this.rmbDragDist += Math.abs(e.movementX) + Math.abs(e.movementY)
    }
  }

  // ------------------------------------------------------------------ touch bridge
  setTouchMove(x: number, y: number): void {
    this.touchMoveX = x
    this.touchMoveY = y
  }
  addTouchLook(dx: number, dy: number): void {
    this.lookDx += dx
    this.lookDy += dy
  }
  setTouchSprint(on: boolean): void {
    this.touchSprint = on
  }
  setTouchCharge(on: boolean): void {
    if (on && !this.touchCharge) {
      this.touchCharge = true
      this.touchChargeTime = 0
    } else if (!on && this.touchCharge) {
      this.touchCharge = false
      this.kickRelease = true
      this.lastChargeTime = this.touchChargeTime
    }
  }
  triggerCut(): void {
    if (this.inputEnabled) this.cutPressed = true
  }
  triggerStep(): void {
    if (this.inputEnabled) this.stepPressed = true
  }
  triggerFlick(): void {
    if (this.inputEnabled) this.flickPressed = true
  }
  triggerSlide(): void {
    if (this.inputEnabled) this.slidePressed = true
  }
  triggerRainbow(): void {
    if (this.inputEnabled) this.rainbowPressed = true
  }
  triggerRabona(): void {
    if (this.inputEnabled) this.rabonaPressed = true
  }
  triggerRoulette(): void {
    if (this.inputEnabled) this.roulettePressed = true
  }
  triggerElastico(): void {
    if (this.inputEnabled) this.elasticoPressed = true
  }
  triggerCrouyff(): void {
    if (this.inputEnabled) this.crouyffPressed = true
  }
  triggerBackheel(): void {
    if (this.inputEnabled) this.backheelPressed = true
  }
  triggerJuggle(): void {
    if (this.inputEnabled) this.jugglePressed = true
  }
  triggerSuper(kind: number): void {
    if (this.inputEnabled && kind >= 1 && kind <= 6) this.superPressed = kind
  }
  /**
   * Consume an in-progress charge WITHOUT firing the release — used by the
   * rabona (Z executes the kick itself). Returns the elapsed charge seconds.
   */
  cancelCharge(): number {
    const t = this.chargeHeld ? this.chargeTime : this.touchCharge ? this.touchChargeTime : 0
    this.chargeHeld = false
    this.touchCharge = false
    this.chargeTime = 0
    this.touchChargeTime = 0
    this.kickRelease = false
    return t
  }
  triggerPause(): void {
    this.pausePressed = true
    this.onRequestPause()
  }

  // ------------------------------------------------------------------ poll
  poll(dt: number): InputFrame {
    if (this.chargeHeld) this.chargeTime += dt
    if (this.touchCharge) this.touchChargeTime += dt

    let mx = 0
    let my = 0
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) mx -= 1
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) mx += 1
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) my += 1
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) my -= 1
    mx += this.touchMoveX
    my += this.touchMoveY
    const len = Math.hypot(mx, my)
    if (len > 1) {
      mx /= len
      my /= len
    }

    const sprint = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.touchSprint
    const chargeHeld = (this.chargeHeld || this.touchCharge) && this.inputEnabled

    const frame: InputFrame = {
      moveX: mx,
      moveY: my,
      sprint,
      chargeHeld,
      chargeTime: this.chargeHeld ? this.chargeTime : this.touchChargeTime,
      kickRelease: this.kickRelease,
      kickReleasePower: this.lastChargeTime,
      cutPressed: this.cutPressed,
      stepPressed: this.stepPressed,
      flickPressed: this.flickPressed,
      slidePressed: this.slidePressed,
      rainbowPressed: this.rainbowPressed,
      rabonaPressed: this.rabonaPressed,
      roulettePressed: this.roulettePressed,
      elasticoPressed: this.elasticoPressed,
      crouyffPressed: this.crouyffPressed,
      backheelPressed: this.backheelPressed,
      jugglePressed: this.jugglePressed,
      superPressed: this.superPressed,
      pausePressed: this.pausePressed,
      practiceReset: this.practiceReset,
      lookDx: this.lookDx,
      lookDy: this.lookDy,
    }

    this.kickRelease = false
    this.cutPressed = false
    this.stepPressed = false
    this.flickPressed = false
    this.slidePressed = false
    this.rainbowPressed = false
    this.rabonaPressed = false
    this.roulettePressed = false
    this.elasticoPressed = false
    this.crouyffPressed = false
    this.backheelPressed = false
    this.jugglePressed = false
    this.superPressed = 0
    this.pausePressed = false
    this.practiceReset = false
    this.lookDx = 0
    this.lookDy = 0
    return frame
  }

  get usedDragLook(): boolean {
    return this.anyDragLook || this.lookMode === 'drag'
  }

  dispose(): void {
    window.clearTimeout(this.lockFallbackTimer)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    this.el.removeEventListener('mousedown', this.onMouseDown)
    window.removeEventListener('mouseup', this.onMouseUp)
    window.removeEventListener('mousemove', this.onMouseMove)
    this.el.removeEventListener('contextmenu', this.onContextMenu)
    document.removeEventListener('pointerlockchange', this.onLockChange)
  }
}
