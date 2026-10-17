/**
 * PiP window renderer: subscribes to encoded frames broadcast by the native
 * side and paints the latest one. Runs in the `pip` webview only.
 *
 * Drag is implemented manually (instead of `data-tauri-drag-region`, which
 * starts dragging on mousedown and swallows the double-click): a pointer must
 * move past a small threshold before a drag begins, so a stationary
 * double-click still reaches the `dblclick` handler that restores the app.
 */
import { getCurrentWindow } from '@tauri-apps/api/window'
import { PhysicalPosition, PhysicalSize } from '@tauri-apps/api/dpi'
import { listen } from '@tauri-apps/api/event'
import { getFacePresent, getPipMask, restoreMain, subscribeFrames } from '../lib/tauri'

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

type MaskShape = 'none' | 'round' | 'circle'

const canvas = document.getElementById('frame') as HTMLCanvasElement | null
const ctx = canvas ? canvas.getContext('2d') : null

let facePresent = true
let maskShape: MaskShape = 'none'
let maskRadiusPct = 0
let lastBitmap: ImageBitmap | null = null

/** Repaint from the last decoded frame (no new frame required). */
function redraw(): void {
  if (lastBitmap) drawFrame(lastBitmap)
}

/** Mirror the face-detection state; redraw so the border can appear/disappear. */
function applyFace(present: boolean): void {
  facePresent = present
  redraw()
}

/** Mirror the output mask so the no-face border follows the crop shape. */
function applyMask(shape: string, radius: number): void {
  maskShape = shape === 'round' || shape === 'circle' ? shape : 'none'
  maskRadiusPct = Number.isFinite(radius) ? radius : 0
  redraw()
}

/** Stroke the mask-shaped warning border inside the frame. */
function drawNoFaceBorder(c: CanvasRenderingContext2D, w: number, h: number): void {
  const lineWidth = Math.max(2, Math.round(Math.min(w, h) * 0.008))
  const inset = lineWidth / 2 + 1
  c.save()
  c.strokeStyle = '#e5484d'
  c.lineWidth = lineWidth
  c.beginPath()
  if (maskShape === 'circle') {
    c.arc(w / 2, h / 2, Math.max(1, Math.min(w, h) / 2 - inset), 0, Math.PI * 2)
    c.stroke()
  } else if (maskShape === 'round') {
    // `radius` is a percentage of the shorter side, matching output.ts.
    const radius = Math.max(0, (Math.min(w, h) * maskRadiusPct) / 100 - inset)
    const x = inset
    const y = inset
    const rw = Math.max(1, w - 2 * inset)
    const rh = Math.max(1, h - 2 * inset)
    if (typeof c.roundRect === 'function') {
      c.roundRect(x, y, rw, rh, radius)
      c.stroke()
    } else {
      strokeManualRoundRect(c, x, y, rw, rh, radius)
    }
  } else {
    c.strokeRect(inset, inset, Math.max(1, w - 2 * inset), Math.max(1, h - 2 * inset))
  }
  c.restore()
}

/** Fallback for browsers without `CanvasRenderingContext2D.roundRect`. */
function strokeManualRoundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): void {
  const rr = Math.max(0, Math.min(radius, Math.min(w, h) / 2))
  c.moveTo(x + rr, y)
  c.lineTo(x + w - rr, y)
  c.quadraticCurveTo(x + w, y, x + w, y + rr)
  c.lineTo(x + w, y + h - rr)
  c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  c.lineTo(x + rr, y + h)
  c.quadraticCurveTo(x, y + h, x, y + h - rr)
  c.lineTo(x, y + rr)
  c.quadraticCurveTo(x, y, x + rr, y)
  c.closePath()
  c.stroke()
}

function drawFrame(bmp: ImageBitmap): void {
  if (!canvas || !ctx) return
  if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
    canvas.width = bmp.width
    canvas.height = bmp.height
  }
  const w = canvas.width
  const h = canvas.height
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(bmp, 0, 0)
  if (!facePresent) drawNoFaceBorder(ctx, w, h)
}

/** Most recent frame awaiting decode; older frames are dropped. */
let latest: ArrayBuffer | null = null
let decoding = false

function render(buf: ArrayBuffer): void {
  latest = buf
  if (decoding) return
  void drain()
}

/**
 * Decode frames one at a time, always taking the newest. This bounds latency:
 * a slow decode never builds a backlog of stale frames.
 */
async function drain(): Promise<void> {
  decoding = true
  try {
    while (latest) {
      const buf = latest
      latest = null
      if (!canvas || !ctx) continue
      const blob = new Blob([buf], { type: 'image/png' })
      const bmp = await createImageBitmap(blob)
      const previous = lastBitmap
      lastBitmap = bmp
      try {
        drawFrame(bmp)
      } finally {
        previous?.close()
      }
    }
  } catch (error) {
    console.warn('[pip] decode failed:', error)
  } finally {
    decoding = false
    // A frame may have arrived while the last decode was finishing.
    if (latest) void drain()
  }
}

