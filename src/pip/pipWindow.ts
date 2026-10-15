/**
 * Lifecycle for the borderless, transparent, always-on-top PiP window that
 * shows the final output crop while the main window is minimized.
 *
 * The `pip` window is declared (hidden) in tauri.conf.json alongside `main`,
 * so both share one WebView2 environment and runtime creation is unnecessary.
 * Here we only resolve that declared window and show/hide it.
 *
 * All Tauri calls are guarded so the plain-browser dev harness keeps working.
 */
import { currentMonitor, LogicalPosition } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { clearFrames } from '../lib/tauri'

const LABEL = 'pip'
const WIDTH = 320
const HEIGHT = 240
const MARGIN = 16

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

let pip: WebviewWindow | null = null
let visible = false
let watching = false

/** Reset module state when the pip window goes away. */
function onPipGone(): void {
  pip = null
  visible = false
  watching = false
  void clearFrames().catch((error: unknown) => {
    console.warn('[pip] clearFrames failed:', error)
  })
}

/** Anchor the window to the bottom-right of the current monitor's work area. */
async function positionBottomRight(win: WebviewWindow): Promise<void> {
  const monitor = await currentMonitor()
  if (!monitor) return
  const scale = monitor.scaleFactor || 1
  const { position, size } = monitor.workArea
  const x = position.x / scale + size.width / scale - WIDTH - MARGIN
  const y = position.y / scale + size.height / scale - HEIGHT - MARGIN
  await win.setPosition(new LogicalPosition(Math.round(x), Math.round(y)))
}

/**
 * Resolve the config-declared PiP window (cached). Resolves to `null` outside
 * Tauri or if the window is not present.
 */
export async function ensurePipWindow(): Promise<WebviewWindow | null> {
  if (!isTauri()) return null
  if (pip) return pip
  const win = await WebviewWindow.getByLabel(LABEL)
  if (!win) return null
  pip = win
  watchClose(win)
  return pip
}

/** Register close/destroy handlers that reset the module state. */
function watchClose(win: WebviewWindow): void {
  if (watching) return
  watching = true
  void win.onCloseRequested(() => onPipGone())
  void win.once('tauri://destroyed', () => onPipGone())
}

/** Show the PiP window at the bottom-right corner. */
export async function showPip(): Promise<void> {
  if (!isTauri()) return
  const win = await ensurePipWindow()
  if (!win) return
  if (visible) return
  try {
    await positionBottomRight(win)
  } catch (error) {
    console.warn('[pip] position failed:', error)
  }
  await win.show()
  try {
    await win.setAlwaysOnTop(true)
  } catch (error) {
    console.warn('[pip] setAlwaysOnTop failed:', error)
  }
  visible = true
}

/** Hide the PiP window if it exists. */
export async function hidePip(): Promise<void> {
  if (!isTauri()) return
  const win = await ensurePipWindow()
  if (!win) return
  try {
    await win.hide()
  } catch (error) {
    console.warn('[pip] hide failed:', error)
  }
  visible = false
}

/** Whether the PiP window is currently shown. */
export function isPipVisible(): boolean {
  return visible
}
