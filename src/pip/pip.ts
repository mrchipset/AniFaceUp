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
import { getFacePresent, restoreMain, subscribeFrames } from '../lib/tauri'

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Mirror the face-detection state as a red border on the whole window. */
function applyFace(present: boolean): void {
  document.body.classList.toggle('no-face', !present)
}

const img = document.getElementById('frame') as HTMLImageElement | null

let currentUrl: string | null = null

function render(buf: ArrayBuffer): void {
  if (!img) return
  const blob = new Blob([buf], { type: 'image/png' })
  const url = URL.createObjectURL(blob)
  img.src = url
  const previous = currentUrl
  currentUrl = url
  if (previous) URL.revokeObjectURL(previous)
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
}
