/**
 * Control panel: builds the rail UI, owns the UI-bound state (composite /
 * selection / transform / expression / toggles) and reports changes through
 * callbacks.
 *
 * This module is view-only: the engine (src/main.ts and the modules under
 * camera/ tracking/ avatar/ compose/ export/) reads the getters and reacts to
 * the callbacks. No rendering logic lives here.
 */
import {
  BLUR_DEFAULT_PX,
  BLUR_MAX_PX,
  BLUR_MIN_PX,
  COMPOSITE_DEFAULTS,
  SELECTION_DEFAULTS,
  SETTINGS_VERSION,
  TRANSFORM_DEFAULTS,
  selectionHandlePx,
  selectionRect,
  type MaskShape,
  type ModelTransform,
  type PersistedSettings,
  type SelRect,
  type Selection,
} from '../config'

export interface ExpressionState {
  jaw: number
  blink: number
  smile: number
  brow: number
  tongue: number
  yaw: number
}

export interface ControlsCallbacks {
  onStartCamera(): void
  onStopCamera(): void
  /** A composite/selection/blur setting changed — re-apply and redraw. */
  onRefresh(): void
  /** A model-transform slider changed. */
  onTransform(): void
  /** A manual-expression slider changed. */
  onExpression(): void
  onResetView(): void
  /** Background blur was enabled — lazily load the segmenter. */
  onBlurEnable(): void
  /** Record button toggled (start when idle, stop + save when active). */
  onToggleRecord(): void
  /** Screenshot button pressed — save a PNG of the output. */
  onScreenshot(): void
  /** Import-model button pressed — open the native GLB picker. */
  onImportModel(): void
  /** The "output window when minimized" checkbox changed. */
  onTogglePip(): void
  /** The "minimize to tray" checkbox changed. */
  onToggleMinimizeToTray(): void
  /** The "recording mode" checkbox changed. */
  onToggleRecordingMode(): void
  /** A user change occurred that should be persisted (debounced by the caller). */
  onStateChange?(): void
}

interface RangeSpec {
  key: string
  label: string
  min: number
  max: number
  step: number
  value: number
  decimals: number
}

type RangeKind = 'refresh' | 'transform' | 'expression'

type StatusState = 'idle' | 'warn' | 'ok' | 'err'

type SelHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** Minimum selection size, in composite-buffer pixels. Also used as the
 *  width/height slider minimum so resize handles and sliders share one bound. */
const MIN_SEL_PX = 50

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

const PLACEHOLDER = '\u2014' // em dash

/** Map a free-text status line onto a status-dot colour. */
function statusState(text: string): StatusState {
  const t = text.toLowerCase()
  if (/fail|error|denied|unavailable|unusable|problem|blocked/.test(t)) return 'err'
  if (/ready|running|active|complete|saved/.test(t)) return 'ok'
  if (/load|request|init|start|wait|prepar/.test(t)) return 'warn'
  return 'idle'
}

export class HarnessControls {
  private readonly inputs = new Map<string, HTMLInputElement | HTMLSelectElement>()
  private readonly readouts = new Map<string, HTMLElement>()
  private readonly statusLine = document.createElement('div')
  private readonly statusText = document.createElement('span')
  private readonly statusDevice = document.createElement('span')
  private readonly resEl = document.createElement('span')
  private readonly fpsEl = document.createElement('span')
  private readonly latEl = document.createElement('span')
  private readonly faceEl = document.createElement('span')
  private readonly ptsEl = document.createElement('span')
  private readonly devStatEl = document.createElement('span')
  private readonly startBtn = document.createElement('button')
  private readonly stopBtn = document.createElement('button')
  private readonly recordBtn = document.getElementById('btn-record')
  private readonly screenshotBtn = document.getElementById('btn-screenshot')
  private readonly importBtn = document.getElementById('btn-import-model')
  private readonly toastEl = document.getElementById('toast')
  private toastTimer: number | null = null
  /** Width/height ratio captured when "keep aspect ratio" is switched on (0 = off). */
  private aspectRatio = 0
  /** The readout currently in inline-edit mode, if any (single-editor guard). */
  private activeEditor: ((commit: boolean) => void) | null = null
  /** True while `applyState` writes inputs; suppresses autosave notifications. */
  private applying = false
  private readonly callbacks: ControlsCallbacks
  private readonly preview: HTMLElement | null

  constructor(container: HTMLElement, preview: HTMLElement | null, callbacks: ControlsCallbacks) {
    this.callbacks = callbacks
    this.preview = preview

    this.startBtn.type = 'button'
    this.startBtn.className = 'btn btn-primary'
    this.startBtn.textContent = 'Start camera'
    this.stopBtn.type = 'button'
    this.stopBtn.className = 'btn'
    this.stopBtn.textContent = 'Stop'
    this.startBtn.addEventListener('click', () => this.callbacks.onStartCamera())
    this.stopBtn.addEventListener('click', () => this.callbacks.onStopCamera())
    this.recordBtn?.addEventListener('click', () => this.callbacks.onToggleRecord())
    this.screenshotBtn?.addEventListener('click', () => this.callbacks.onScreenshot())
    this.importBtn?.addEventListener('click', () => this.callbacks.onImportModel())

    this.buildStatusLine()
    this.build(container)

    // Composite defaults to mirrored, so the preview must match at boot.
    this.preview?.classList.toggle('mirror', this.check('c_mirror'))
  }

  // ---- state getters ----

