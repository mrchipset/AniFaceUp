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
