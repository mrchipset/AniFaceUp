/**
 * MediaPipe FaceLandmarker (VIDEO mode) built from LOCAL vendored wasm/model.
 * Tries the GPU delegate first and falls back to CPU on failure.
 */
import {
  FaceLandmarker,
  FilesetResolver,
  type FaceLandmarkerOptions,
} from '@mediapipe/tasks-vision'
import { FACE_LANDMARKER_MODEL, WASM_PATH } from '../config'

let landmarker: FaceLandmarker | null = null
let delegate: 'GPU' | 'CPU' | null = null

export function getLandmarker(): FaceLandmarker | null {
  return landmarker
}

export function getLandmarkerDelegate(): string | null {
  return delegate
}

function optionsFor(dev: 'GPU' | 'CPU'): FaceLandmarkerOptions {
  return {
    baseOptions: { modelAssetPath: FACE_LANDMARKER_MODEL, delegate: dev },
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    runningMode: 'VIDEO',
    numFaces: 1,
  }
}

export async function ensureLandmarker(): Promise<FaceLandmarker> {
  if (landmarker) return landmarker
  const vision = await FilesetResolver.forVisionTasks(WASM_PATH)
  let lastError: unknown = null
  for (const dev of ['GPU', 'CPU'] as const) {
    try {
      landmarker = await FaceLandmarker.createFromOptions(vision, optionsFor(dev))
      delegate = dev
      console.info(`[landmarker] ready (${dev})`)
      return landmarker
    } catch (error) {
      lastError = error
      console.warn(`[landmarker] ${dev} init failed:`, error)
    }
  }
  throw new Error('FaceLandmarker initialization failed: ' + describe(lastError))
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