  get mirror(): boolean {
    return this.check('c_mirror')
  }

  get showLandmarks(): boolean {
    return this.check('c_lm')
  }

  get showMesh(): boolean {
    return this.check('c_mesh')
  }

  get blurOn(): boolean {
    return this.check('blur_on')
  }

  get pipEnabled(): boolean {
    return this.check('pip_on')
  }

  get minimizeToTray(): boolean {
    return this.check('tray_min')
  }

  get recordingMode(): boolean {
    return this.check('rec_mode')
  }

  get blurInvert(): boolean {
    return this.check('blur_invert')
  }

  get blurPx(): number {
    return this.num('blur_px')
  }

  get composite(): { on: boolean; size: number; dx: number; dy: number } {
    return {
      on: this.check('cp_on'),
      size: this.num('cp_size'),
      dx: this.num('cp_dx'),
      dy: this.num('cp_dy'),
    }
  }

  get selection(): Selection {
    return {
      w: this.num('sel_w'),
      h: this.num('sel_h'),
      cx: this.num('sel_x'),
      cy: this.num('sel_y'),
      mul: this.num('sel_mul'),
      mask: this.selectValue('sel_mask') as MaskShape,
      radius: this.num('sel_radius'),
      feather: this.num('sel_feather'),
      keepAspect: this.check('sel_keep_aspect'),
    }
  }

  get transform(): ModelTransform {
    return {
      scale: this.num('t_scale'),
      x: this.num('t_x'),
      y: this.num('t_y'),
      z: this.num('t_z'),
    }
  }

  get expressions(): ExpressionState {
    return {
      jaw: this.num('s_jaw'),
      blink: this.num('s_blink'),
      smile: this.num('s_smile'),
      brow: this.num('s_brow'),
      tongue: this.num('s_tongue'),
      yaw: this.num('s_yaw'),
    }
  }

  // ---- persisted state ----

  /** Snapshot of every persisted (non-expression) setting. */
  getState(): PersistedSettings {
    return {
      version: SETTINGS_VERSION,
      mirror: this.mirror,
      landmarks: this.showLandmarks,
      mesh: this.showMesh,
      blur: { on: this.blurOn, invert: this.blurInvert, px: this.blurPx },
      composite: this.composite,
      selection: this.selection,
      transform: this.transform,
      pipEnabled: this.pipEnabled,
      minimizeToTray: this.minimizeToTray,
    }
  }

  /**
   * Restore persisted state. Selection dimensions and `keepAspect` are applied
   * in one `setSelection` call so the aspect ratio is captured from the
   * restored (already clamped) dimensions. Programmatic writes must not feed
   * the autosave loop, so `onStateChange` is suppressed while applying.
   */
  applyState(s: PersistedSettings | Partial<PersistedSettings>): void {
    this.applying = true
    try {
      const sel = s.selection
      if (sel) {
        const partial: Partial<Selection> = {}
        if (typeof sel.w === 'number') partial.w = sel.w
        if (typeof sel.h === 'number') partial.h = sel.h
        if (typeof sel.cx === 'number') partial.cx = sel.cx
        if (typeof sel.cy === 'number') partial.cy = sel.cy
        if (typeof sel.mul === 'number') partial.mul = sel.mul
        if (sel.mask === 'none' || sel.mask === 'round' || sel.mask === 'circle') {
          partial.mask = sel.mask
        }
        if (typeof sel.radius === 'number') partial.radius = sel.radius
        if (typeof sel.feather === 'number') partial.feather = sel.feather
        if (typeof sel.keepAspect === 'boolean') partial.keepAspect = sel.keepAspect
        // Single call: w/h land before keepAspect captures the ratio.
        this.setSelection(partial)
      }

      if (typeof s.mirror === 'boolean') {
        this.setCheck('c_mirror', s.mirror)
        this.preview?.classList.toggle('mirror', s.mirror)
      }
      if (typeof s.landmarks === 'boolean') this.setCheck('c_lm', s.landmarks)
      if (typeof s.mesh === 'boolean') this.setCheck('c_mesh', s.mesh)

      if (s.blur) {
        if (typeof s.blur.on === 'boolean') {
          this.setCheck('blur_on', s.blur.on)
          if (s.blur.on) this.callbacks.onBlurEnable()
        }
        if (typeof s.blur.invert === 'boolean') this.setCheck('blur_invert', s.blur.invert)
        if (typeof s.blur.px === 'number') this.setInputValue('blur_px', s.blur.px)
      }

      if (s.composite) {
        if (typeof s.composite.on === 'boolean') this.setCheck('cp_on', s.composite.on)
        if (typeof s.composite.size === 'number') this.setInputValue('cp_size', s.composite.size)
        if (typeof s.composite.dx === 'number') this.setInputValue('cp_dx', s.composite.dx)
        if (typeof s.composite.dy === 'number') this.setInputValue('cp_dy', s.composite.dy)
      }

      if (s.transform) {
        if (typeof s.transform.scale === 'number') this.setInputValue('t_scale', s.transform.scale)
        if (typeof s.transform.x === 'number') this.setInputValue('t_x', s.transform.x)
        if (typeof s.transform.y === 'number') this.setInputValue('t_y', s.transform.y)
        if (typeof s.transform.z === 'number') this.setInputValue('t_z', s.transform.z)
      }

      if (typeof s.pipEnabled === 'boolean') {
        this.setCheck('pip_on', s.pipEnabled)
        this.callbacks.onTogglePip()
      }
      if (typeof s.minimizeToTray === 'boolean') {
        this.setCheck('tray_min', s.minimizeToTray)
        this.callbacks.onToggleMinimizeToTray()
      }

      // Redraw from the applied values. Keep `applying` set so this can never
      // feed the autosave loop (onRefresh is not an onStateChange source).
      this.callbacks.onRefresh()
    } finally {
      this.applying = false
    }
  }

