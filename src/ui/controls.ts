/**
 * Functional (plain, unstyled) harness controls.
 *
 * Builds the entire control panel into a container, owns the UI-bound state
 * (composite / selection / transform / expression / toggles) and reports
 * changes through callbacks. No visual design here — P4 restyles the UI.
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

export class HarnessControls {
  private readonly inputs = new Map<string, HTMLInputElement | HTMLSelectElement>()
  private readonly readouts = new Map<string, HTMLElement>()
  private readonly statusEl = document.createElement('span')
  private readonly resEl = document.createElement('span')
  private readonly fpsEl = document.createElement('span')
  private readonly latEl = document.createElement('span')
  private readonly faceEl = document.createElement('span')
  private readonly ptsEl = document.createElement('span')
  private readonly devEl = document.createElement('span')
  private readonly startBtn = document.createElement('button')
  private readonly stopBtn = document.createElement('button')
  private readonly callbacks: ControlsCallbacks
  private readonly preview: HTMLElement | null

  constructor(container: HTMLElement, preview: HTMLElement | null, callbacks: ControlsCallbacks) {
    this.callbacks = callbacks
    this.preview = preview
    this.startBtn.textContent = 'Start camera'
    this.stopBtn.textContent = 'Stop'
    this.startBtn.addEventListener('click', () => this.callbacks.onStartCamera())
    this.stopBtn.addEventListener('click', () => this.callbacks.onStopCamera())
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

  setStatus(text: string): void {
    this.statusEl.textContent = text
  }

  setDevice(label: string): void {
    this.devEl.textContent = label
  }

  setResolution(w: number, h: number): void {
    this.resEl.textContent = w && h ? `${w}x${h}` : '-'
  }

  setStats(fps: number, detectionMs: number, faceFound: boolean, points: number): void {
    this.fpsEl.textContent = fps.toFixed(1) + ' fps'
    this.latEl.textContent = detectionMs.toFixed(0) + ' ms'
    this.faceEl.textContent = faceFound ? 'yes' : 'no'
    this.ptsEl.textContent = faceFound ? points + ' pts' : '-'
  }

  resetStats(): void {
    this.resEl.textContent = '-'
    this.fpsEl.textContent = '-'
    this.latEl.textContent = '-'
    this.faceEl.textContent = '-'
    this.ptsEl.textContent = '-'
    this.devEl.textContent = '-'
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

  private build(container: HTMLElement): void {
    container.append(
      this.cameraSection(),
      this.compositeSection(),
      this.selectionSection(),
      this.transformSection(),
      this.expressionSection(),
    )
  }

  private cameraSection(): HTMLElement {
    const section = this.section('Camera')
    section.append(this.row(this.startBtn, this.stopBtn))
    section.append(
      this.row(
        this.checkbox('c_lm', 'landmarks', true, true),
        this.checkbox('c_mesh', 'mesh', false, true),
        this.checkbox('c_mirror', 'mirror', true, false),
      ),
    )
    section.append(
      this.row(
        this.checkbox('blur_on', 'background blur', false, false),
        this.checkbox('blur_invert', 'invert mask', false, true),
      ),
    )
    section.append(this.rangeRow({ key: 'blur_px', label: 'blur px', min: BLUR_MIN_PX, max: BLUR_MAX_PX, step: 1, value: BLUR_DEFAULT_PX, decimals: 0 }, 'refresh'))
    section.append(
      this.statsRow('resolution', this.resEl),
      this.statsRow('fps', this.fpsEl),
      this.statsRow('detection', this.latEl),
      this.statsRow('face', this.faceEl),
      this.statsRow('points', this.ptsEl),
      this.statsRow('device', this.devEl),
    )
    section.append(this.row(this.statusEl))
    return section
  }

  private compositeSection(): HTMLElement {
    const section = this.section('Composite')
    section.append(this.checkbox('cp_on', 'composite', true, false))
    section.append(this.rangeRow({ key: 'cp_size', label: 'size', min: 0.2, max: 4, step: 0.01, value: COMPOSITE_DEFAULTS.size, decimals: 2 }, 'refresh'))
    section.append(this.rangeRow({ key: 'cp_dx', label: 'offset x', min: -0.6, max: 0.6, step: 0.005, value: COMPOSITE_DEFAULTS.dx, decimals: 3 }, 'refresh'))
    section.append(this.rangeRow({ key: 'cp_dy', label: 'offset y', min: -0.6, max: 0.6, step: 0.005, value: COMPOSITE_DEFAULTS.dy, decimals: 3 }, 'refresh'))
    const reset = this.button('reset composite', () => {
      this.setInputValue('cp_size', COMPOSITE_DEFAULTS.size)
      this.setInputValue('cp_dx', COMPOSITE_DEFAULTS.dx)
      this.setInputValue('cp_dy', COMPOSITE_DEFAULTS.dy)
      this.callbacks.onRefresh()
    }, true)
    section.append(this.row(reset))
    return section
  }

  private selectionSection(): HTMLElement {
    const section = this.section('Output selection')
    section.append(this.rangeRow({ key: 'sel_w', label: 'width', min: 50, max: 1920, step: 1, value: SELECTION_DEFAULTS.w, decimals: 0 }, 'refresh'))
    section.append(this.rangeRow({ key: 'sel_h', label: 'height', min: 50, max: 1920, step: 1, value: SELECTION_DEFAULTS.h, decimals: 0 }, 'refresh'))
    section.append(this.rangeRow({ key: 'sel_x', label: 'position x', min: 0, max: 1, step: 0.001, value: SELECTION_DEFAULTS.cx, decimals: 3 }, 'refresh'))
    section.append(this.rangeRow({ key: 'sel_y', label: 'position y', min: 0, max: 1, step: 0.001, value: SELECTION_DEFAULTS.cy, decimals: 3 }, 'refresh'))
    section.append(this.rangeRow({ key: 'sel_mul', label: 'multiplier', min: 0.25, max: 4, step: 0.05, value: SELECTION_DEFAULTS.mul, decimals: 2 }, 'refresh'))
    section.append(
      this.selectRow(
        'sel_mask',
        'mask',
        [
          ['none', 'none'],
          ['round', 'rounded'],
          ['circle', 'circle'],
        ],
        SELECTION_DEFAULTS.mask,
      ),
    )
    section.append(this.rangeRow({ key: 'sel_radius', label: 'radius %', min: 0, max: 50, step: 1, value: SELECTION_DEFAULTS.radius, decimals: 0 }, 'refresh'))
    section.append(this.rangeRow({ key: 'sel_feather', label: 'feather', min: 0, max: 30, step: 1, value: SELECTION_DEFAULTS.feather, decimals: 0 }, 'refresh'))
    const reset = this.button('reset selection', () => {
      this.setSelection(SELECTION_DEFAULTS)
      this.callbacks.onRefresh()
    }, true)
    section.append(this.row(reset))
    return section
  }

  private transformSection(): HTMLElement {
    const section = this.section('Model transform')
    section.append(this.rangeRow({ key: 't_scale', label: 'scale', min: 0.1, max: 8, step: 0.01, value: TRANSFORM_DEFAULTS.scale, decimals: 2 }, 'transform'))
    section.append(this.rangeRow({ key: 't_x', label: 'x', min: -6, max: 6, step: 0.01, value: TRANSFORM_DEFAULTS.x, decimals: 2 }, 'transform'))
    section.append(this.rangeRow({ key: 't_y', label: 'y', min: -6, max: 6, step: 0.01, value: TRANSFORM_DEFAULTS.y, decimals: 2 }, 'transform'))
    section.append(this.rangeRow({ key: 't_z', label: 'z', min: -6, max: 6, step: 0.01, value: TRANSFORM_DEFAULTS.z, decimals: 2 }, 'transform'))
    const reset = this.button('reset transform', () => {
      this.setTransformInputs(TRANSFORM_DEFAULTS)
      this.callbacks.onTransform()
    }, true)
    const resetView = this.button('reset view', () => this.callbacks.onResetView(), true)
    section.append(this.row(reset, resetView))
    return section
  }

  private expressionSection(): HTMLElement {
    const section = this.section('Manual expression')
    const specs: RangeSpec[] = [
      { key: 's_jaw', label: 'jawOpen', min: 0, max: 1, step: 0.01, value: 0, decimals: 2 },
      { key: 's_blink', label: 'eyeBlinkLeft', min: 0, max: 1, step: 0.01, value: 0, decimals: 2 },
      { key: 's_smile', label: 'mouthSmileLeft', min: 0, max: 1, step: 0.01, value: 0, decimals: 2 },
      { key: 's_brow', label: 'browInnerUp', min: 0, max: 1, step: 0.01, value: 0, decimals: 2 },
      { key: 's_tongue', label: 'tongueOut', min: 0, max: 1, step: 0.01, value: 0, decimals: 2 },
      { key: 's_yaw', label: 'headYaw', min: -1, max: 1, step: 0.01, value: 0, decimals: 2 },
    ]
    for (const spec of specs) section.append(this.rangeRow(spec, 'expression'))
    return section
  }

  // ---- element helpers ----

  private section(title: string): HTMLElement {
    const el = document.createElement('section')
    el.className = 'panel-section'
    const heading = document.createElement('h2')
    heading.textContent = title
    el.append(heading)
    return el
  }

  private row(...children: HTMLElement[]): HTMLElement {
    const el = document.createElement('div')
    el.className = 'panel-row'
    el.append(...children)
    return el
  }

  private statsRow(label: string, value: HTMLElement): HTMLElement {
    const el = document.createElement('div')
    el.className = 'panel-row'
    const name = document.createElement('span')
    name.textContent = label
    el.append(name, value)
    return el
  }

  private button(label: string, onClick: () => void, ghost = false): HTMLButtonElement {
    const el = document.createElement('button')
    el.type = 'button'
    el.textContent = label
    if (ghost) el.className = 'ghost'
    el.addEventListener('click', onClick)
    return el
  }

  private checkbox(key: string, label: string, checked: boolean, light: boolean): HTMLLabelElement {
    const wrap = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = checked
    input.addEventListener('change', () => this.onToggle(key))
    this.inputs.set(key, input)
    wrap.append(input, document.createTextNode(' ' + label))
    if (light) wrap.className = 'light'
    return wrap
  }

  private rangeRow(spec: RangeSpec, kind: RangeKind): HTMLElement {
    const el = document.createElement('div')
    el.className = 'panel-row'
    const label = document.createElement('label')
    label.textContent = spec.label
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(spec.min)
    input.max = String(spec.max)
    input.step = String(spec.step)
    input.value = String(spec.value)
    input.title = 'wheel to adjust · Shift coarse · Alt fine'
    input.style.cursor = 'ns-resize'
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
    el.className = 'panel-row'
    const name = document.createElement('label')
    name.textContent = label
    const select = document.createElement('select')
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
    if (key === 'c_lm' || key === 'c_mesh') {
      this.callbacks.onRefresh()
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
