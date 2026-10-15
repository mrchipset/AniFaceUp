/**
 * Recording + screenshot helpers for the output canvas.
 *
 * `MediaRecorder` captures a live `captureStream` of the output canvas; the
 * first supported WebM mime type is chosen, falling back to the encoder
 * default. Screenshots are a single PNG `toBlob` snapshot.
 *
 * These operate on the OUTPUT canvas (`#output`) so exports match exactly what
 * the user sees in the crop preview.
 */

const MIME_CANDIDATES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', ''] as const

let recorder: MediaRecorder | null = null
let chunks: BlobPart[] = []

/** First supported WebM mime type, or `''` to let the platform choose. */
function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return ''
  for (const candidate of MIME_CANDIDATES) {
    if (candidate === '' || MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return ''
}

/** Begin capturing `canvas` at 30fps. No-op if already recording. */
export function startRecording(canvas: HTMLCanvasElement): void {
  if (recorder) return
  const stream = canvas.captureStream(30)
  const mimeType = pickMimeType()
  const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
  chunks = []
  rec.ondataavailable = (event): void => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  rec.start()
  recorder = rec
}

/** Stop the active recorder, resolving with the recorded Blob (or `null`). */
export function stopRecording(): Promise<Blob | null> {
  const rec = recorder
  if (!rec) return Promise.resolve(null)
  return new Promise<Blob | null>((resolve) => {
    rec.onstop = (): void => {
      const blob = chunks.length ? new Blob(chunks, { type: rec.mimeType || 'video/webm' }) : null
      chunks = []
      recorder = null
      resolve(blob)
    }
    rec.stop()
  })
}

export function isRecording(): boolean {
  return recorder !== null && recorder.state !== 'inactive'
}

/** Snapshot `canvas` to a PNG Blob. */
export function screenshot(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('canvas.toBlob returned null'))
    }, 'image/png')
  })
}