  /** Notify the owner of a user change (ignored while applyState is running). */
  private notifyChange(): void {
    if (this.applying) return
    this.callbacks.onStateChange?.()
  }

  // ---- setters ----

  setSelection(partial: Partial<Selection>): void {
    const map: Array<[keyof Selection, string]> = [
      ['w', 'sel_w'],
      ['h', 'sel_h'],
      ['cx', 'sel_x'],
      ['cy', 'sel_y'],
      ['mul', 'sel_mul'],
      ['radius', 'sel_radius'],
      ['feather', 'sel_feather'],
    ]
    for (const [prop, key] of map) {
      const v = partial[prop]
      if (typeof v === 'number') this.setInputValue(key, v)
    }
    if (partial.mask) this.setInputValue('sel_mask', partial.mask)
    if (typeof partial.keepAspect === 'boolean') {
      const el = this.inputs.get('sel_keep_aspect')
      if (el instanceof HTMLInputElement) el.checked = partial.keepAspect
      this.aspectRatio = partial.keepAspect ? this.num('sel_w') / Math.max(1, this.num('sel_h')) : 0
    }
  }

  setSelectionCenter(cx: number, cy: number): void {
    this.setInputValue('sel_x', cx)
    this.setInputValue('sel_y', cy)
  }

  /**
   * Keep width/height locked together while "keep aspect ratio" is on. The
   * moved slider stays within its feasible sub-range so the derived dimension
   * never leaves its own [min,max] — the ratio always holds exactly.
   */
  private syncAspect(key: string): void {
    if (!this.check('sel_keep_aspect')) return
    const aspect = this.aspectRatio
    if (!(aspect > 0)) return
    const [wMin, wMax] = this.rangeBounds('sel_w')
    const [hMin, hMax] = this.rangeBounds('sel_h')
    if (key === 'sel_w') {
      const lo = Math.max(wMin, hMin * aspect)
      const hi = Math.min(wMax, hMax * aspect)
      const w = clamp(this.num('sel_w'), lo, hi)
      this.setInputValue('sel_w', Math.round(w))
      this.setInputValue('sel_h', Math.round(w / aspect))
    } else if (key === 'sel_h') {
      const lo = Math.max(hMin, wMin / aspect)
      const hi = Math.min(hMax, wMax / aspect)
      const h = clamp(this.num('sel_h'), lo, hi)
      this.setInputValue('sel_h', Math.round(h))
      this.setInputValue('sel_w', Math.round(h * aspect))
    }
  }

  /** [min, max] of a range input, used by the aspect coupling. */
  private rangeBounds(key: string): [number, number] {
    const el = this.inputs.get(key)
    if (!(el instanceof HTMLInputElement)) return [0, 1]
    const min = Number(el.min)
    const max = Number(el.max)
    return [isFinite(min) ? min : 0, isFinite(max) ? max : 1]
  }

  setRunning(running: boolean): void {
    this.startBtn.disabled = running
    this.startBtn.textContent = running ? 'Running' : 'Start camera'
    this.stopBtn.disabled = !running
  }

  /** Reflect the recording state on the record button (class + aria). */
  setRecording(active: boolean): void {
    this.recordBtn?.classList.toggle('is-recording', active)
    this.recordBtn?.setAttribute('aria-pressed', active ? 'true' : 'false')
  }

