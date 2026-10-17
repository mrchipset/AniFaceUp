/**
 * Typed wrappers around the Rust native-dialog file commands.
 *
 * The file picker lives in Rust so the frontend never supplies a path.
 *
 * Binary IPC rule: to save bytes we pass `Array.from(bytes)` as the named
 * argument `data`; to read bytes the Rust command returns
 * `tauri::ipc::Response`, which resolves to an `ArrayBuffer` on the frontend.
 */
import { Channel, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

/** True when running inside a Tauri webview. */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Open a native file dialog (glb/gltf), returning the chosen file's bytes.
 * Resolves to `null` if the user cancelled (Rust returns a 0-byte response).
 */
export async function importModel(): Promise<ArrayBuffer | null> {
  const buffer = await invoke<ArrayBuffer>('import_model')
  return buffer.byteLength === 0 ? null : buffer
}

/**
 * Open a native save dialog pre-filled with `defaultName` and write `bytes`.
 * Resolves to `false` if the user cancelled.
 */
export async function exportOutput(bytes: Uint8Array, defaultName: string): Promise<boolean> {
  return invoke<boolean>('export_output', { data: Array.from(bytes), defaultName })
}

/**
 * Forward one encoded frame to the native PiP window. The bytes are sent as
 * the raw invoke body (`application/octet-stream`), so a bare `Uint8Array` is
 * the payload — do NOT wrap it in an argument object.
 */
export async function pushFrame(bytes: Uint8Array): Promise<void> {
  await invoke('push_frame', bytes)
}

/**
 * Subscribe to frames broadcast by the native side. Each message is a raw
 * `ArrayBuffer` of encoded image bytes.
 */
export async function subscribeFrames(onFrame: (buf: ArrayBuffer) => void): Promise<void> {
  const ch = new Channel<ArrayBuffer>()
  ch.onmessage = onFrame
  await invoke('subscribe_frames', { onFrame: ch })
}

/**
 * Drop the stored PiP frame channel on the native side. Called when the pip
 * window goes away so stale frames are not queued to a dead webview. No-op
 * outside Tauri.
 */
export async function clearFrames(): Promise<void> {
  if (!isTauri()) return
  await invoke('clear_frames')
}

/**
 * Ask the native side to restore (show + unminimize + focus) the main window,
 * e.g. from the pip window's double-click. No-op outside Tauri.
 */
export async function restoreMain(): Promise<void> {
  if (!isTauri()) return
  await invoke('restore_main')
}

/**
 * Tell the native side whether minimizing the main window should hide it to the
 * tray. No-op outside Tauri.
 */
export async function setMinimizeToTray(enabled: boolean): Promise<void> {
  if (!isTauri()) return
  await invoke('set_minimize_to_tray', { enabled })
}

/**
 * Report whether a face is currently detected. Mirrored to the PiP window by
 * the native side. No-op outside Tauri.
 */
export async function setFacePresent(present: boolean): Promise<void> {
  if (!isTauri()) return
  await invoke('set_face_present', { present })
}

/** Read the last reported face state; `false` outside Tauri. */
export async function getFacePresent(): Promise<boolean> {
  if (!isTauri()) return false
  return invoke<boolean>('get_face_present')
}

/**
 * Tell the native side whether recording is active, so restoring the main
 * window warns first. No-op outside Tauri.
 */
export async function setRecordingMode(enabled: boolean): Promise<void> {
  if (!isTauri()) return
  await invoke('set_recording_mode', { enabled })
}

/**
 * Report the current output-mask shape and radius percentage so the PiP window
 * can draw a matching no-face border. No-op outside Tauri.
 */
export async function setPipMask(shape: string, radius: number): Promise<void> {
  if (!isTauri()) return
  await invoke('set_pip_mask', { shape, radius })
}

/** Read the last reported output mask; `['none', 0]` outside Tauri. */
export async function getPipMask(): Promise<[string, number]> {
  if (!isTauri()) return ['none', 0]
  return invoke<[string, number]>('get_pip_mask')
}

/** Subscribe to `tray://minimized`. Returns an unlisten fn (no-op outside Tauri). */
export async function onTrayMinimized(cb: () => void): Promise<() => void> {
  return listenTrayEvent('tray://minimized', cb)
}

/** Subscribe to `tray://restored`. Returns an unlisten fn (no-op outside Tauri). */
export async function onTrayRestored(cb: () => void): Promise<() => void> {
  return listenTrayEvent('tray://restored', cb)
}

/** Shared guarded `listen` wrapper for tray lifecycle events. */
async function listenTrayEvent(event: string, cb: () => void): Promise<() => void> {
  if (!isTauri()) return () => {}
  return listen(event, () => cb())
}
