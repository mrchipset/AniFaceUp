# AGENTS.md — AniFaceUp

Guidance for agentic coding assistants working in this repository.

## 1. What this project is

**AniFaceUp** is a Tauri v2 desktop application (Windows/WebView2) that turns a
live webcam feed into a cartoonized view: it tracks the user's face with
MediaPipe, drives a 3D cartoon avatar (ARKit blendshapes) via the `aniface`
library, composites the rendered avatar onto the camera image aligned to the
face, optionally blurs the background, and crops/masks a configurable output
region. It can record/export the output and import custom ARKit GLB models.

It is a faithful port of the reference demo at
`C:\Users\Zouyu\tmp\blender\aniface-demo` (web-only), re-architected as a
native desktop app with a redesigned, concise UI.

## 2. Architecture

```
webcam <video> ──► MediaPipe FaceLandmarker ──► aniface AvatarRenderer (three.js, transparent canvas)
                          │                              │
                          └──► ImageSegmenter (selfie) ──┤
                                                         ▼
                                   composite canvas (camera + avatar + background blur)
                                                         ▼
                                   output canvas (crop × scale × mask/feather)
                                                         ▼
                                   record (MediaRecorder/webm) · screenshot (PNG)
```

- **Frontend** (`src/`): TypeScript, no UI framework, vanilla DOM modules.
- **Native** (`src-tauri/`): Tauri v2. Owns the WebView2 camera permission grant
  and binary file read/write used by import/export.
- All ML/3D runs in the WebView (WASM + WebGL). Rust is a thin capability layer.

## 3. Directory layout

```
src/
  main.ts                 entry, wires modules together
  config.ts               defaults / constants
  assets.ts               asset() path helper (import.meta.env.BASE_URL)
  camera/                 getUserMedia + device handling
  tracking/               MediaPipe landmarker + selfie segmenter wrappers
  avatar/                 aniface wrapper: load model, matrix stabilization, expressions
  compose/                composite + output crop/mask rendering
  export/                 recorder + screenshot + save
  ui/                     DOM/view layer (controls, sliders, layout)
  lib/tauri.ts            typed invoke() wrappers
public/
  mediapipe/              vendored MediaPipe WASM + models (gitignored; regenerated)
  models/                 bundled GLB models (e.g. redpanda_head.glb)
scripts/
  vendor-mediapipe.mjs    copies WASM + downloads model files into public/mediapipe/
src-tauri/
  src/lib.rs              tauri builder, plugins, #[tauri::command]s
  src/main.rs             desktop entry
  tauri.conf.json         app config (identifier com.anifaceup.app)
  capabilities/           ACL permissions
```

## 4. Commands

```bash
npm install
npm run dev                 # vite dev server only (browser iteration; camera works on localhost)
npm run build               # tsc type-check + vite build -> dist/
npm run tauri dev           # full desktop app (dev server + Rust)
npm run tauri build         # packaged installers
npm run vendor:mediapipe    # materialize public/mediapipe/ (WASM + .task/.tflite)
                            # re-run this if @mediapipe/tasks-vision is upgraded:
                            # the vendored WASM must match the installed JS API
```

- Rust build artifacts live in `src-tauri/target/` (gitignored).
- First `cargo` build is slow (compiles Tauri); later builds are incremental.

## 5. Non-negotiable technical constraints

These are hard-won facts. Do not "fix" them without evidence.

1. **Camera permission (Windows/WebView2)** — Tauri v2 does NOT auto-grant
   `getUserMedia`. `src-tauri/src/lib.rs` registers a first-class handler on the
   `tauri::Builder`:
   `.on_permission_request(|_webview, kind| match kind { PermissionKind::Camera => PermissionResponse::Allow, _ => PermissionResponse::Default })`
   using `tauri::webview::{PermissionKind, PermissionResponse}`. The framework
   (wry) answers the live WebView2 `PermissionRequested` event, origin-agnostic —
   no manual `SetPermissionState`, and **no** `webview2-com`/`windows` direct
   deps. The resolved stack is tauri 2.12.3 (wry 0.57 / webview2-com 0.39); do
   not add a `webview2-com = "0.38"` pin. Windows also has an OS-level camera
   privacy toggle (Settings → Privacy → Camera) that must be on. A persistently
   denied WebView2 profile preference bypasses the handler — reset via
   `%LOCALAPPDATA%\com.anifaceup.app\EBWebView` if the camera stays blocked.
2. **aniface head-only quirk** — for head-only models `applyMatrix` uses
   `scale = 40`. The renderer zeroes the model root matrix translation
   (`matrix.elements[12..14] = 0`) and cancels the inner scale so the UI
   `Scale = 1` is natural size. Preserve this.
3. **Mirror rule** — when a view is mirrored, face-box `cx = 1 - cx`, and
   `pasteMirror = !viewMirror` (aniface already mirrors Y/Z internally).
   Getting this wrong double-mirrors the avatar.
4. **Draw ordering** — `drawComposite()` → `drawOutput()` →
   `drawSelectionOverlay()`. The avatar canvas is transparent and read in the
   same JS task (no `preserveDrawingBuffer` needed).
5. **Blendshape names** — custom GLBs must use ARKit/MediaPipe names
   (`eyeBlinkLeft`, `jawOpen`, `mouthSmileLeft`, `browInnerUp`, ...). There is
   no remapping by default.
6. **Binary IPC** — to save bytes, pass `Array.from(uint8)` as a named arg to a
   `Vec<u8>` command; a nested `Uint8Array` is NOT auto-converted. To read
   bytes, return `tauri::ipc::Response::new(bytes)` and receive an
   `ArrayBuffer`.
7. **Asset paths** — keep Vite `base: '/'`. Bundled `public/` assets resolve
   root-absolute (`/mediapipe/...`, `/models/...`) in dev and in the packaged
   app. Only user-picked external files need the `asset:` protocol.
8. **CSP** — `app.security.csp` is `null` by default. If ever set, WASM needs
   `'wasm-unsafe-eval'` in an explicit `script-src` (not `default-src`), plus
   `worker-src 'self' blob:`.

## 6. UI / design rules

The UI must look like a considered desktop tool, not a generic AI page.

- Prefer the repo skills `.opencode/skills/minimalist-ui` and
  `.opencode/skills/high-end-visual-design` for visual direction; use
  `.opencode/skills/redesign-existing-projects` for UI audits.
- No emojis in UI copy. No "Elevate/Seamless/Unleash" style copywriting.
  Plain, specific wording.
- No default heavy drop shadows, no gradient hero blocks, no neon.
- Motion is subtle and must respect `prefers-reduced-motion`.
- Once `@designer` has set a direction, `@fixer` may only make mechanical
  changes that preserve layout, spacing, hierarchy, motion, and component feel.

## 7. Conventions

- TypeScript strict; keep modules small and single-purpose. No framework.
- Prefer `read`/`edit` tools for source; use shell for build/test/git.
- Do not commit `public/mediapipe/` or `src-tauri/target/`.
- Commit style: `type(scope): summary` (e.g. `feat(engine): add segmenter`).

## 8. Session state

Deepwork progress lives in `.slim/deepwork/anifaceup-desktop.md` (git-local).
Keep it updated with phase status, accepted research, and validation results.
