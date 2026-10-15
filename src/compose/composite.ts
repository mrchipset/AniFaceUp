/**
 * 2D compositor: camera frame (optionally background-blurred using the selfie
 * mask) + the transparent avatar canvas pasted onto the face box.
 *
 * Mirror rule (from the reference demo): when the view is mirrored the face-box
 * center x is flipped (`cx = 1 - cx`) and the avatar paste is counter-mirrored
 * (`pasteMirror = !viewMirror`), because aniface already mirrors Y/Z internally.
 * Getting this wrong double-mirrors the avatar.
 */
import type { NormalizedLandmark } from '@mediapipe/tasks-vision'
import { FACE_BOX } from '../config'

export interface CompositeSettings {
  mirror: boolean
  blurOn: boolean
  blurPx: number
  cpOn: boolean
  size: number
  dx: number
  dy: number
}

interface Offscreen {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
}

export class CompositeRenderer {
  readonly canvas: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly avatarCanvas: HTMLCanvasElement
  private settings: CompositeSettings
  private offA: Offscreen | null = null
  private offB: Offscreen | null = null
  private offC: Offscreen | null = null
  private maskCanvas: HTMLCanvasElement | null = null
  private hasMask = false

  constructor(canvas: HTMLCanvasElement, avatarCanvas: HTMLCanvasElement, settings: CompositeSettings) {
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('2D context unavailable for composite canvas')
    this.canvas = canvas
    this.ctx = ctx
    this.avatarCanvas = avatarCanvas
    this.settings = settings
  }

  setSettings(partial: Partial<CompositeSettings>): void {
    this.settings = { ...this.settings, ...partial }
  }

  /** Provide the person alpha mask produced by the segmenter (or null). */
  setMask(canvas: HTMLCanvasElement | null, hasMask: boolean): void {
    this.maskCanvas = canvas
    this.hasMask = hasMask
  }

  clear(): void {
    this.ctx.setTransform(1, 0, 0, 1, 0, 0)
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }

  /** Draw one composite frame. `src` is the camera video/image source. */
  draw(src: CanvasImageSource, landmarks: NormalizedLandmark[] | undefined, srcW: number, srcH: number): void {
    if (!srcW || !srcH) return
    if (this.canvas.width !== srcW || this.canvas.height !== srcH) {
      this.canvas.width = srcW
      this.canvas.height = srcH
    }
    const w = this.canvas.width
    const h = this.canvas.height
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, w, h)

    // (1) Camera frame underneath (optionally blurred background).
    this.drawVideoLayer(src, w, h)

    const s = this.settings
    if (!s.cpOn || !landmarks || !landmarks.length) return

    // (2) Face box -> whole head (extrapolate upward for hair/skull).
    let x0 = 1
    let y0 = 1
    let x1 = 0
    let y1 = 0
    for (const p of landmarks) {
      if (p.x < x0) x0 = p.x
      if (p.x > x1) x1 = p.x
      if (p.y < y0) y0 = p.y
      if (p.y > y1) y1 = p.y
    }
    const fw = x1 - x0
    const fh = y1 - y0
    const bx0 = x0 - fw * FACE_BOX.side
    const bx1 = x1 + fw * FACE_BOX.side
    const by0 = y0 - fh * FACE_BOX.top
    const by1 = y1 + fh * FACE_BOX.bottom

    const bh = (by1 - by0) * h * s.size
    let cxn = (bx0 + bx1) / 2
    if (s.mirror) cxn = 1 - cxn // mirrored view: flip the face box x too
    const cx = cxn * w + s.dx * w
    const cy = ((by0 + by1) / 2) * h + s.dy * h

    // (3) Avatar canvas (transparent), fitted by height.
    const av = this.avatarCanvas
    if (!av.height) return
    const ww = bh * (av.width / av.height)
    const dx = cx - ww / 2
    const dy = cy - bh / 2
    const pasteMirror = !s.mirror // opposite of the view mirror (aniface mirrors Y/Z)
    ctx.save()
    ctx.imageSmoothingEnabled = true
    if (pasteMirror) {
      ctx.translate(dx + ww, dy)
      ctx.scale(-1, 1)
    } else {
      ctx.translate(dx, dy) // must translate, otherwise everything lands at (0,0)
    }
    ctx.drawImage(av, 0, 0, ww, bh)
    ctx.restore()
  }

  private drawVideoLayer(src: CanvasImageSource, w: number, h: number): void {
    const ctx = this.ctx
    const s = this.settings
    if (!s.blurOn || !this.hasMask || !this.maskCanvas) {
      ctx.save()
      if (s.mirror) {
        ctx.translate(w, 0)
        ctx.scale(-1, 1)
      }
      ctx.drawImage(src, 0, 0, w, h)
      ctx.restore()
      return
    }
    this.ensureOffscreens(w, h)
    const a = this.offA
    const b = this.offB
    const c = this.offC
    if (!a || !b || !c) return

    // A: source frame (mirrored as needed).
    a.ctx.setTransform(1, 0, 0, 1, 0, 0)
    a.ctx.clearRect(0, 0, w, h)
    if (s.mirror) {
      a.ctx.translate(w, 0)
      a.ctx.scale(-1, 1)
    }
    a.ctx.drawImage(src, 0, 0, w, h)

    // B: blurred version (overdrawn slightly to hide soft transparent edges).
    b.ctx.setTransform(1, 0, 0, 1, 0, 0)
    b.ctx.clearRect(0, 0, w, h)
    b.ctx.save()
    b.ctx.filter = 'blur(' + s.blurPx + 'px)'
    const pad = s.blurPx * 2
    b.ctx.drawImage(a.canvas, -pad, -pad, w + pad * 2, h + pad * 2)
    b.ctx.restore()

    // C: person cutout (frame + mask; mask must be flipped when mirrored too).
    c.ctx.setTransform(1, 0, 0, 1, 0, 0)
    c.ctx.clearRect(0, 0, w, h)
    c.ctx.drawImage(a.canvas, 0, 0)
    c.ctx.globalCompositeOperation = 'destination-in'
    c.ctx.save()
    if (s.mirror) {
      c.ctx.translate(w, 0)
      c.ctx.scale(-1, 1)
    }
    c.ctx.imageSmoothingEnabled = true
    c.ctx.drawImage(this.maskCanvas, 0, 0, w, h)
    c.ctx.restore()
    c.ctx.globalCompositeOperation = 'source-over'

    // Compose: blurred background + sharp person.
    ctx.drawImage(b.canvas, 0, 0)
    ctx.drawImage(c.canvas, 0, 0)
  }

  private ensureOffscreens(w: number, h: number): void {
    if (!this.offA) this.offA = createOffscreen()
    if (!this.offB) this.offB = createOffscreen()
    if (!this.offC) this.offC = createOffscreen()
    for (const off of [this.offA, this.offB, this.offC]) {
      if (off.canvas.width !== w || off.canvas.height !== h) {
        off.canvas.width = w
        off.canvas.height = h
      }
    }
  }
}

function createOffscreen(): Offscreen {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D context unavailable for offscreen canvas')
  return { canvas, ctx }
}
