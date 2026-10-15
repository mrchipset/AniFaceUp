/**
 * Output view: crop the composite by the selection, scale by the multiplier and
 * apply an optional mask (none / rounded / circle) with feather. Also draws the
 * interactive selection overlay back onto the composite.
 *
 * Draw order is composite → output → selection overlay, so the overlay never
 * contaminates the exported crop.
 */
import { SELECTION_DEFAULTS, type MaskShape, type Selection } from '../config'

export interface SelRect {
  x: number
  y: number
  w: number
  h: number
}

export class OutputRenderer {
  readonly canvas: HTMLCanvasElement
  private readonly comp: HTMLCanvasElement
  private readonly ctx: CanvasRenderingContext2D
  private readonly compCtx: CanvasRenderingContext2D
  private selection: Selection
  private maskCanvas: HTMLCanvasElement | null = null

  constructor(output: HTMLCanvasElement, composite: HTMLCanvasElement) {
    const ctx = output.getContext('2d')
    const compCtx = composite.getContext('2d')
    if (!ctx || !compCtx) throw new Error('2D context unavailable for output/composite canvas')
    this.canvas = output
    this.comp = composite
    this.ctx = ctx
    this.compCtx = compCtx
    this.selection = { ...SELECTION_DEFAULTS }
  }

  getSelection(): Selection {
    return { ...this.selection }
  }

  setSelection(partial: Partial<Selection>): void {
    this.selection = { ...this.selection, ...partial }
  }

  resetSelection(): void {
    this.selection = { ...SELECTION_DEFAULTS }
  }

  /** Selection rectangle in composite pixel coordinates (top-left origin). */
  selRect(): SelRect {
    const cw = this.comp.width
    const ch = this.comp.height
    const w = Math.min(this.selection.w, cw)
    const h = Math.min(this.selection.h, ch)
    let x = this.selection.cx * cw - w / 2
    let y = this.selection.cy * ch - h / 2
    x = Math.max(0, Math.min(cw - w, x))
    y = Math.max(0, Math.min(ch - h, y))
    return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
  }

  /** Crop + scale + mask the composite into the output canvas. */
  draw(): void {
    const r = this.selRect()
    const ow = Math.max(1, Math.round(r.w * this.selection.mul))
    const oh = Math.max(1, Math.round(r.h * this.selection.mul))
    if (this.canvas.width !== ow || this.canvas.height !== oh) {
      this.canvas.width = ow
      this.canvas.height = oh
    }
    const c = this.ctx
    c.setTransform(1, 0, 0, 1, 0, 0)
    c.clearRect(0, 0, ow, oh)
    c.imageSmoothingEnabled = true
    c.imageSmoothingQuality = 'high'
    c.drawImage(this.comp, r.x, r.y, r.w, r.h, 0, 0, ow, oh)
    this.applyMask(c, ow, oh)
  }

  /** Draw the semi-transparent selection overlay onto the composite. */
  drawSelectionOverlay(): void {
    if (!this.comp.width || !this.comp.height) return
    const cctx = this.compCtx
    const r = this.selRect()
    cctx.save()
    cctx.fillStyle = 'rgba(0,0,0,0.38)'
    cctx.beginPath()
    cctx.rect(0, 0, this.comp.width, this.comp.height)
    cctx.rect(r.x, r.y, r.w, r.h)
    cctx.fill('evenodd')
    cctx.strokeStyle = '#4f7cff'
    cctx.lineWidth = Math.max(2, this.comp.width / 500)
    cctx.setLineDash([10, 6])
    cctx.strokeRect(r.x, r.y, r.w, r.h)
    cctx.setLineDash([])
    cctx.fillStyle = '#4f7cff'
    cctx.font = 'bold ' + Math.max(14, this.comp.width / 45) + 'px system-ui,sans-serif'
    cctx.fillText(
      `${Math.round(r.w)}x${Math.round(r.h)} -> ${Math.round(r.w * this.selection.mul)}x${Math.round(r.h * this.selection.mul)}`,
      r.x + 6,
      Math.max(20, r.y - 8),
    )
    cctx.restore()
  }

  /** Move the selection center from a pointer position over the composite. */
  moveSelectionTo(clientX: number, clientY: number, rect: DOMRect): void {
    if (!rect.width || !rect.height) return
    this.selection.cx = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    this.selection.cy = Math.min(1, Math.max(0, (clientY - rect.top) / rect.height))
  }

  private applyMask(c: CanvasRenderingContext2D, ow: number, oh: number): void {
    const s = this.selection
    if (s.mask === 'none') return
    if (!this.maskCanvas) this.maskCanvas = document.createElement('canvas')
    const maskCanvas = this.maskCanvas
    if (maskCanvas.width !== ow || maskCanvas.height !== oh) {
      maskCanvas.width = ow
      maskCanvas.height = oh
    }
    const m = maskCanvas.getContext('2d')
    if (!m) return
    m.setTransform(1, 0, 0, 1, 0, 0)
    m.clearRect(0, 0, ow, oh)
    m.save()
    if (s.feather > 0) m.filter = 'blur(' + s.feather + 'px)'
    m.fillStyle = '#fff'
    maskPath(m, ow, oh, s.mask, s.radius)
    m.fill()
    m.restore()
    c.globalCompositeOperation = 'destination-in'
    c.drawImage(maskCanvas, 0, 0)
    c.globalCompositeOperation = 'source-over'
  }
}

function maskPath(ctx: CanvasRenderingContext2D, w: number, h: number, shape: MaskShape, radiusPct: number): void {
  ctx.beginPath()
  if (shape === 'circle') {
    ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    return
  }
  const r = Math.max(0, (Math.min(w, h) * (radiusPct / 100)) / 2) * 2
  const rr = Math.min(r, Math.min(w, h) / 2)
  if (rr <= 0.5) {
    ctx.rect(0, 0, w, h)
    return
  }
  if (ctx.roundRect) {
    ctx.roundRect(0, 0, w, h, rr)
    return
  }
  // Older browsers: hand-rolled rounded rectangle.
  ctx.moveTo(rr, 0)
  ctx.lineTo(w - rr, 0)
  ctx.quadraticCurveTo(w, 0, w, rr)
  ctx.lineTo(w, h - rr)
  ctx.quadraticCurveTo(w, h, w - rr, h)
  ctx.lineTo(rr, h)
  ctx.quadraticCurveTo(0, h, 0, h - rr)
  ctx.lineTo(0, rr)
  ctx.quadraticCurveTo(0, 0, rr, 0)
  ctx.closePath()
}