  /** Show a transient toast; auto-hides after ~2.5s. */
  showToast(message: string, kind?: 'success' | 'error'): void {
    const el = this.toastEl
    if (!el) return
    el.textContent = message
    if (kind) el.dataset.kind = kind
    else delete el.dataset.kind
    el.classList.add('is-visible')
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer)
    this.toastTimer = window.setTimeout(() => {
      el.classList.remove('is-visible')
      this.toastTimer = null
    }, 2500)
  }

  setStatus(text: string): void {
    this.statusText.textContent = text
    this.statusLine.dataset.state = statusState(text)
  }

  setDevice(label: string): void {
    this.statusDevice.textContent = label
    this.devStatEl.textContent = label
  }

  setResolution(w: number, h: number): void {
    this.resEl.textContent = w && h ? `${w}\u00d7${h}` : PLACEHOLDER
  }

  setStats(fps: number, detectionMs: number, faceFound: boolean, points: number): void {
    this.fpsEl.textContent = fps.toFixed(1)
    this.latEl.textContent = detectionMs.toFixed(0) + ' ms'
    this.faceEl.textContent = faceFound ? 'yes' : 'no'
    this.ptsEl.textContent = faceFound ? String(points) : PLACEHOLDER
  }

  resetStats(): void {
    this.resEl.textContent = PLACEHOLDER
    this.fpsEl.textContent = PLACEHOLDER
    this.latEl.textContent = PLACEHOLDER
    this.faceEl.textContent = PLACEHOLDER
    this.ptsEl.textContent = PLACEHOLDER
    this.devStatEl.textContent = PLACEHOLDER
    this.statusDevice.textContent = PLACEHOLDER
  }

  /** Wire drag-to-move and drag-to-resize on the composite view. */
  attachSelectionDrag(composite: HTMLCanvasElement): void {
    const cursorFor: Record<SelHandle, string> = {
      nw: 'nwse-resize',
      se: 'nwse-resize',
      ne: 'nesw-resize',
      sw: 'nesw-resize',
      e: 'ew-resize',
      w: 'ew-resize',
      n: 'ns-resize',
      s: 'ns-resize',
    }

    /** Pointer position mapped to composite-buffer pixels. */
    const bufferPoint = (ev: PointerEvent): { x: number; y: number } | null => {
      const rect = composite.getBoundingClientRect()
      if (!rect.width || !rect.height || !composite.width || !composite.height) return null
      return {
        x: ((ev.clientX - rect.left) / rect.width) * composite.width,
        y: ((ev.clientY - rect.top) / rect.height) * composite.height,
      }
    }

    const currentRect = (): SelRect => selectionRect(this.selection, composite.width, composite.height)

    const pointsFor = (r: SelRect): Array<{ id: SelHandle; x: number; y: number }> => [
      { id: 'nw', x: r.x, y: r.y },
      { id: 'ne', x: r.x + r.w, y: r.y },
      { id: 'se', x: r.x + r.w, y: r.y + r.h },
      { id: 'sw', x: r.x, y: r.y + r.h },
      { id: 'n', x: r.x + r.w / 2, y: r.y },
      { id: 'e', x: r.x + r.w, y: r.y + r.h / 2 },
      { id: 's', x: r.x + r.w / 2, y: r.y + r.h },
      { id: 'w', x: r.x, y: r.y + r.h / 2 },
    ]

    /** Nearest handle within a comfortable buffer-pixel tolerance. */
    const hitHandle = (p: { x: number; y: number }, r: SelRect): SelHandle | null => {
      const tolerance = Math.max(12, selectionHandlePx(composite.width))
      let best: SelHandle | null = null
      let bestDist = Infinity
      for (const h of pointsFor(r)) {
        const d = Math.hypot(p.x - h.x, p.y - h.y)
        if (d <= tolerance && d < bestDist) {
          bestDist = d
          best = h.id
        }
      }
      return best
    }

    const inside = (p: { x: number; y: number }, r: SelRect): boolean =>
      p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h

    let mode: 'none' | 'move' | 'resize' = 'none'
    let active: SelHandle | null = null
    let start: SelRect = { x: 0, y: 0, w: 0, h: 0 }
    let aspect = 0
    let centerX = 0
    let centerY = 0

    const setCursor = (ev: PointerEvent, p: { x: number; y: number } | null): void => {
      if (ev.pointerType === 'touch') return
      const r = currentRect()
      const handle = p ? hitHandle(p, r) : null
      composite.style.cursor = handle ? cursorFor[handle] : p && inside(p, r) ? 'move' : 'crosshair'
    }

    const applyMove = (p: { x: number; y: number }): void => {
      const cx = clamp(p.x / composite.width, 0, 1)
      const cy = clamp(p.y / composite.height, 0, 1)
      this.setSelectionCenter(cx, cy)
      this.callbacks.onRefresh()
    }

    /** Commit a buffer-space rect back into the inputs (w/h + normalised centre). */
    const writeRect = (left: number, top: number, w: number, h: number): void => {
      const cw = composite.width
      const ch = composite.height
      // Clamp to the same [min,max] the sliders advertise, so the overlay,
      // inputs and stored selection can never disagree.
      const [wMin, wMax] = this.rangeBounds('sel_w')
      const [hMin, hMax] = this.rangeBounds('sel_h')
      const rw = clamp(Math.round(w), wMin, wMax)
      const rh = clamp(Math.round(h), hMin, hMax)
      const cx = clamp((left + rw / 2) / cw, 0, 1)
      const cy = clamp((top + rh / 2) / ch, 0, 1)
      this.setInputValue('sel_w', rw)
      this.setInputValue('sel_h', rh)
      this.setSelectionCenter(Math.round(cx * 1000) / 1000, Math.round(cy * 1000) / 1000)
      this.callbacks.onRefresh()
    }

    const applyResize = (p: { x: number; y: number }): void => {
      if (!active) return
      const cw = composite.width
      const ch = composite.height
      const r = start
      const leftSide = active === 'w' || active === 'nw' || active === 'sw'
      const rightSide = active === 'e' || active === 'ne' || active === 'se'
      const topSide = active === 'n' || active === 'nw' || active === 'ne'
      const bottomSide = active === 's' || active === 'sw' || active === 'se'
      const horizontal = leftSide || rightSide
      const vertical = topSide || bottomSide

      if (!(aspect > 0)) {
        // Free resize: the opposite edges stay put; clamp each moving edge.
        let left = r.x
        let right = r.x + r.w
        let top = r.y
        let bottom = r.y + r.h
        if (leftSide) left = clamp(p.x, 0, Math.max(0, right - MIN_SEL_PX))
        if (rightSide) right = clamp(p.x, left + MIN_SEL_PX, cw)
        if (topSide) top = clamp(p.y, 0, Math.max(0, bottom - MIN_SEL_PX))
        if (bottomSide) bottom = clamp(p.y, top + MIN_SEL_PX, ch)
        writeRect(left, top, right - left, bottom - top)
        return
      }

      const minW = Math.max(MIN_SEL_PX, MIN_SEL_PX * aspect)
      const minH = Math.max(MIN_SEL_PX, MIN_SEL_PX / aspect)

      if (horizontal && vertical) {
        // Corner: opposite corner anchored; the dominant pointer extent drives
        // the locked size (the rect grows to contain the pointer).
        const ax = rightSide ? r.x : r.x + r.w
        const ay = bottomSide ? r.y : r.y + r.h
        const wantW = Math.max(0, rightSide ? p.x - ax : ax - p.x)
        const wantH = Math.max(0, bottomSide ? p.y - ay : ay - p.y)
        const maxW = Math.min(rightSide ? cw - ax : ax, (bottomSide ? ch - ay : ay) * aspect)
        const w = clamp(Math.max(wantW, wantH * aspect), minW, Math.max(1, maxW))
        const h = w / aspect
        writeRect(rightSide ? ax : ax - w, bottomSide ? ay : ay - h, w, h)
        return
      }

      if (horizontal) {
        // Horizontal edge: opposite vertical edge anchored; the perpendicular
        // dimension grows symmetrically about the original centre.
        const ax = rightSide ? r.x : r.x + r.w
        const maxW = Math.min(rightSide ? cw - ax : ax, aspect * 2 * Math.min(centerY, ch - centerY))
        const want = Math.max(0, rightSide ? p.x - ax : ax - p.x)
        const w = clamp(want, minW, Math.max(1, maxW))
        const h = w / aspect
        writeRect(rightSide ? ax : ax - w, centerY - h / 2, w, h)
        return
      }

      // Vertical edge: opposite horizontal edge anchored; centred horizontally.
      const ay = bottomSide ? r.y : r.y + r.h
      const maxH = Math.min(bottomSide ? ch - ay : ay, (2 * Math.min(centerX, cw - centerX)) / aspect)
      const want = Math.max(0, bottomSide ? p.y - ay : ay - p.y)
      const h = clamp(want, minH, Math.max(1, maxH))
      const w = h * aspect
      writeRect(centerX - w / 2, bottomSide ? ay : ay - h, w, h)
    }

    composite.addEventListener('pointerdown', (ev) => {
      const p = bufferPoint(ev)
      if (!p) return
      const r = currentRect()
      const handle = hitHandle(p, r)
      if (handle) {
        mode = 'resize'
        active = handle
        start = r
        aspect = this.check('sel_keep_aspect')
          ? this.aspectRatio > 0
            ? this.aspectRatio
            : r.w / Math.max(1, r.h)
          : 0
        centerX = r.x + r.w / 2
        centerY = r.y + r.h / 2
        composite.setPointerCapture(ev.pointerId)
        setCursor(ev, p)
        return
      }
      if (inside(p, r)) {
        mode = 'move'
        active = null
        composite.setPointerCapture(ev.pointerId)
        applyMove(p)
        setCursor(ev, p)
        return
      }
      mode = 'none'
      active = null
    })

    composite.addEventListener('pointermove', (ev) => {
      const p = bufferPoint(ev)
      if (!p) return
      if (mode === 'resize') {
        applyResize(p)
        return
      }
      if (mode === 'move') {
        applyMove(p)
        return
      }
      setCursor(ev, p)
    })

    const end = (ev: PointerEvent): void => {
      mode = 'none'
      active = null
      if (composite.hasPointerCapture(ev.pointerId)) composite.releasePointerCapture(ev.pointerId)
      setCursor(ev, bufferPoint(ev))
      this.notifyChange()
    }
    composite.addEventListener('pointerup', end)
    composite.addEventListener('pointercancel', end)
    composite.addEventListener('pointerleave', (ev) => {
      if (mode !== 'none') return
      if (ev.pointerType === 'touch') return
      composite.style.cursor = 'crosshair'
    })
  }

  // ---- DOM construction ----

  private buildStatusLine(): void {
    const dot = document.createElement('span')
    dot.className = 'status-dot'
    dot.setAttribute('aria-hidden', 'true')
    const sep = document.createElement('span')
    sep.className = 'status-sep'
    sep.setAttribute('aria-hidden', 'true')
    sep.textContent = '/'

    this.statusText.className = 'status-text'
    this.statusText.textContent = 'idle'
    this.statusDevice.className = 'status-device'
    this.statusDevice.textContent = PLACEHOLDER

    this.statusLine.className = 'status-line'
    this.statusLine.dataset.state = 'idle'
    this.statusLine.append(dot, this.statusText, sep, this.statusDevice)
  }

  private build(container: HTMLElement): void {
    const statusHost = document.getElementById('appbar-status')
    if (statusHost) statusHost.append(this.statusLine)
    else container.append(this.statusLine)

    container.append(
      this.captureSection(),
      this.trackingSection(),
      this.backgroundSection(),
      this.compositeSection(),
      this.selectionSection(),
      this.transformSection(),
      this.expressionSection(),
      this.telemetrySection(),
    )
  }

  private captureSection(): HTMLElement {
    return this.section('Capture', (body) => {
      body.append(this.row([this.startBtn, this.stopBtn]))
      body.append(this.row([this.checkbox('pip_on', 'output window when minimized', false)], 'wrap'))
      body.append(this.row([this.checkbox('tray_min', 'minimize to tray', true)], 'wrap'))
      body.append(this.row([this.checkbox('rec_mode', 'recording mode', false)], 'wrap'))
    })
  }

  private trackingSection(): HTMLElement {
    return this.section('Tracking', (body) => {
      body.append(
        this.row([this.checkbox('c_lm', 'landmarks', true), this.checkbox('c_mesh', 'mesh', false), this.checkbox('c_mirror', 'mirror', true)], 'wrap'),
      )
    })
  }

  private backgroundSection(): HTMLElement {
    return this.section('Background blur', (body) => {
      body.append(this.row([this.checkbox('blur_on', 'enabled', false), this.checkbox('blur_invert', 'invert mask', false)], 'wrap'))
      body.append(
        this.rangeRow({ key: 'blur_px', label: 'blur', min: BLUR_MIN_PX, max: BLUR_MAX_PX, step: 1, value: BLUR_DEFAULT_PX, decimals: 0 }, 'refresh'),
      )
    })
  }

  private compositeSection(): HTMLElement {
    return this.section('Composite', (body) => {
      body.append(this.row([this.checkbox('cp_on', 'enabled', true)], 'wrap'))
      body.append(
        this.rangeRow({ key: 'cp_size', label: 'size', min: 0.2, max: 4, step: 0.01, value: COMPOSITE_DEFAULTS.size, decimals: 2 }, 'refresh'),
        this.rangeRow({ key: 'cp_dx', label: 'offset x', min: -0.6, max: 0.6, step: 0.005, value: COMPOSITE_DEFAULTS.dx, decimals: 3 }, 'refresh'),
        this.rangeRow({ key: 'cp_dy', label: 'offset y', min: -0.6, max: 0.6, step: 0.005, value: COMPOSITE_DEFAULTS.dy, decimals: 3 }, 'refresh'),
      )
      body.append(
        this.actionRow(
          this.button('Reset composite', () => {
            this.setInputValue('cp_size', COMPOSITE_DEFAULTS.size)
            this.setInputValue('cp_dx', COMPOSITE_DEFAULTS.dx)
            this.setInputValue('cp_dy', COMPOSITE_DEFAULTS.dy)
            this.callbacks.onRefresh()
            this.notifyChange()
          }),
        ),
      )
    })
  }

  private selectionSection(): HTMLElement {
    return this.section('Output selection', (body) => {
      body.append(
        this.rangeRow({ key: 'sel_w', label: 'width', min: MIN_SEL_PX, max: 1920, step: 1, value: SELECTION_DEFAULTS.w, decimals: 0 }, 'refresh'),
        this.rangeRow({ key: 'sel_h', label: 'height', min: MIN_SEL_PX, max: 1920, step: 1, value: SELECTION_DEFAULTS.h, decimals: 0 }, 'refresh'),
        this.row([this.checkbox('sel_keep_aspect', 'keep aspect ratio', SELECTION_DEFAULTS.keepAspect)], 'wrap'),
        this.rangeRow({ key: 'sel_x', label: 'position x', min: 0, max: 1, step: 0.001, value: SELECTION_DEFAULTS.cx, decimals: 3 }, 'refresh'),
        this.rangeRow({ key: 'sel_y', label: 'position y', min: 0, max: 1, step: 0.001, value: SELECTION_DEFAULTS.cy, decimals: 3 }, 'refresh'),
        this.rangeRow({ key: 'sel_mul', label: 'multiplier', min: 0.25, max: 4, step: 0.05, value: SELECTION_DEFAULTS.mul, decimals: 2 }, 'refresh'),
        this.selectRow(
          'sel_mask',
          'mask',
          [
            ['none', 'None'],
            ['round', 'Rounded'],
            ['circle', 'Circle'],
          ],
          SELECTION_DEFAULTS.mask,
        ),
        this.rangeRow({ key: 'sel_radius', label: 'radius %', min: 0, max: 50, step: 1, value: SELECTION_DEFAULTS.radius, decimals: 0 }, 'refresh'),
        this.rangeRow({ key: 'sel_feather', label: 'feather', min: 0, max: 30, step: 1, value: SELECTION_DEFAULTS.feather, decimals: 0 }, 'refresh'),
      )
      body.append(
        this.actionRow(
          this.button('Reset selection', () => {
            this.setSelection(SELECTION_DEFAULTS)
            this.callbacks.onRefresh()
            this.notifyChange()
          }),
        ),
      )
    })
  }

  private transformSection(): HTMLElement {
    return this.section('Model transform', (body) => {
      body.append(
        this.rangeRow({ key: 't_scale', label: 'scale', min: 0.1, max: 8, step: 0.01, value: TRANSFORM_DEFAULTS.scale, decimals: 2 }, 'transform'),
        this.rangeRow({ key: 't_x', label: 'x', min: -6, max: 6, step: 0.01, value: TRANSFORM_DEFAULTS.x, decimals: 2 }, 'transform'),
        this.rangeRow({ key: 't_y', label: 'y', min: -6, max: 6, step: 0.01, value: TRANSFORM_DEFAULTS.y, decimals: 2 }, 'transform'),
        this.rangeRow({ key: 't_z', label: 'z', min: -6, max: 6, step: 0.01, value: TRANSFORM_DEFAULTS.z, decimals: 2 }, 'transform'),
      )
      body.append(
        this.actionRow(
          this.button('Reset transform', () => {
            this.setTransformInputs(TRANSFORM_DEFAULTS)
            this.callbacks.onTransform()
            this.notifyChange()
          }),
          this.button('Reset view', () => this.callbacks.onResetView()),
        ),
      )
    })
  }

  private expressionSection(): HTMLElement {
    const specs: RangeSpec[] = [
      { key: 's_jaw', label: 'jawOpen', min: 0, max: 1, step: 0.01, value: 0, decimals: 2 },
      { key: 's_blink', label: 'eyeBlinkLeft', min: 0, max: 1, step: 0.01, value: 0, decimals: 2 },
      { key: 's_smile', label: 'mouthSmileLeft', min: 0, max: 1, step: 0.01, value: 0, decimals: 2 },
      { key: 's_brow', label: 'browInnerUp', min: 0, max: 1, step: 0.01, value: 0, decimals: 2 },
      { key: 's_tongue', label: 'tongueOut', min: 0, max: 1, step: 0.01, value: 0, decimals: 2 },
      { key: 's_yaw', label: 'headYaw', min: -1, max: 1, step: 0.01, value: 0, decimals: 2 },
    ]
    return this.section('Manual expression', (body) => {
      for (const spec of specs) body.append(this.rangeRow(spec, 'expression'))
    })
  }

  private telemetrySection(): HTMLElement {
    return this.section('Telemetry', (body) => {
      const list = document.createElement('dl')
      list.className = 'telemetry'
      list.append(
        this.telemetryItem('resolution', this.resEl),
        this.telemetryItem('fps', this.fpsEl),
        this.telemetryItem('detection', this.latEl),
        this.telemetryItem('face', this.faceEl),
        this.telemetryItem('points', this.ptsEl),
        this.telemetryItem('device', this.devStatEl),
      )
      body.append(list)
    })
  }

  // ---- element helpers ----

  private section(title: string, build: (body: HTMLElement) => void): HTMLElement {
    const el = document.createElement('section')
    el.className = 'ctl-section'
    const heading = document.createElement('h3')
    heading.className = 'ctl-title'
    heading.textContent = title
    const body = document.createElement('div')
    body.className = 'ctl-body'
    build(body)
    el.append(heading, body)
    return el
  }

  private row(children: HTMLElement[], extraClass?: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'ctl-row' + (extraClass ? ' ' + extraClass : '')
    el.append(...children)
    return el
  }

  private actionRow(...children: HTMLElement[]): HTMLElement {
    const el = document.createElement('div')
    el.className = 'ctl-row actions'
    el.append(...children)
    return el
  }

  private button(label: string, onClick: () => void): HTMLButtonElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'btn btn-quiet'
    el.textContent = label
    el.addEventListener('click', onClick)
    return el
  }

  private checkbox(key: string, label: string, checked: boolean): HTMLLabelElement {
    const wrap = document.createElement('label')
    wrap.className = 'switch'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = 'switch-input'
    input.checked = checked
    input.addEventListener('change', () => {
      this.onToggle(key)
      this.notifyChange()
    })
    const track = document.createElement('span')
    track.className = 'switch-track'
    track.setAttribute('aria-hidden', 'true')
    const knob = document.createElement('span')
    knob.className = 'switch-knob'
    track.append(knob)
    const text = document.createElement('span')
    text.className = 'switch-label'
    text.textContent = label
    wrap.append(input, track, text)
    this.inputs.set(key, input)
    return wrap
  }

  private rangeRow(spec: RangeSpec, kind: RangeKind): HTMLElement {
    const el = document.createElement('div')
    el.className = 'ctl-row'
    const label = document.createElement('span')
    label.className = 'ctl-label'
    label.textContent = spec.label
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(spec.min)
    input.max = String(spec.max)
    input.step = String(spec.step)
    input.value = String(spec.value)
    input.title = 'Scroll to adjust \u00b7 Shift coarse \u00b7 Alt fine'
    const value = document.createElement('span')
    value.className = 'readout'
    value.textContent = spec.value.toFixed(spec.decimals)
    value.title = 'Double-click to type a value'

    // ---- inline numeric editor (only one open at a time) ----
    let editor: HTMLInputElement | null = null

    /** Close the editor, optionally committing the typed value. */
    const finish = (commit: boolean): void => {
      const ed = editor
      if (!ed) return
      editor = null

      if (commit) {
        const raw = ed.value.trim()
        const parsed = raw === '' ? NaN : Number(raw)
        if (Number.isFinite(parsed)) {
          const lo = parseFloat(input.min)
          const hi = parseFloat(input.max)
          const min = Number.isFinite(lo) ? lo : parsed
          const max = Number.isFinite(hi) ? hi : parsed
          input.value = String(Math.min(max, Math.max(min, parsed)))
          // Run the existing range handler exactly once: readout formatting,
          // aspect coupling, callbacks and autosave all hang off this event.
          input.dispatchEvent(new Event('input', { bubbles: true }))
        }
      }

      ed.remove()
      value.style.display = ''
      if (this.activeEditor === finish) this.activeEditor = null
    }

    const startEdit = (): void => {
      if (editor) return
      // Only one readout may be edited at a time; commit the previous one.
      const previous = this.activeEditor
      if (previous) previous(true)

      const ed = document.createElement('input')
      ed.type = 'number'
      ed.className = 'readout-input'
      ed.min = input.min
      ed.max = input.max
      ed.step = input.step
      ed.value = input.value
      ed.title = value.title
      ed.setAttribute('aria-label', spec.label + ' value')

      ed.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault()
          finish(true)
        } else if (ev.key === 'Escape') {
          ev.preventDefault()
          finish(false)
        }
      })
      ed.addEventListener('blur', () => finish(true))
      // Swallow the wheel so it never reaches the slider's wheel handler.
      ed.addEventListener(
        'wheel',
        (ev) => {
          ev.stopPropagation()
          ev.preventDefault()
        },
        { passive: false },
      )

      editor = ed
      this.activeEditor = finish
      value.style.display = 'none'
      value.insertAdjacentElement('afterend', ed)
      ed.focus()
      ed.select()
    }

    value.addEventListener('dblclick', (ev) => {
      ev.preventDefault()
      startEdit()
    })
    input.addEventListener('input', () => {
      value.textContent = Number(input.value).toFixed(spec.decimals)
      // Couple width/height when the aspect lock is on (no-op otherwise).
      this.syncAspect(spec.key)
      if (kind === 'transform') this.callbacks.onTransform()
      else if (kind === 'expression') this.callbacks.onExpression()
      else this.callbacks.onRefresh()
      this.notifyChange()
    })
    input.addEventListener(
      'wheel',
      (e) => {
        if (input.disabled) return
        const min = parseFloat(input.min)
        const max = parseFloat(input.max)
        const step = parseFloat(input.step) || 1
        if (!isFinite(min) || !isFinite(max)) return
        let inc = Math.max(step, (max - min) / 100)
        if (e.shiftKey) inc *= 10
        else if (e.altKey) inc /= 10
        const dir = e.deltaY < 0 ? 1 : -1
        let v = parseFloat(input.value) + dir * inc
        v = Math.min(max, Math.max(min, v))
        v = Math.round(v / step) * step
        const decimals = (String(step).split('.')[1] || '').length
        v = parseFloat(v.toFixed(Math.min(decimals, 6)))
        if (v === parseFloat(input.value)) return
        e.preventDefault()
        input.value = String(v)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      },
      { passive: false },
    )
    this.inputs.set(spec.key, input)
    this.readouts.set(spec.key, value)
    el.append(label, input, value)
    return el
  }

  private selectRow(key: string, label: string, options: Array<[string, string]>, value: string): HTMLElement {
    const el = document.createElement('div')
    el.className = 'ctl-row'
    const name = document.createElement('span')
    name.className = 'ctl-label'
    name.textContent = label
    const select = document.createElement('select')
    select.className = 'ctl-select'
    for (const [optValue, optLabel] of options) {
      const option = document.createElement('option')
      option.value = optValue
      option.textContent = optLabel
      select.append(option)
    }
    select.value = value
    select.addEventListener('change', () => {
      this.callbacks.onRefresh()
      this.notifyChange()
    })
    this.inputs.set(key, select)
    el.append(name, select)
    return el
  }

  private telemetryItem(label: string, value: HTMLElement): HTMLElement {
    const item = document.createElement('div')
    const dt = document.createElement('dt')
    dt.textContent = label
    const dd = document.createElement('dd')
    dd.append(value)
    item.append(dt, dd)
    return item
  }

  private onToggle(key: string): void {
    if (key === 'c_mirror') {
      this.preview?.classList.toggle('mirror', this.check('c_mirror'))
      this.callbacks.onRefresh()
      return
    }
    if (key === 'blur_on') {
      if (this.check('blur_on')) this.callbacks.onBlurEnable()
      this.callbacks.onRefresh()
      return
    }
    if (key === 'pip_on') {
      this.callbacks.onTogglePip()
      return
    }
    if (key === 'tray_min') {
      this.callbacks.onToggleMinimizeToTray()
      return
    }
    if (key === 'rec_mode') {
      this.callbacks.onToggleRecordingMode()
      return
    }
    if (key === 'sel_keep_aspect') {
      // Capture the ratio the moment the lock is engaged; release it on off.
      this.aspectRatio = this.check('sel_keep_aspect')
        ? this.num('sel_w') / Math.max(1, this.num('sel_h'))
        : 0
      this.callbacks.onRefresh()
      return
    }
    this.callbacks.onRefresh()
  }

  // ---- input access ----

  private setCheck(key: string, value: boolean): void {
    const input = this.inputs.get(key)
    if (input instanceof HTMLInputElement) input.checked = value
  }

  private setInputValue(key: string, value: string | number): void {
    const input = this.inputs.get(key)
    if (!input) return
    input.value = String(value)
    const readout = this.readouts.get(key)
    if (readout) {
      const step = input instanceof HTMLInputElement ? Number(input.step) : 1
      const decimals = step && step < 1 ? Math.min(6, String(step).split('.')[1]?.length ?? 2) : 0
      // Read back the clamped/step-snapped value the input actually holds so
      // the readout can never diverge from the real control value.
      readout.textContent = Number(input.value).toFixed(decimals)
    }
  }

  private setTransformInputs(t: ModelTransform): void {
    this.setInputValue('t_scale', t.scale)
    this.setInputValue('t_x', t.x)
    this.setInputValue('t_y', t.y)
    this.setInputValue('t_z', t.z)
  }

  private check(key: string): boolean {
    const input = this.inputs.get(key)
    return input instanceof HTMLInputElement ? input.checked : false
  }

  private num(key: string): number {
    const input = this.inputs.get(key)
    return input ? Number(input.value) : 0
  }

  private selectValue(key: string): string {
    const input = this.inputs.get(key)
    return input ? input.value : 'none'
  }
}

export function createControls(
  container: HTMLElement,
  preview: HTMLElement | null,
  callbacks: ControlsCallbacks,
): HarnessControls {
  return new HarnessControls(container, preview, callbacks)
}
