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
import { exportOutput, importModel, onTrayMinimized, onTrayRestored, pushFrame, setFacePresent, setMinimizeToTray, setPipMask, setRecordingMode } from './lib/tauri'
import { hidePip, isPipVisible, showPip } from './pip/pipWindow'
import { createControls, type HarnessControls } from './ui/controls'
import { loadSettings, saveSettings } from './ui/persistence'

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** PiP push rate and the minimized-mode loop rate. */
const PIP_FPS = 20
const PIP_INTERVAL_MS = 1000 / PIP_FPS
/** Longest side of the downscaled snapshot sent to the PiP (bounds encode cost). */
const MAX_PIP_SNAPSHOT = 640

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

/** Minimum boot-splash dwell, measured from page load, to avoid a hard flicker. */
const MIN_SPLASH_MS = 200
let appRevealed = false

/** Reveal the shell and fade the boot splash. Safe to call more than once. */
function revealApp(): void {
  if (appRevealed) return
  appRevealed = true
  const elapsed = typeof performance !== 'undefined' ? performance.now() : MIN_SPLASH_MS
  const wait = Math.max(0, MIN_SPLASH_MS - elapsed)
  window.setTimeout(() => {
    requestAnimationFrame(() => document.body.classList.add('ready'))
  }, wait)
}

