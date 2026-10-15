/**
 * Entry point: build the harness, wire modules and run the single frame loop
 * camera → landmarker → avatar → composite → output.
 */
import './styles.css'
import {
  DrawingUtils,
  FaceLandmarker,
  type FaceLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision'
import { AVATAR_MODEL } from './config'
import { CameraController } from './camera/cameraController'
import { ensureLandmarker, getLandmarker } from './tracking/landmarker'
import { ensureSegmenter, getSegmenter, SelfieMask } from './tracking/segmenter'
import { AvatarController } from './avatar/avatarController'
import { CompositeRenderer } from './compose/composite'
import { OutputRenderer } from './compose/output'
import { isRecording, screenshot, startRecording, stopRecording } from './export/recorder'
import { exportOutput, importModel } from './lib/tauri'
import { createControls, type HarnessControls } from './ui/controls'

interface LastFrame {
  landmarks: NormalizedLandmark[] | undefined
  w: number
  h: number
}

function required<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`missing element #${id}`)
  return el as T
}

function main(): void {
  const diagEl = required<HTMLSpanElement>('diag')
  const video = required<HTMLVideoElement>('webcam')
  const overlay = required<HTMLCanvasElement>('overlay')
  const compCanvas = required<HTMLCanvasElement>('composite')
  const outCanvas = required<HTMLCanvasElement>('output')
  const avatarCanvas = required<HTMLCanvasElement>('avatar-source')
  const controlsContainer = required<HTMLDivElement>('controls')
  const preview = document.getElementById('preview')

  diagEl.textContent =
    `origin=${location.origin} secure=${window.isSecureContext} ` +
    `mediaDevices=${!!navigator.mediaDevices}`

  const octxMaybe = overlay.getContext('2d')
  if (!octxMaybe) throw new Error('2D context unavailable for overlay canvas')
  const octx = octxMaybe
  const drawUtils = new DrawingUtils(octx)

  const camera = new CameraController(video)
  const avatar = new AvatarController(avatarCanvas)
  const composite = new CompositeRenderer(compCanvas, avatarCanvas, {
    mirror: true,
    blurOn: false,
    blurPx: 14,
    cpOn: true,
    size: 1.8,
    dx: 0,
    dy: 0,
  })
  const output = new OutputRenderer(outCanvas, compCanvas)
  const mask = new SelfieMask()

  let controls: HarnessControls
  let running = false
  let starting = false
  let maskActive = false
  let lastFrame: LastFrame | null = null
  let lastDetectMs = 0
  let segTick = 0
  /** Object URL for a custom GLB chosen before the avatar was initialized. */
  let pendingModelPath: string | null = null

  // ---- settings / redraw ----
  function applyDrawSettings(): void {
    const c = controls.composite
    composite.setSettings({
      mirror: controls.mirror,
      blurOn: controls.blurOn,
      blurPx: controls.blurPx,
      cpOn: c.on,
      size: c.size,
      dx: c.dx,
      dy: c.dy,
    })
    output.setSelection(controls.selection)
  }

  function refresh(): void {
    applyDrawSettings()
    if (!lastFrame) return
    composite.setMask(mask.canvas, maskActive)
    composite.draw(video, lastFrame.landmarks, lastFrame.w, lastFrame.h)
    output.draw()
    output.drawSelectionOverlay()
  }

  function applyTransform(): void {
    avatar.setTransform(controls.transform)
    refresh()
  }

  function applyExpression(): void {
    const e = controls.expressions
    const map = new Map<string, number>([
      ['jawOpen', e.jaw],
      ['eyeBlinkLeft', e.blink],
      ['mouthSmileLeft', e.smile],
      ['browInnerUp', e.brow],
      ['tongueOut', e.tongue],
    ])
    avatar.updateBlendshapes(map)
    avatar.setHeadYaw(e.yaw)
  }

  function resetView(): void {
    avatar.resetView()
    refresh()
  }

  // ---- record / export / import ----

  function timestamp(): string {
    return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')
  }

  function errMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  async function saveBlob(blob: Blob, name: string, label: string): Promise<void> {
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer())
      const saved = await exportOutput(bytes, name)
      controls.showToast(saved ? `${label} saved` : 'save cancelled', saved ? 'success' : undefined)
    } catch (error) {
      controls.showToast(`${label} failed: ${errMessage(error)}`, 'error')
    }
  }

  function toggleRecord(): void {
    if (!isRecording()) {
      try {
        startRecording(outCanvas)
        controls.setRecording(true)
        controls.showToast('recording…')
      } catch (error) {
        controls.setRecording(false)
        controls.showToast(`recording failed: ${errMessage(error)}`, 'error')
      }
      return
    }
    void stopRecording().then((blob) => {
      controls.setRecording(false)
      if (!blob) {
        controls.showToast('recording failed', 'error')
        return
      }
      void saveBlob(blob, `anifaceup-${timestamp()}.webm`, 'recording')
    })
  }

  function takeScreenshot(): void {
    void screenshot(outCanvas)
      .then((blob) => saveBlob(blob, `anifaceup-${timestamp()}.png`, 'screenshot'))
      .catch((error: unknown) => controls.showToast(`screenshot failed: ${errMessage(error)}`, 'error'))
  }

  function importCustomModel(): void {
    void importModel()
      .then(async (buf) => {
        if (!buf) return
        const url = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }))
        if (avatar.initialized) {
          await avatar.loadModel(url)
          controls.showToast('model imported', 'success')
        } else {
          pendingModelPath = url
          controls.showToast('model staged — start camera to apply', 'success')
        }
      })
      .catch((error: unknown) => controls.showToast(`import failed: ${errMessage(error)}`, 'error'))
  }

  async function enableBlur(): Promise<void> {
    if (getSegmenter()) return
    controls.setStatus('loading segmentation model…')
    const seg = await ensureSegmenter()
    controls.setStatus(seg ? 'background blur ready' : 'segmentation model unavailable')
  }

  // ---- camera ----
  async function startCamera(): Promise<void> {
    if (starting || camera.running) return
    const problem = CameraController.supportProblem()
    if (problem) {
      controls.setStatus('camera unavailable: ' + problem)
      return
    }
    starting = true
    controls.setRunning(false)
    controls.setStatus('requesting camera…')
    try {
      const label = await camera.start()
      controls.setDevice(label)
      controls.setStatus('loading avatar model…')
      await avatar.init(pendingModelPath ?? AVATAR_MODEL)
      pendingModelPath = null
      controls.setStatus('initializing face tracker…')
      await ensureLandmarker()
      running = true
      lastFrame = null
      controls.setRunning(true)
      controls.setStatus('running')
      requestAnimationFrame(loop)
    } catch (error) {
      camera.stop()
      controls.setStatus('startup failed: ' + CameraController.describeError(error))
      controls.setRunning(false)
    } finally {
      starting = false
    }
  }

  function stopCamera(): void {
    running = false
    camera.stop()
    lastFrame = null
    maskActive = false
    composite.clear()
    output.setSelection(controls.selection)
    output.draw()
    controls.resetStats()
    controls.setRunning(false)
    controls.setStatus('stopped')
  }

  // ---- per-frame work ----
  function detect(ts: number): FaceLandmarkerResult | null {
    const landmarker = getLandmarker()
    if (!landmarker || video.readyState < 2) return null
    const t = performance.now()
    const result = landmarker.detectForVideo(video, ts)
    lastDetectMs = performance.now() - t
    return result
  }

  function tickSegmentation(ts: number): void {
    const segmenter = getSegmenter()
    if (!segmenter || !controls.blurOn) {
      maskActive = false
      return
    }
    if (segTick++ % 2 !== 0) return
    try {
      const result = segmenter.segmentForVideo(video, ts)
      maskActive = mask.update(result, controls.blurInvert)
      result.close()
    } catch (error) {
      console.warn('[segmenter] segment failed:', error)
    }
  }

  let frames = 0
  let t0 = performance.now()
  let fps = 0
  function updateStats(result: FaceLandmarkerResult | null): void {
    const now = performance.now()
    frames++
    if (now - t0 >= 500) {
      fps = (frames * 1000) / (now - t0)
      frames = 0
      t0 = now
    }
    const found = !!result?.faceLandmarks?.length
    controls.setStats(fps, lastDetectMs, found, result?.faceLandmarks[0]?.length ?? 0)
    controls.setResolution(video.videoWidth, video.videoHeight)
  }

  function drawPreview(result: FaceLandmarkerResult | null): void {
    const vw = video.videoWidth
    const vh = video.videoHeight
    if (vw && vh && (overlay.width !== vw || overlay.height !== vh)) {
      overlay.width = vw
      overlay.height = vh
    }
    if (!overlay.width || !overlay.height) return
    octx.clearRect(0, 0, overlay.width, overlay.height)
    octx.lineCap = 'round'
    octx.lineJoin = 'round'
    if (video.readyState >= 2 && vw && vh) octx.drawImage(video, 0, 0, overlay.width, overlay.height)
    if (!result?.faceLandmarks?.length) return
    const showLm = controls.showLandmarks
    const showMesh = controls.showMesh
    for (const lm of result.faceLandmarks) {
      if (showMesh) {
        drawUtils.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_TESSELATION, {
          color: '#2ee66b44',
          lineWidth: 1,
        })
      }
      if (showLm) {
        drawUtils.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_FACE_OVAL, { color: '#ffffffcc', lineWidth: 2 })
        drawUtils.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LIPS, { color: '#ff7ab6dd', lineWidth: 2 })
        drawUtils.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_EYE, { color: '#ffd166', lineWidth: 2 })
        drawUtils.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE, { color: '#66d9ff', lineWidth: 2 })
        drawUtils.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_LEFT_EYEBROW, { color: '#ffd16699', lineWidth: 1 })
        drawUtils.drawConnectors(lm, FaceLandmarker.FACE_LANDMARKS_RIGHT_EYEBROW, { color: '#66d9ff99', lineWidth: 1 })
        drawUtils.drawLandmarks(lm, { color: '#ffffff77', radius: 1 })
      }
    }
  }

  function loop(): void {
    if (!running) return
    const ts = performance.now()
    const result = detect(ts)
    tickSegmentation(ts)

    if (avatar.ready) {
      avatar.processLandmarks(result)
      avatar.render()
    }

    applyDrawSettings()
    const landmarks = result?.faceLandmarks?.[0]
    const w = video.videoWidth
    const h = video.videoHeight
    composite.setMask(mask.canvas, maskActive)
    composite.draw(video, landmarks, w, h)
    output.draw()
    output.drawSelectionOverlay()
    drawPreview(result)
    updateStats(result)
    lastFrame = { landmarks, w, h }

    requestAnimationFrame(loop)
  }

  controls = createControls(controlsContainer, preview, {
    onStartCamera: () => void startCamera(),
    onStopCamera: stopCamera,
    onRefresh: refresh,
    onTransform: applyTransform,
    onExpression: applyExpression,
    onResetView: resetView,
    onBlurEnable: () => void enableBlur(),
    onToggleRecord: toggleRecord,
    onScreenshot: takeScreenshot,
    onImportModel: importCustomModel,
  })
  controls.attachSelectionDrag(compCanvas)
  controls.setRunning(false)
  controls.setStatus('idle')
  applyDrawSettings()
}

try {
  main()
} catch (error) {
  console.error('[anifaceup] boot failed:', error)
  const diag = document.getElementById('diag')
  if (diag) diag.textContent = 'boot failed: ' + (error instanceof Error ? error.message : String(error))
}
