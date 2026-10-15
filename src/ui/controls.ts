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
  TRANSFORM_DEFAULTS,
  type MaskShape,
  type ModelTransform,
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
  }

  setSelectionCenter(cx: number, cy: number): void {
    this.setInputValue('sel_x', cx)
    this.setInputValue('sel_y', cy)
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

  /** Wire drag-to-move selection directly on the composite view. */
  attachSelectionDrag(composite: HTMLCanvasElement): void {
    let dragging = false
    const move = (ev: PointerEvent): void => {
      const rect = composite.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const cx = Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width))
      const cy = Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height))
      this.setSelectionCenter(cx, cy)
      this.callbacks.onRefresh()
    }
    composite.addEventListener('pointerdown', (ev) => {
      dragging = true
      composite.setPointerCapture(ev.pointerId)
      move(ev)
    })
    composite.addEventListener('pointermove', (ev) => {
      if (dragging) move(ev)
    })
    composite.addEventListener('pointerup', () => {
      dragging = false
    })
    composite.addEventListener('pointercancel', () => {
      dragging = false
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
          }),
        ),
      )
    })
  }

  private selectionSection(): HTMLElement {
    return this.section('Output selection', (body) => {
      body.append(
        this.rangeRow({ key: 'sel_w', label: 'width', min: 50, max: 1920, step: 1, value: SELECTION_DEFAULTS.w, decimals: 0 }, 'refresh'),
        this.rangeRow({ key: 'sel_h', label: 'height', min: 50, max: 1920, step: 1, value: SELECTION_DEFAULTS.h, decimals: 0 }, 'refresh'),
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
    input.addEventListener('change', () => this.onToggle(key))
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
    input.addEventListener('input', () => {
      value.textContent = Number(input.value).toFixed(spec.decimals)
      if (kind === 'transform') this.callbacks.onTransform()
      else if (kind === 'expression') this.callbacks.onExpression()
      else this.callbacks.onRefresh()
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
    select.addEventListener('change', () => this.callbacks.onRefresh())
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
    this.callbacks.onRefresh()
  }

  // ---- input access ----

  private setInputValue(key: string, value: string | number): void {
    const input = this.inputs.get(key)
    if (!input) return
    input.value = String(value)
    const readout = this.readouts.get(key)
    if (readout) {
      const step = input instanceof HTMLInputElement ? Number(input.step) : 1
      const decimals = step && step < 1 ? Math.min(6, String(step).split('.')[1]?.length ?? 2) : 0
      readout.textContent = Number(value).toFixed(decimals)
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
