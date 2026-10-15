/**
 * PiP window renderer: subscribes to encoded frames broadcast by the native
 * side and paints the latest one. Runs in the `pip` webview only.
 */
import { subscribeFrames } from '../lib/tauri'

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

const img = document.getElementById('frame') as HTMLImageElement | null

let currentUrl: string | null = null

function render(buf: ArrayBuffer): void {
  if (!img) return
  const blob = new Blob([buf], { type: 'image/jpeg' })
  const url = URL.createObjectURL(blob)
  img.src = url
  const previous = currentUrl
  currentUrl = url
  if (previous) URL.revokeObjectURL(previous)
}

if (isTauri()) {
  void subscribeFrames(render).catch((error: unknown) => {
    console.warn('[pip] subscribe failed:', error)
  })
}
