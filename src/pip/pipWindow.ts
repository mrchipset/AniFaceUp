/**
 * Lifecycle for the borderless, transparent, always-on-top PiP window that
 * shows the final output crop while the main window is minimized.
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
/** In-flight creation promise, so concurrent callers share one window. */
let creating: Promise<WebviewWindow | null> | null = null

/** Reset module state when the pip window goes away. */
function onPipGone(): void {
  pip = null
  visible = false
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
 * Create (or reuse) the PiP window, wait for it to exist, position it and
 * show it. Resolves to `null` outside Tauri.
 */
export async function ensurePipWindow(): Promise<WebviewWindow | null> {
  if (!isTauri()) return null
  if (pip) return pip
  if (creating) return creating
  creating = createPipWindow().finally(() => {
    creating = null
  })
  return creating
}

/** Actually create and initialise the window (single in-flight caller). */
async function createPipWindow(): Promise<WebviewWindow | null> {
  if (pip) return pip

  const existing = await WebviewWindow.getByLabel(LABEL)
  if (existing) {
    pip = existing
    watchClose(existing)
    return pip
  }

  let win: WebviewWindow
  try {
    win = new WebviewWindow(LABEL, {
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
  } catch (error) {
    pip = null
    throw error
  }
  pip = win
  watchClose(win)

  // Wait for creation (or failure) before positioning; the window is still
  // hidden at this point. Propagate creation errors so the caller can report.
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      resolve()
    }
    const failed = (err: unknown): void => {
      if (settled) return
      settled = true
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    void win.once('tauri://created', done)
    void win.once('tauri://error', (event: unknown) =>
      failed(new Error('pip window creation rejected: ' + JSON.stringify(event))),
    )
    window.setTimeout(done, 4000)
  }).catch((error: unknown) => {
    pip = null
    throw error
  })

  try {
    await positionBottomRight(win)
  } catch (error) {
    console.warn('[pip] position failed:', error)
  }
  return win
}

/** Register close/destroy handlers that reset the module state. */
function watchClose(win: WebviewWindow): void {
  void win.onCloseRequested(() => onPipGone())
  void win.once('tauri://destroyed', () => onPipGone())
}

/** Show the PiP window (creating it if needed) at the bottom-right corner. */
export async function showPip(): Promise<void> {
  if (!isTauri()) return
  const win = await ensurePipWindow()
  if (!win) return
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
