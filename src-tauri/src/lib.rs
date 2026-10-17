use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{PermissionKind, PermissionResponse};
use tauri::{Emitter, Manager, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;

/// Holds the single subscriber channel used to stream output frames from the
/// main window to the picture-in-picture window.
#[derive(Default)]
struct FrameHub(Mutex<Option<Channel<InvokeResponseBody>>>);

/// Latest face-presence signal from the main loop, mirrored to the PiP window.
#[derive(Default)]
struct FaceState(AtomicBool);

/// User-configurable UI/runtime state shared with the window-event handler.
struct UiState {
    /// When true, minimizing the main window hides it to the tray.
    minimize_to_tray: AtomicBool,
    /// Edge-detect for minimize transitions (guards duplicate signals).
    was_minimized: AtomicBool,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            // Preserve the previous always-minimize-to-tray behavior by default.
            minimize_to_tray: AtomicBool::new(true),
            was_minimized: AtomicBool::new(false),
        }
    }
}

/// Enable or disable minimize-to-tray from the frontend.
#[tauri::command]
fn set_minimize_to_tray(enabled: bool, state: tauri::State<'_, UiState>) {
    state.minimize_to_tray.store(enabled, Ordering::SeqCst);
}

/// Record whether a face is currently detected and notify the PiP window.
#[tauri::command]
fn set_face_present(app: tauri::AppHandle, present: bool, state: tauri::State<'_, FaceState>) {
    state.0.store(present, Ordering::SeqCst);
    let _ = app.emit_to("pip", "pip://face", present);
}

/// Read the last face-presence signal (polled by the PiP window at startup).
#[tauri::command]
fn get_face_present(state: tauri::State<'_, FaceState>) -> bool {
    state.0.load(Ordering::SeqCst)
}

/// Registers (or replaces) the pip window's frame channel. Called by the pip
/// frontend once its webview is ready.
#[tauri::command]
fn subscribe_frames(on_frame: Channel<InvokeResponseBody>, hub: State<'_, FrameHub>) {
    *hub.0.lock().unwrap() = Some(on_frame);
}

/// Drops the stored pip frame channel. Called when the pip window is destroyed
/// so later frames are not queued to a dead webview.
#[tauri::command]
fn clear_frames(hub: State<'_, FrameHub>) {
    *hub.0.lock().unwrap() = None;
}

/// Relays a raw JPEG frame (sent as a raw IPC body by the main window) to the
/// subscribed pip channel, if any. Dropped frames are ignored.
#[tauri::command]
fn push_frame(request: tauri::ipc::Request<'_>, hub: State<'_, FrameHub>) -> tauri::Result<()> {
    if let tauri::ipc::InvokeBody::Raw(bytes) = request.body() {
        // Clone the channel out of the mutex so `send` never runs while the
        // guard is held (a blocked `send` must not stall subscribe/clear).
        let channel = hub.0.lock().unwrap().clone();
        if let Some(ch) = channel {
            let _ = ch.send(InvokeResponseBody::Raw(bytes.clone()));
        }
    }
    Ok(())
}

/// Opens a native open-file dialog (filtered to glb) and returns the
/// chosen file's bytes. The frontend never supplies a path.
///
/// If the user cancels, an empty response is returned so JS receives a
/// 0-byte `ArrayBuffer`.
///
/// This is an `async` command so Tauri runs it off the main thread; that is
/// required because `blocking_pick_file` blocks the calling thread until the
/// dialog closes (it must not run on the main/event-loop thread).
#[tauri::command]
async fn import_model(app: tauri::AppHandle) -> Result<tauri::ipc::Response, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("3D model", &["glb"])
        .blocking_pick_file();

    let Some(file_path) = picked else {
        return Ok(tauri::ipc::Response::new(Vec::new()));
    };

    let path = file_path.into_path().map_err(|e| e.to_string())?;
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(data))
}

