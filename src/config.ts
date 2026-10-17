/**
 * Central configuration: asset locations, camera constraints and every
 * user-tunable default shared by the engine modules.
 */
import { asset } from './assets'

// ---- MediaPipe / model assets (root-absolute, served from Vite public/) ----
export const WASM_PATH = asset('mediapipe/wasm')
export const FACE_LANDMARKER_MODEL = asset('mediapipe/face_landmarker.task')
export const SELFIE_SEGMENTER_MODEL = asset('mediapipe/selfie_segmenter.tflite')
export const AVATAR_MODEL = asset('models/redpanda_head.glb')

// ---- Camera ----
export const CAMERA_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 1280 },
  height: { ideal: 720 },
  facingMode: 'user',
}

// ---- Avatar / aniface ----
/** Canvas the transparent 3D avatar is rendered onto. */
export const AVATAR_CANVAS_SIZE = 240

/** ARKit blendshape multipliers (names matched verbatim, no remapping). */
export const BLENDSHAPE_MULTIPLIERS: Record<string, number> = {
  eyeBlinkLeft: 1.2,
  eyeBlinkRight: 1.2,
  jawOpen: 1.0,
  mouthSmileLeft: 1.1,
  mouthSmileRight: 1.1,
  browInnerUp: 1.2,
}

/**
 * Eye-gaze mirror correction.
 *
 * The avatar head is driven by the facial transform matrix, which `aniface`
 * mirrors sagittally (negates yaw+roll) so the avatar behaves like the user's
 * reflection. Blendshapes, however, are matched by name with no mirror, so the
 * eye-look signals land on the opposite side and the avatar's gaze ends up
 * horizontally reversed. We reflect the eye-look family (Left <-> Right) before
 * handing the result to `aniface` so the gaze matches the mirrored head.
 */
export const MIRROR_EYE_GAZE = true

/** Left<->Right reflection of the ARKit eye-look blendshape names. */
export const EYE_GAZE_MIRROR: Record<string, string> = {
  eyeLookInLeft: 'eyeLookInRight',
  eyeLookInRight: 'eyeLookInLeft',
  eyeLookOutLeft: 'eyeLookOutRight',
  eyeLookOutRight: 'eyeLookOutLeft',
  eyeLookUpLeft: 'eyeLookUpRight',
  eyeLookUpRight: 'eyeLookUpLeft',
  eyeLookDownLeft: 'eyeLookDownRight',
  eyeLookDownRight: 'eyeLookDownLeft',
}

export const AVATAR_CAMERA = {
  fov: 40,
  enableControls: true,
  enableZoom: true,
} as const

// ---- Composite (paste avatar into camera frame) ----
export interface CompositeDefaults {
  size: number
  dx: number
  dy: number
}

export const COMPOSITE_DEFAULTS: CompositeDefaults = { size: 1.8, dx: 0, dy: 0 }

/** Face-box expansion: sides ±side*fw, top -top*fh, bottom +bottom*fh. */
export const FACE_BOX = { side: 0.32, top: 0.62, bottom: 0.18 } as const

// ---- Background blur ----
export const BLUR_DEFAULT_PX = 14
export const BLUR_MIN_PX = 2
export const BLUR_MAX_PX = 40

// ---- Output selection ----
export type MaskShape = 'none' | 'round' | 'circle'

export interface Selection {
  w: number
  h: number
  cx: number
  cy: number
  mul: number
  mask: MaskShape
  radius: number
  feather: number
  /** Lock width/height together while resizing (mouse handles + sliders). */
  keepAspect: boolean
}

export const SELECTION_DEFAULTS: Selection = {
  w: 400,
  h: 400,
  cx: 0.5,
  cy: 0.5,
  mul: 1,
  mask: 'none',
  radius: 18,
  feather: 0,
  keepAspect: false,
}

/** Rectangle of the selection in composite-buffer pixels (top-left origin). */
export interface SelRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Selection rectangle clamped to the canvas. Shared by the overlay renderer
 * and the pointer hit-testing so drawn handles and hit targets line up exactly.
 */
export function selectionRect(sel: Selection, cw: number, ch: number): SelRect {
  const w = cw > 0 ? Math.min(sel.w, cw) : 0
  const h = ch > 0 ? Math.min(sel.h, ch) : 0
  let x = sel.cx * cw - w / 2
  let y = sel.cy * ch - h / 2
  x = Math.max(0, Math.min(cw - w, x))
  y = Math.max(0, Math.min(ch - h, y))
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) }
}

/** Resize-handle size in composite-buffer pixels (legible at any camera size). */
export function selectionHandlePx(canvasWidth: number): number {
  return Math.max(8, Math.min(12, Math.round(canvasWidth / 140)))
}

// ---- Model transform (canvas-local, applied to the wrapper group) ----
export interface ModelTransform {
  scale: number
  x: number
  y: number
  z: number
}

export const TRANSFORM_DEFAULTS: ModelTransform = { scale: 1, x: 0, y: 0, z: 0 }

/** Default camera position used by "reset view". */
export const RESET_CAMERA = { position: [0, 0, 1.5] as [number, number, number], fov: 40 }

// ---- Persisted UI settings ----
/** Bump when the persisted shape changes; old payloads are then discarded. */
export const SETTINGS_VERSION = 1
export const SETTINGS_KEY = 'anifaceup.settings.v1'

/**
 * The user-tunable settings saved to localStorage. Manual-expression sliders
 * are intentionally excluded, and the aspect ratio is derived from `w/h`
 * (never stored) so it can never drift from the dimensions.
 */
export interface PersistedSettings {
  version: number
  mirror: boolean
  landmarks: boolean
  mesh: boolean
  blur: { on: boolean; invert: boolean; px: number }
  composite: { on: boolean; size: number; dx: number; dy: number }
  selection: {
    w: number
    h: number
    cx: number
    cy: number
    mul: number
    mask: MaskShape
    radius: number
    feather: number
    keepAspect: boolean
  }
  transform: ModelTransform
  pipEnabled: boolean
  minimizeToTray: boolean
}
