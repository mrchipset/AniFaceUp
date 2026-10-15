/**
 * Typed wrappers around the Rust binary file commands.
 *
 * Binary IPC rule: to save bytes we pass `Array.from(bytes)` as the named
 * argument `data`; to read bytes the Rust command returns
 * `tauri::ipc::Response`, which resolves to an `ArrayBuffer` on the frontend.
 */
import { invoke } from '@tauri-apps/api/core'

export async function readBinaryFile(path: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('read_binary_file', { path })
}

export async function saveBinaryFile(path: string, bytes: Uint8Array): Promise<void> {
  await invoke('save_binary_file', { path, data: Array.from(bytes) })
}
