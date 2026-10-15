# AniFaceUp

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)
![Tauri v2](https://img.shields.io/badge/Tauri-v2-24C8DB)

A desktop app that turns a live webcam feed into a cartoonized view: it tracks your
face, drives a 3D cartoon avatar (ARKit blendshapes) in real time, composites it over
the camera, optionally blurs the background, and crops/masks a configurable output
region that you can record or export.

Built with **Tauri v2** (Rust + WebView2) and a vanilla **TypeScript** frontend. All
ML/3D work runs in the webview (WASM + WebGL); Rust is a thin native layer for the
camera permission, native file dialogs, the system tray, and a picture-in-picture
output window.

> Platform: Windows (WebView2).

## Features

- Real-time face tracking with **MediaPipe FaceLandmarker** (468 landmarks, ARKit
  blendshapes, and head pose).
- A 3D cartoon head driven by [`aniface`](https://www.npmjs.com/package/aniface) — a
  bundled red-panda model, or import your own ARKit GLB.
- Composite the avatar onto the camera aligned to the face box, with optional
  **background blur** (selfie segmentation).
- Configurable **output crop** with scale, rounded/circle mask, corner radius, and
  feathering.
- **Record** the output to `.webm` and save **PNG screenshots**.
- **Picture-in-picture output window**: a borderless, always-on-top window at the
  bottom-right of the screen that shows the output crop while the main window is
  minimized; double-click it to restore the main window.
- **System tray** with minimize-to-tray (toggleable) and a Show/Quit menu.
- Native camera permission (no browser prompt) and native import/save dialogs.
- Everything is local — no CDN at runtime.

## How it works

```
webcam <video> ──► MediaPipe FaceLandmarker ──► aniface AvatarRenderer (three.js, transparent canvas)
                        │                              │
                        └─► ImageSegmenter (selfie) ───┤
                                                       ▼
                                 composite canvas (camera + avatar + background blur)
                                                       ▼
                                 output canvas (crop × scale × mask / feather)
                                                       ▼
                                 record (.webm) · screenshot (PNG)
```

## Requirements

- Windows 10/11 with the Microsoft Edge **WebView2 Runtime** (preinstalled on most
  systems).
- **Node.js** 20+ (developed on 22).
- **Rust** stable with the MSVC toolchain, plus the Visual Studio C++ build tools.

## Getting started

```bash
npm install
npm run vendor:mediapipe   # materialize public/mediapipe/ (WASM + .task/.tflite)
npm run tauri dev          # run the desktop app
```

Packaged build:

```bash
npm run tauri build
```

Installers are written to `src-tauri/target/release/bundle/`.

## Scripts

| Command | Description |
| --- | --- |
| `npm run dev` | Vite dev server only (browser iteration; camera works on `localhost`). |
| `npm run build` | Type-check (`tsc`) and build the frontend to `dist/`. |
| `npm run tauri dev` | Run the full desktop app (dev server + Rust). |
| `npm run tauri build` | Produce installers (MSI / NSIS). |
| `npm run vendor:mediapipe` | Copy the MediaPipe WASM and download the face/selfie models into `public/mediapipe/`. Re-run this after upgrading `@mediapipe/tasks-vision` so the WASM matches the JS API. |

## Assets

- `public/mediapipe/` (WASM runtime, face landmarker, selfie segmenter) is
  **git-ignored**; run `npm run vendor:mediapipe` to (re)create it.
- `public/models/redpanda_head.glb` is the bundled avatar.

## Custom models

Use the toolbar's **Import model** action to load a `.glb`. The model must:

- be a **head-only** avatar (no full-body rig), and
- use **ARKit / MediaPipe blendshape names** — e.g. `eyeBlinkLeft`, `jawOpen`,
  `mouthSmileLeft`, `browInnerUp`, `eyeLookInLeft`, …

There is no name remapping.

## Notes & troubleshooting

- **Camera permission** is granted natively through the WebView2 permission API, so
  the app never shows a browser prompt. If the camera stays blocked, make sure
  *Windows → Settings → Privacy & security → Camera* is on, and if needed delete
  `%LOCALAPPDATA%\com.anifaceup.app\EBWebView` to reset the stored WebView2
  preference.
- **Port 1420** is used by the Vite dev server; `tauri dev` fails if it is already
  in use.
- The picture-in-picture window streams frames as **PNG** so that masked
  (transparent) corners stay transparent instead of turning black.
- The **minimize-to-tray** toggle (Capture panel) controls whether minimizing hides
  the window to the tray or performs a normal minimize.

## Tech stack

- **Tauri v2** (Rust) — native shell, camera permission, file dialogs, tray,
  picture-in-picture window, and the cross-window frame relay.
- **MediaPipe Tasks (Vision)** — face landmarks/blendshapes and selfie segmentation,
  running locally via WASM.
- **[aniface](https://www.npmjs.com/package/aniface)** + **three.js** — ARKit
  blendshape avatar driving and rendering.
- **Vite + TypeScript** — frontend build.

## Project structure

```
src/
  main.ts        entry: wiring and the render loop
  config.ts      model / asset paths and defaults
  camera/        getUserMedia handling
  tracking/      MediaPipe landmarker + selfie segmenter
  avatar/        aniface wrapper (model load, matrix stabilization)
  compose/       composite + output crop/mask
  export/        recorder + screenshot
  ui/            control panel
  pip/           picture-in-picture output window
public/
  mediapipe/     vendored WASM + models (git-ignored; run vendor:mediapipe)
  models/        bundled GLB avatar
scripts/         vendor-mediapipe.mjs
src-tauri/       Rust backend (permissions, dialogs, tray, PiP, frame relay)
```

## Credits

- [aniface](https://www.npmjs.com/package/aniface) — ARKit-blendshape avatar engine.
- [MediaPipe](https://developers.google.com/mediapipe) (Google) — face landmarker and
  selfie segmenter.
- [three.js](https://threejs.org/) — WebGL rendering.
- The UI skills under `.opencode/skills/` are vendored from
  [Leonxlnx/taste-skill](https://github.com/Leonxlnx/taste-skill) (MIT).

## License

MIT — see [LICENSE](LICENSE).
