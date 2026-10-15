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
import { restoreMain, subscribeFrames } from '../lib/tauri'

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
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
const DRAG_THRESHOLD_PX = 4
let downX = 0
let downY = 0
let dragging = false

function startDrag(): void {
  void getCurrentWindow()
    .startDragging()
    .catch((error: unknown) => console.warn('[pip] startDragging failed:', error))
}

window.addEventListener('pointerdown', (event) => {
  downX = event.clientX
  downY = event.clientY
  dragging = false
})

window.addEventListener('pointermove', (event) => {
  if (dragging || event.buttons !== 1) return
  if (Math.hypot(event.clientX - downX, event.clientY - downY) < DRAG_THRESHOLD_PX) return
  dragging = true
  if (isTauri()) startDrag()
})

window.addEventListener('dblclick', () => {
  if (!isTauri()) return
  void restoreMain().catch((error: unknown) => console.warn('[pip] restoreMain failed:', error))
})

if (isTauri()) {
  void subscribeFrames(render).catch((error: unknown) => {
    console.warn('[pip] subscribe failed:', error)
  })
}