function main(): void {
  const video = required<HTMLVideoElement>('webcam')
  const overlay = required<HTMLCanvasElement>('overlay')
  const compCanvas = required<HTMLCanvasElement>('composite')
  const outCanvas = required<HTMLCanvasElement>('output')
  const avatarCanvas = required<HTMLCanvasElement>('avatar-source')
  const controlsContainer = required<HTMLDivElement>('controls')
  const preview = document.getElementById('preview')

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

  /** Debounced autosave; coalesces rapid slider/pointer changes. */
  let saveTimer: number | null = null
  function scheduleSave(): void {
    if (saveTimer !== null) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      saveTimer = null
      saveSettings(controls.getState())
    }, 250)
  }

  /** Flush any pending debounced save immediately (called on page exit). */
  function flushSave(): void {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    saveSettings(controls.getState())
  }

  // ---- PiP output window ----
  /** True while the main window is hidden to the tray (driven by Rust events). */
  let trayMode = false
  let pipPushPending = false
  let lastPipPush = 0
  /** Last reported face-presence (null until the first detection tick). */
  let lastFacePresent: boolean | null = null
  /** Reusable downscaled snapshot canvas for PiP encoding. */
  let snapshotCanvas: HTMLCanvasElement | null = null
  let snapshotCtx: CanvasRenderingContext2D | null = null

  /** Show the PiP only while the camera runs, the window is in the tray and it is enabled. */
  function syncPip(): void {
    if (running && trayMode && controls.pipEnabled) {
      void showPip().catch((error: unknown) => {
        console.error('[pip] show failed:', error)
        controls.showToast('output window failed: ' + String(error), 'error')
      })
    } else {
      void hidePip()
    }
  }

  /** Throttled, downscaled PNG snapshot of the output, forwarded to the PiP. */
  function pushPipFrame(): void {
    if (!isPipVisible() || pipPushPending) return
    // No face: leave the PiP on its last frame and do not touch the throttle.
    if (lastFacePresent !== true) return
    const now = performance.now()
    if (now - lastPipPush < PIP_INTERVAL_MS) return
    lastPipPush = now
    pipPushPending = true
    try {
      // Downscale into a reusable canvas: encoding the full-size output is the
      // dominant cost (tens of ms at 1280x720), while a 640px PNG stays cheap.
      const scale = Math.min(1, MAX_PIP_SNAPSHOT / Math.max(outCanvas.width, outCanvas.height))
      const sw = Math.max(1, Math.round(outCanvas.width * scale))
      const sh = Math.max(1, Math.round(outCanvas.height * scale))
      if (!snapshotCanvas || !snapshotCtx) {
        snapshotCanvas = document.createElement('canvas')
        snapshotCtx = snapshotCanvas.getContext('2d')
      }
      const canvas = snapshotCanvas
      const ctx = snapshotCtx
      if (!ctx) {
        pipPushPending = false
        return
      }
      if (canvas.width !== sw || canvas.height !== sh) {
        // Resizing resets context state, so configure smoothing afterwards.
        canvas.width = sw
        canvas.height = sh
      }
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.clearRect(0, 0, sw, sh)
      ctx.drawImage(outCanvas, 0, 0, sw, sh)
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            pipPushPending = false
            return
          }
          blob
            .arrayBuffer()
            .then((buf) => pushFrame(new Uint8Array(buf)))
            .catch((error: unknown) => console.warn('[pip] push failed:', error))
            .finally(() => {
              pipPushPending = false
            })
        },
        // PNG (not JPEG) so the output mask's transparent corners survive;
        // JPEG has no alpha and would render them black.
        'image/png',
      )
    } catch (error) {
      pipPushPending = false
      console.warn('[pip] snapshot failed:', error)
    }
  }

  /**
   * Restart the frame loop on the driver appropriate to the current state. rAF
   * pauses while the window is hidden to the tray, so on a tray transition we
   * must explicitly cancel and reschedule — the paused loop cannot self-switch.
   */
  function restartLoopDriver(): void {
    if (!running) return
    clearLoop()
    scheduleNext()
  }

  /**
   * Keep the PiP in sync with the tray state, driven by the native
   * `tray://minimized` / `tray://restored` events (minimizing now hides the
   * window to the tray, so `isMinimized()` is no longer usable).
   */
  function watchTrayMode(): void {
    if (!isTauri()) return
    void onTrayMinimized(() => {
      trayMode = true
      syncPip()
      restartLoopDriver()
    }).catch((error: unknown) => console.warn('[pip] tray-minimized subscribe failed:', error))
    void onTrayRestored(() => {
      trayMode = false
      syncPip()
      restartLoopDriver()
    }).catch((error: unknown) => console.warn('[pip] tray-restored subscribe failed:', error))
  }

  // ---- settings / redraw ----
  /** Last mask sent to the native side, so per-frame checks avoid IPC churn. */
  let lastPipMask: string | null = null

  /** Relay the output mask (shape + radius %) to the PiP window when it changes. */
  function syncPipMask(): void {
    const sel = controls.selection
    const key = `${sel.mask}:${sel.radius}`
    if (key === lastPipMask) return
    lastPipMask = key
    void setPipMask(sel.mask, sel.radius).catch((error: unknown) =>
      console.warn('[pip] setPipMask failed:', error),
    )
  }

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
    syncPipMask()
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

  /** Stop the active recorder, reset the button and save whatever was captured. */
  function finishRecording(): void {
    void stopRecording().then((blob) => {
      controls.setRecording(false)
      if (!blob) {
        controls.showToast('recording failed', 'error')
        return
      }
      void saveBlob(blob, `anifaceup-${timestamp()}.webm`, 'recording')
    })
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
    finishRecording()
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
        // Replace (and release) any previously staged pending URL.
        if (pendingModelPath) {
          URL.revokeObjectURL(pendingModelPath)
          pendingModelPath = null
        }
        const url = URL.createObjectURL(new Blob([buf], { type: 'model/gltf-binary' }))
        if (!avatar.initialized) {
          pendingModelPath = url
          controls.showToast('model staged — start camera to apply', 'success')
          return
        }
        try {
          await avatar.loadModel(url)
          controls.showToast('model imported', 'success')
        } catch (error) {
          controls.showToast(`import failed: ${errMessage(error)}`, 'error')
          // Recover to the bundled model so the avatar is never left broken.
          try {
            await avatar.loadModel(AVATAR_MODEL)
          } catch (fallbackError) {
            controls.showToast(`model reload failed: ${errMessage(fallbackError)}`, 'error')
          }
        } finally {
          URL.revokeObjectURL(url)
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
      // Re-apply the transform: a restore before init only stores the values,
      // so this guarantees they are in effect once the model is ready.
      applyTransform()
      if (pendingModelPath) {
        URL.revokeObjectURL(pendingModelPath)
        pendingModelPath = null
      }
      controls.setStatus('initializing face tracker…')
      await ensureLandmarker()
      running = true
      lastFrame = null
      controls.setRunning(true)
      controls.setStatus('running')
      scheduleNext()
    } catch (error) {
      camera.stop()
      controls.setStatus('startup failed: ' + CameraController.describeError(error))
      controls.setRunning(false)
    } finally {
      starting = false
    }
  }

  function stopCamera(): void {
    // Never let a recording keep running over a frozen output.
    if (isRecording()) finishRecording()
    running = false
    clearLoop()
    camera.stop()
    lastFrame = null
    maskActive = false
    composite.clear()
    output.setSelection(controls.selection)
    output.draw()
    // Keep the selection + handles visible while idle (no frame to draw over).
    output.drawSelectionOverlay()
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
    // Report face-presence transitions to the native side (drives the PiP).
    const facePresent = !!result?.faceLandmarks?.length
    if (facePresent !== lastFacePresent) {
      lastFacePresent = facePresent
      void setFacePresent(facePresent).catch((error: unknown) =>
        console.warn('[pip] setFacePresent failed:', error),
      )
    }
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

    pushPipFrame()
    scheduleNext()
  }

  /**
   * rAF pauses while the WebView2 window is minimized, so fall back to a timer
   * at a low rate in that state to keep the PiP feed alive.
   */
  let loopRaf = 0
  let loopTimer = 0

  /** Cancel whichever loop driver (rAF or timer) is currently pending. */
  function clearLoop(): void {
    if (loopRaf) {
      cancelAnimationFrame(loopRaf)
      loopRaf = 0
    }
    if (loopTimer) {
      window.clearTimeout(loopTimer)
      loopTimer = 0
    }
  }

  /** Schedule the next frame on the driver appropriate to the current state. */
  function scheduleNext(): void {
    clearLoop()
    if (trayMode) loopTimer = window.setTimeout(loop, 1000 / PIP_FPS)
    else loopRaf = requestAnimationFrame(loop)
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
    onTogglePip: syncPip,
    onToggleMinimizeToTray: () => void setMinimizeToTray(controls.minimizeToTray),
    onToggleRecordingMode: () => void setRecordingMode(controls.recordingMode),
    onStateChange: scheduleSave,
  })
  controls.attachSelectionDrag(compCanvas)
  controls.setRunning(false)
  controls.setStatus('idle')

  // Restore saved parameters (selection dims + keepAspect land atomically).
  const saved = loadSettings()
  if (saved) {
    controls.applyState(saved)
    // Push the restored slider values into the avatar now; init() also
    // re-applies the stored transform once the model exists.
    applyTransform()
  }

  applyDrawSettings()
  // Ensure the PiP knows the mask even before the first frame/settings change.
  syncPipMask()
  // Show the selection + handles while idle, before any camera frame exists.
  output.drawSelectionOverlay()
  // Push the (possibly restored) tray preference after the restore.
  void setMinimizeToTray(controls.minimizeToTray)
  syncPip()
  watchTrayMode()
  // Flush a pending debounced save when the page is hidden/unloaded.
  window.addEventListener('pagehide', flushSave)
  window.addEventListener('beforeunload', flushSave)
  revealApp()
}

try {
  main()
} catch (error) {
  console.error('[anifaceup] boot failed:', error)
  const diag = document.getElementById('diag')
  if (diag) {
    diag.textContent = 'boot failed: ' + (error instanceof Error ? error.message : String(error))
    diag.removeAttribute('hidden')
  }
  // Never leave the styled shell hidden behind the splash after a boot error.
  revealApp()
}
