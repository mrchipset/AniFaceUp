/**
 * MediaPipe ImageSegmenter (selfie model, VIDEO mode) built from LOCAL
 * vendored wasm/model, GPU→CPU fallback. `SelfieMask` converts the segmenter
 * result into an alpha mask canvas (person = opaque) for background blur.
 */
import {
  FilesetResolver,
  ImageSegmenter,
  type ImageSegmenterOptions,
  type ImageSegmenterResult,
} from '@mediapipe/tasks-vision'
import { SELFIE_SEGMENTER_MODEL, WASM_PATH } from '../config'

let segmenter: ImageSegmenter | null = null
let tried = false
let delegate: 'GPU' | 'CPU' | null = null

export function getSegmenter(): ImageSegmenter | null {
  return segmenter
}

export function getSegmenterDelegate(): string | null {
  return delegate
}

function optionsFor(dev: 'GPU' | 'CPU'): ImageSegmenterOptions {
  return {
    baseOptions: { modelAssetPath: SELFIE_SEGMENTER_MODEL, delegate: dev },
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  }
}

export async function ensureSegmenter(): Promise<ImageSegmenter | null> {
  if (segmenter || tried) return segmenter
  tried = true
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
  for (const dev of ['GPU', 'CPU'] as const) {
    try {
      segmenter = await ImageSegmenter.createFromOptions(vision, optionsFor(dev))
      delegate = dev
      console.info(`[segmenter] ready (${dev})`)
      return segmenter
    } catch (error) {
      console.warn(`[segmenter] ${dev} init failed:`, error)
    }
  }
  console.warn('[segmenter] unavailable')
  return null
}

export type MaskKind = 'confidence' | 'category' | 'none'

/**
 * Alpha mask derived from a segmentation result. White RGB with the person
 * confidence in the alpha channel, so it can be used with `destination-in`.
 */
export class SelfieMask {
  readonly canvas: HTMLCanvasElement
  kind: MaskKind = 'none'
  personPct = 0
  private readonly ctx: CanvasRenderingContext2D

  constructor() {
    this.canvas = document.createElement('canvas')
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('2D context unavailable for segmentation mask')
    this.ctx = ctx
  }

  /** Returns true when a usable mask was produced. */
  update(result: ImageSegmenterResult | null, invert: boolean): boolean {
    if (!result) {
      this.kind = 'none'
      return false
    }
    // selfie_segmenter usually emits only a category mask (0/1); some versions
    // emit confidence masks (0..1). Handle both.
    let arr: Float32Array | Uint8Array | null = null
    let mw = 0
    let mh = 0
    let isCategory = false
    if (result.confidenceMasks && result.confidenceMasks.length) {
      const mask = result.confidenceMasks[0]
      mw = mask.width
      mh = mask.height
      arr = mask.getAsFloat32Array()
      this.kind = 'confidence'
    } else if (result.categoryMask) {
      const mask = result.categoryMask
      mw = mask.width
      mh = mask.height
      arr = mask.getAsUint8Array()
      isCategory = true
      this.kind = 'category'
    }
    if (!arr || !mw || !mh) {
      this.kind = 'none'
      return false
    }
    if (this.canvas.width !== mw || this.canvas.height !== mh) {
      this.canvas.width = mw
      this.canvas.height = mh
    }
    const image = this.ctx.createImageData(mw, mh)
    let person = 0
    for (let i = 0; i < mw * mh; i++) {
      let a = isCategory ? (arr[i] > 0 ? 1 : 0) : arr[i]
      if (invert) a = 1 - a
      person += a
      image.data[i * 4] = 255
      image.data[i * 4 + 1] = 255
      image.data[i * 4 + 2] = 255
      image.data[i * 4 + 3] = Math.max(0, Math.min(1, a)) * 255
    }
    this.personPct = Math.round((100 * person) / (mw * mh))
    this.ctx.putImageData(image, 0, 0)
    return true
  }
}