/// Opens a native save-file dialog pre-filled with `default_name` and writes
/// `data` to the chosen location. Returns `false` if the user cancels.
///
/// `async` for the same reason as [`import_model`]: `blocking_save_file` must
/// not run on the main thread.
#[tauri::command]
async fn export_output(
    app: tauri::AppHandle,
    data: Vec<u8>,
    default_name: String,
) -> Result<bool, String> {
    let picked = app
        .dialog()
        .file()
        .set_file_name(default_name)
        .blocking_save_file();

    let Some(file_path) = picked else {
        return Ok(false);
    };

    let path = file_path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Un-hides/un-minimizes the main window, focuses it, and notifies the frontend.
/// Any open pip window is hidden, since the main window now owns the view.
fn restore_main_window(app: &tauri::AppHandle) {
    // Reset the minimize edge-detector so the next minimize re-signals cleanly.
    app.state::<UiState>().was_minimized.store(false, Ordering::SeqCst);
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.show();
        let _ = main.set_focus();
        let _ = main.emit("tray://restored", ());
    }
    if let Some(pip) = app.get_webview_window("pip") {
        let _ = pip.hide();
    }
}

/// Frontend-facing command to restore the main window from the tray.
#[tauri::command]
fn restore_main(app: tauri::AppHandle) {
    restore_main_window(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(FrameHub::default())
        .manage(UiState::default())
        .manage(FaceState::default())
        .on_permission_request(|_webview, kind| match kind {
            PermissionKind::Camera => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .on_window_event(|window, event| {
            // Only the main window participates in tray/minimize behavior and
            // owns the borderless pip window.
            if window.label() == "main" {
                match event {
                    // When the main window is asked to close, also close the
                    // borderless pip window so the app can exit cleanly.
                    WindowEvent::CloseRequested { .. } => {
                        // Close the hidden PiP window AND force a clean exit with
                        // code 0. Closing only the PiP can leave the (hidden)
                        // window alive long enough that the app does not exit;
                        // `tauri dev` then Ctrl+C's the still-running debug child
                        // (STATUS_CONTROL_C_EXIT / 0xC000013A). Exit off the
                        // event-loop thread to avoid re-entrancy.
                        let app = window.app_handle().clone();
                        std::thread::spawn(move || {
                            if let Some(pip) = app.get_webview_window("pip") {
                                let _ = pip.close();
                            }
                            app.exit(0);
                        });
                    }
                    // Minimize-to-tray: always signal the minimize transition so
                    // the PiP/loop can keep running, but only hide the window
                    // when the user enabled minimize-to-tray.
                    WindowEvent::Resized(_) => {
                        let state = window.state::<UiState>();
                        let is_min = window.is_minimized().unwrap_or(false);
                        if is_min && !state.was_minimized.swap(true, Ordering::SeqCst) {
                            if state.minimize_to_tray.load(Ordering::SeqCst) {
                                let _ = window.hide();
                            }
                            let _ = window.emit("tray://minimized", ());
                        } else if !is_min && state.was_minimized.swap(false, Ordering::SeqCst) {
                            let _ = window.emit("tray://restored", ());
                        }
                    }
                    _ => {}
                }
            }
        })
        .setup(|app| {
            let show_item = MenuItem::with_id(app, "show", "Show AniFaceUp", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            // Defensive: a missing app icon should not abort startup. Skip the
            // tray (and log) rather than propagating an error.
            let Some(icon) = app.default_window_icon().cloned() else {
                eprintln!("[tray] default window icon missing; skipping tray icon");
                return Ok(());
            };
            // The tray is cloned into the app's resource table by `build`, so it
            // stays alive for the app lifetime even after this binding drops.
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(icon)
                .tooltip("AniFaceUp")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => restore_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } => {
                        restore_main_window(tray.app_handle());
                    }
                    _ => {}
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_model,
            export_output,
            subscribe_frames,
            push_frame,
            clear_frames,
            restore_main,
            set_minimize_to_tray,
            set_face_present,
            get_face_present
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