// ---- manual drag + double-click restore ----
// Start the OS drag immediately on primary-button press (most responsive).
// The previous "wait for 4px of movement" approach felt unresponsive because
// the drag only began after the pointer had already moved, and could be missed
// entirely if `buttons` dropped before the threshold. A double-click is now
// detected manually on press so it can restore the main window instead of
// starting a second drag.
const DOUBLE_CLICK_MS = 320
const DOUBLE_CLICK_SLOP_PX = 6
let lastPressTime = 0
let lastPressX = 0
let lastPressY = 0

function startDrag(): void {
  void getCurrentWindow()
    .startDragging()
    .catch((error: unknown) => console.warn('[pip] startDragging failed:', error))
}

window.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return
  const now = performance.now()
  const isDouble =
    now - lastPressTime < DOUBLE_CLICK_MS &&
    Math.hypot(event.clientX - lastPressX, event.clientY - lastPressY) < DOUBLE_CLICK_SLOP_PX
  lastPressTime = now
  lastPressX = event.clientX
  lastPressY = event.clientY

  if (isDouble) {
    lastPressTime = 0
    if (isTauri()) {
      void restoreMain().catch((error: unknown) => console.warn('[pip] restoreMain failed:', error))
    }
    return
  }
  if (isTauri()) startDrag()
})

// ---- wheel scaling (proportional, bottom-right anchored) ----
const BASE_W = 320
const BASE_H = 240
const ASPECT = BASE_H / BASE_W
const MIN_W = 160
const MAX_W = 960
const STEP = 1.08
const STORE_KEY = 'anifaceup.pipWidth'
const RESIZE_THROTTLE_MS = 40

function clampWidth(width: number): number {
  return Math.min(MAX_W, Math.max(MIN_W, width))
}

let lastResize = 0
let resizing = false

/** Resize by `factor`, keeping the bottom-right corner fixed. */
async function resizePip(factor: number): Promise<void> {
  try {
    const win = getCurrentWindow()
    // Physical pixels: setSize/setPosition both take physical units.
    const size = await win.innerSize()
    const pos = await win.outerPosition()
    const oldW = size.width || BASE_W
    const oldH = size.height || BASE_H
    const newW = clampWidth(Math.round(oldW * factor))
    const newH = Math.round(newW * ASPECT)
    const newX = pos.x - (newW - oldW)
    const newY = pos.y - (newH - oldH)
    await win.setSize(new PhysicalSize(newW, newH))
    await win.setPosition(new PhysicalPosition(newX, newY))
    try {
      localStorage.setItem(STORE_KEY, String(newW))
    } catch {
      // Persistence is best-effort.
    }
  } catch (error) {
    console.warn('[pip] resize failed:', error)
  }
}

function onWheel(event: WheelEvent): void {
  event.preventDefault()
  if (!isTauri() || resizing) return
  const now = performance.now()
  if (now - lastResize < RESIZE_THROTTLE_MS) return
  lastResize = now
  if (event.deltaY === 0) return
  const factor = event.deltaY < 0 ? STEP : 1 / STEP
  resizing = true
  void resizePip(factor).finally(() => {
    resizing = false
  })
}

window.addEventListener('wheel', onWheel, { passive: false })

/** Apply the persisted width once at startup (no reposition; main places it). */
function applyStoredWidth(): void {
  if (!isTauri()) return
  let width: number | null = null
  try {
    const raw = localStorage.getItem(STORE_KEY)
    if (raw !== null) {
      const parsed = Number(raw)
      if (Number.isFinite(parsed)) width = clampWidth(Math.round(parsed))
    }
  } catch {
    width = null
  }
  if (width === null) return
  void getCurrentWindow()
    .setSize(new PhysicalSize(width, Math.round(width * ASPECT)))
    .catch((error: unknown) => console.warn('[pip] restore size failed:', error))
}

if (isTauri()) {
  applyStoredWidth()
  void subscribeFrames(render).catch((error: unknown) => {
    console.warn('[pip] subscribe failed:', error)
  })
  // Initial state, then live updates while this window is open.
  void getFacePresent()
    .then(applyFace)
    .catch((error: unknown) => console.warn('[pip] getFacePresent failed:', error))
  void listen<boolean>('pip://face', (event) => applyFace(!!event.payload)).catch(
    (error: unknown) => console.warn('[pip] face listen failed:', error),
  )
  // Initial mask state, then live updates (border follows the crop shape).
  void getPipMask()
    .then(([shape, radius]) => applyMask(shape, radius))
    .catch((error: unknown) => console.warn('[pip] getPipMask failed:', error))
  void listen<{ shape: string; radius: number }>('pip://mask', (event) =>
    applyMask(event.payload.shape, event.payload.radius),
  ).catch((error: unknown) => console.warn('[pip] mask listen failed:', error))
}
