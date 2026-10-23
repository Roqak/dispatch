mod http;
mod postman;
mod secrets;

use serde_json::Value;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_dialog::DialogExt;

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn safe_name(name: &str) -> Result<&str, String> {
    if !name.is_empty() && name.len() <= 80 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(name)
    } else {
        Err("Invalid store name".into())
    }
}

// ---------- HTTP ----------

#[tauri::command]
async fn send_request(
    state: State<'_, http::HttpState>,
    request: http::OutgoingRequest,
) -> Result<http::IncomingResponse, String> {
    http::send(&state, request).await
}

#[tauri::command]
fn clear_cookies(state: State<'_, http::HttpState>) {
    state.clear_cookies();
}

// ---------- Postman ----------

#[tauri::command]
async fn postman_api(
    app: AppHandle,
    profile_id: String,
    method: String,
    path: String,
    body: Option<Value>,
    region: Option<String>,
) -> Result<Value, String> {
    let profile_id = safe_name(&profile_id)?;
    let key = secrets::get(&data_dir(&app)?, profile_id)?.ok_or_else(|| {
        "This profile has no Postman API key. Add it under Settings → Profiles.".to_string()
    })?;
    postman::call(&key, region.as_deref().unwrap_or("us"), &method, &path, body).await
}

#[tauri::command]
async fn set_api_key(app: AppHandle, profile_id: String, key: String, region: Option<String>) -> Result<Value, String> {
    let profile_id = safe_name(&profile_id)?.to_string();
    let key = key.trim().to_string();
    // Verify before saving so a typo doesn't get stored.
    let me = postman::call(&key, region.as_deref().unwrap_or("us"), "GET", "/me", None).await?;
    secrets::set(&data_dir(&app)?, &profile_id, &key)?;
    Ok(me)
}

#[tauri::command]
fn has_api_key(app: AppHandle, profile_id: String) -> Result<bool, String> {
    Ok(secrets::get(&data_dir(&app)?, safe_name(&profile_id)?)?.is_some())
}

#[tauri::command]
fn delete_api_key(app: AppHandle, profile_id: String) -> Result<(), String> {
    secrets::delete(&data_dir(&app)?, safe_name(&profile_id)?)
}

#[tauri::command]
fn has_legacy_api_key(app: AppHandle) -> Result<bool, String> {
    Ok(secrets::legacy_has(&data_dir(&app)?))
}

/// Copies the pre-profiles single key into a named profile.
#[tauri::command]
fn migrate_legacy_key(app: AppHandle, profile_id: String) -> Result<bool, String> {
    secrets::legacy_copy_value(&data_dir(&app)?, safe_name(&profile_id)?)
}

// ---------- Local storage (cache, history, settings) ----------

#[tauri::command]
fn store_read(app: AppHandle, name: String) -> Result<Value, String> {
    let path = data_dir(&app)?.join(format!("{}.json", safe_name(&name)?));
    match std::fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| format!("{name} is corrupted: {e}")),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn store_write(app: AppHandle, name: String, value: Value) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let name = safe_name(&name)?;
    let tmp = dir.join(format!("{name}.json.tmp"));
    let path = dir.join(format!("{name}.json"));
    let text = serde_json::to_string(&value).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ---------- Files (import/export, form-data file picking) ----------

#[tauri::command]
async fn open_text_file(app: AppHandle) -> Result<Option<Value>, String> {
    let picked = app.dialog().file().add_filter("Postman JSON", &["json"]).blocking_pick_file();
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    let content = tokio::fs::read_to_string(&path).await.map_err(|e| e.to_string())?;
    Ok(Some(serde_json::json!({ "path": path.to_string_lossy(), "content": content })))
}

#[tauri::command]
async fn pick_file_path(app: AppHandle) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_file();
    match picked {
        Some(fp) => Ok(Some(fp.into_path().map_err(|e| e.to_string())?.to_string_lossy().to_string())),
        None => Ok(None),
    }
}

#[tauri::command]
async fn save_text_file(app: AppHandle, default_name: String, content: String) -> Result<Option<String>, String> {
    let picked = app.dialog().file().set_file_name(&default_name).add_filter("JSON", &["json"]).blocking_save_file();
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    tokio::fs::write(&path, content).await.map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[tauri::command]
async fn save_binary_file(app: AppHandle, default_name: String, base64_content: String) -> Result<Option<String>, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD.decode(base64_content).map_err(|e| e.to_string())?;
    let picked = app.dialog().file().set_file_name(&default_name).blocking_save_file();
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    tokio::fs::write(&path, bytes).await.map_err(|e| e.to_string())?;
    Ok(Some(path.to_string_lossy().to_string()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(http::HttpState::new())
        .invoke_handler(tauri::generate_handler![
            send_request,
            clear_cookies,
            postman_api,
            set_api_key,
            has_api_key,
            delete_api_key,
            has_legacy_api_key,
            migrate_legacy_key,
            store_read,
            store_write,
            open_text_file,
            pick_file_path,
            save_text_file,
            save_binary_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Dispatch");
}
