use tauri::webview::{PermissionKind, PermissionResponse};
use tauri_plugin_dialog::DialogExt;

/// Opens a native open-file dialog (filtered to glb/gltf) and returns the
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
        .add_filter("3D model", &["glb", "gltf"])
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_permission_request(|_webview, kind| match kind {
            PermissionKind::Camera => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .invoke_handler(tauri::generate_handler![import_model, export_output])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
