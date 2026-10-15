/**
 * Typed wrappers around the Rust native-dialog file commands.
 *
 * The file picker lives in Rust so the frontend never supplies a path.
 *
 * Binary IPC rule: to save bytes we pass `Array.from(bytes)` as the named
 * argument `data`; to read bytes the Rust command returns
 * `tauri::ipc::Response`, which resolves to an `ArrayBuffer` on the frontend.
 */
import { invoke } from '@tauri-apps/api/core'

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
