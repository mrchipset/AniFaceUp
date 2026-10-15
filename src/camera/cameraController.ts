/**
 * Camera lifecycle: getUserMedia start/stop, device enumeration and the
 * underlying `<video>` element used as the tracking source.
 */
import { CAMERA_CONSTRAINTS } from '../config'

export class CameraController {
  readonly video: HTMLVideoElement
  private stream: MediaStream | null = null

  constructor(video: HTMLVideoElement) {
    this.video = video
  }

  /** Human-readable reason the camera cannot work, or null if it can. */
  static supportProblem(): string | null {
    if (!window.isSecureContext) {
      return `not a secure context (${location.origin}); camera needs https:// or http://localhost`
    }
    if (!navigator.mediaDevices) return 'navigator.mediaDevices is unavailable'
    if (!navigator.mediaDevices.getUserMedia) return 'getUserMedia is unsupported'
    return null
  }

  get running(): boolean {
    return this.stream !== null
  }

  get streamRef(): MediaStream | null {
    return this.stream
  }

  /**
   * Request the camera, attach it to the video element and wait for metadata.
   * Resolves with a device label for diagnostics.
   */
  async start(): Promise<string> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: CAMERA_CONSTRAINTS,
      audio: false,
    })
    this.stream = stream
    this.video.srcObject = stream
    await new Promise<void>((resolve) => {
      if (this.video.readyState >= 1) resolve()
      else this.video.onloadedmetadata = () => resolve()
    })
    await this.video.play()
    const track = stream.getVideoTracks()[0]
    const settings = track.getSettings ? track.getSettings() : {}
    return track.label || settings.deviceId || 'camera'
  }

  stop(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop())
      this.stream = null
    }
    this.video.srcObject = null
  }

  async listDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) return []
    return navigator.mediaDevices.enumerateDevices()
  }

  /** Map a getUserMedia rejection onto a short, plain-language message. */
  static describeError(error: unknown): string {
    const map: Record<string, string> = {
      NotAllowedError: 'camera permission denied',
      NotFoundError: 'no camera device found',
      NotReadableError: 'camera is in use by another program',
      OverconstrainedError: 'requested resolution is unsupported',
    }
    if (error && typeof error === 'object') {
      const name = 'name' in error ? String((error as { name?: unknown }).name) : ''
      const message = 'message' in error ? String((error as { message?: unknown }).message) : ''
      return `${map[name] || name || 'camera error'}${message ? ' — ' + message : ''}`
    }
    return String(error)
  }
}
