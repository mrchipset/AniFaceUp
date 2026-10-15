/**
 * Lifecycle for the borderless, transparent, always-on-top PiP window that
 * shows the final output crop while the main window is minimized.
 *
 * All Tauri calls are guarded so the plain-browser dev harness keeps working.
 */
import { currentMonitor, LogicalPosition } from '@tauri-apps/api/window'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'

const LABEL = 'pip'
const WIDTH = 320
const HEIGHT = 240
const MARGIN = 16

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

let pip: WebviewWindow | null = null
let visible = false

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
 * Create (or reuse) the PiP window, wait for it to exist, position it and
 * show it. Resolves to `null` outside Tauri.
 */
export async function ensurePipWindow(): Promise<WebviewWindow | null> {
  if (!isTauri()) return null
  if (pip) return pip

  const existing = await WebviewWindow.getByLabel(LABEL)
  if (existing) {
    pip = existing
    return pip
  }

  const win = new WebviewWindow(LABEL, {
    url: 'pip.html',
    title: 'Output',
    width: WIDTH,
    height: HEIGHT,
    decorations: false,
    transparent: true,
    noRedirectionBitmap: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    shadow: false,
    focus: false,
    visible: false,
  })
  pip = win

  // Wait for creation (or failure) before positioning; the window is still
  // hidden at this point.
  await new Promise<void>((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    void win.once('tauri://created', finish)
    void win.once('tauri://error', finish)
    window.setTimeout(finish, 3000)
  })

  try {
    await positionBottomRight(win)
  } catch (error) {
    console.warn('[pip] position failed:', error)
  }
  return win
}

/** Show the PiP window (creating it if needed) at the bottom-right corner. */
export async function showPip(): Promise<void> {
  if (!isTauri()) return
  const win = await ensurePipWindow()
  if (!win) return
  try {
    await positionBottomRight(win)
    await win.show()
    visible = true
  } catch (error) {
    console.warn('[pip] show failed:', error)
  }
}

/** Hide the PiP window if it exists. */
export async function hidePip(): Promise<void> {
  if (!isTauri()) return
  if (!pip) return
  try {
    await pip.hide()
  } catch (error) {
    console.warn('[pip] hide failed:', error)
  }
  visible = false
}

/** Whether the PiP window is currently shown. */
export function isPipVisible(): boolean {
  return visible
}
