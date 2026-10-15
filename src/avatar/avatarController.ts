/**
 * Thin wrapper around aniface's `Aniface` for a head-only avatar.
 *
 * Critical: `Aniface` is constructed WITHOUT `videoElement` so it never builds
 * its own MediaPipe detector (which would use a hardcoded CDN wasm path). We
 * drive it via `getRenderer().processLandmarks(result)` / `.render()`.
 *
 * Head-only stabilization (copied from the reference demo):
 *  - The aniface head-only branch scales the face matrix by 40. A wrapper
 *    `THREE.Group` cancels that inner scale so UI `Scale = 1` is natural size.
 *  - The model root matrix translation is zeroed so the avatar does not drift
 *    around the canvas (only rotation/scale is kept).
 */
import * as THREE from 'three'
import { Aniface, type AvatarRenderer } from 'aniface'
import type { FaceLandmarkerResult } from '@mediapipe/tasks-vision'
import {
  AVATAR_CAMERA,
  AVATAR_CANVAS_SIZE,
  BLENDSHAPE_MULTIPLIERS,
  EYE_GAZE_MIRROR,
  MIRROR_EYE_GAZE,
  RESET_CAMERA,
  TRANSFORM_DEFAULTS,
  type ModelTransform,
} from '../config'

export class AvatarController {
  private readonly canvas: HTMLCanvasElement
  private aniface: Aniface | null = null
  private wrapper: THREE.Group | null = null
  private transform: ModelTransform = { ...TRANSFORM_DEFAULTS }

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.canvas.width = AVATAR_CANVAS_SIZE
    this.canvas.height = AVATAR_CANVAS_SIZE
  }

  get ready(): boolean {
    return this.aniface?.ready ?? false
  }

  /** Whether an `Aniface` instance exists (even if still initializing). */
  get initialized(): boolean {
    return this.aniface !== null
  }

  async init(modelPath: string): Promise<void> {
    if (this.aniface) return
    const aniface = new Aniface({
      canvasElement: this.canvas,
      modelPath,
      cameraConfig: { ...AVATAR_CAMERA },
      blendshapeMultipliers: BLENDSHAPE_MULTIPLIERS,
      modelOptions: { scale: 1.0, center: true, autoRotate: false, rotation: 0 },
    })
    this.aniface = aniface
    await aniface.initialize()
    this.ensureWrapper()
    this.applyTransform()
  }

  /**
   * Swap the avatar model in place. Destroys the current `Aniface`, then
   * recreates it on the SAME canvas (never passing `videoElement`) and
   * re-applies the head-only stabilization.
   */
  async loadModel(modelPath: string): Promise<void> {
    this.destroyAniface()
    await this.init(modelPath)
  }

  /** Tear down the aniface instance and release its WebGL resources. */
  dispose(): void {
    this.destroyAniface()
  }

  private destroyAniface(): void {
    if (!this.aniface) return
    try {
      this.aniface.destroy()
    } catch (error) {
      console.warn('[avatar] destroy failed:', error)
    }
    this.aniface = null
    this.wrapper = null
  }

  /** Add a parent group so we can offset/scale the model without touching the root matrix. */
  private ensureWrapper(): void {
    if (this.wrapper) return
    const inner = this.getModelScene()
    if (!inner || !inner.parent) return
    const wrapper = new THREE.Group()
    inner.parent.add(wrapper)
    wrapper.add(inner)
    wrapper.position.set(0, 0, 0)
    wrapper.scale.setScalar(1)
    this.wrapper = wrapper
  }

  private getModelScene(): THREE.Group | null {
    return this.aniface?.getRenderer()?.getAvatar()?.getScene() ?? null
  }

  /**
   * Zero the root-matrix translation the face matrix wrote, then cancel the
   * inner 40x scale via the wrapper so UI Scale=1 is natural size.
   */
  private stabilize(): void {
    const inner = this.getModelScene()
    if (inner) {
      const e = inner.matrix.elements
      e[12] = 0
      e[13] = 0
      e[14] = 0
    }
    if (!this.wrapper) return
    let innerScale = 1
    if (inner) {
      const p = new THREE.Vector3()
      const q = new THREE.Quaternion()
      const s = new THREE.Vector3()
      inner.matrix.decompose(p, q, s)
      if (s.x > 1e-6) innerScale = s.x
    }
    this.wrapper.scale.setScalar(this.transform.scale / innerScale)
    this.wrapper.position.set(this.transform.x, this.transform.y, this.transform.z)
  }

  /**
   * Reflect the eye-look blendshapes left<->right before aniface consumes them.
   * The head is mirrored internally by aniface but blendshapes are not, so
   * without this the avatar's horizontal gaze is reversed relative to the head.
   */
  private mirrorEyeGaze(result: FaceLandmarkerResult): void {
    if (!MIRROR_EYE_GAZE) return
    const categories = result.faceBlendshapes?.[0]?.categories
    if (!categories) return
    const original = new Map<string, number>()
    for (const category of categories) original.set(category.categoryName, category.score)
    for (const category of categories) {
      const source = EYE_GAZE_MIRROR[category.categoryName]
      if (source === undefined) continue
      const value = original.get(source)
      if (value !== undefined) category.score = value
    }
  }

  /** Update blendshapes + head pose. Call before `render()` each frame. */
  processLandmarks(result: FaceLandmarkerResult | null): void {
    const renderer = this.aniface?.getRenderer()
    if (!renderer) return
    if (result?.faceLandmarks?.length) {
      this.mirrorEyeGaze(result)
      renderer.processLandmarks(result)
      this.stabilize()
    }
  }

  render(): void {
    this.aniface?.getRenderer()?.render()
  }

  getRenderer(): AvatarRenderer | null {
    return this.aniface?.getRenderer() ?? null
  }

  setTransform(partial: Partial<ModelTransform>): void {
    this.transform = { ...this.transform, ...partial }
    this.applyTransform()
  }

  getTransform(): ModelTransform {
    return { ...this.transform }
  }

  private applyTransform(): void {
    this.stabilize()
    this.render()
  }

  /** Restore the default camera framing and re-apply the current transform. */
  resetView(): void {
    const camera = this.aniface?.getRenderer()?.getCamera()
    if (camera) {
      camera.position.set(RESET_CAMERA.position[0], RESET_CAMERA.position[1], RESET_CAMERA.position[2])
      camera.fov = RESET_CAMERA.fov
      camera.updateProjectionMatrix()
      camera.lookAt(0, 0, 0)
    }
    this.applyTransform()
  }

  /** Manual expression testing (ARKit names, no remapping). */
  updateBlendshapes(map: Map<string, number>): void {
    this.aniface?.getRenderer()?.getAvatar()?.updateBlendshapes(map)
  }

  setHeadYaw(yaw: number): void {
    const scene = this.getModelScene()
    if (scene) {
      scene.matrixAutoUpdate = true
      scene.rotation.y = yaw * 0.6
      scene.updateMatrix()
    }
    this.render()
  }
}
