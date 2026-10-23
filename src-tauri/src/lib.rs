use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

const MAX_STORAGE_BYTES: usize = 100 * 1024 * 1024;
const MAX_BACKUPS: usize = 20;
const BACKUP_INTERVAL: Duration = Duration::from_secs(10 * 60);

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct StorePaths {
    data_dir: PathBuf,
    journal: PathBuf,
    previous: PathBuf,
    backups: PathBuf,
}

#[derive(Clone)]
struct AppState {
    paths: StorePaths,
    save_lock: Arc<Mutex<()>>,
    last_auto_backup: Arc<Mutex<Option<Instant>>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupInfo {
    name: String,
    size: u64,
    mtime: u64,
    reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DataInfo {
    data_dir: String,
    journal_path: String,
    backup_dir: String,
    version: String,
    is_desktop: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveDownloadResult {
    ok: bool,
    canceled: bool,
    path: Option<String>,
}

#[derive(Serialize)]
struct OkResult {
    ok: bool,
}

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn mtime_millis(metadata: &fs::Metadata) -> u64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn is_journal_data(value: &serde_json::Value) -> bool {
    value
        .as_object()
        .map(|object| {
            object
                .get("trades")
                .map_or(false, serde_json::Value::is_array)
                && object
                    .get("notes")
                    .map_or(false, serde_json::Value::is_array)
        })
        .unwrap_or(false)
}

fn validate_raw(raw: &str) -> Result<(), String> {
    if raw.len() > MAX_STORAGE_BYTES {
        return Err("Файл журнала слишком большой (более 100 МБ).".to_string());
    }
    let parsed: serde_json::Value = serde_json::from_str(raw)
        .map_err(|_| "Данные журнала не являются корректным JSON.".to_string())?;
    if !is_journal_data(&parsed) {
        return Err("Неожиданная структура журнала.".to_string());
    }
    Ok(())
}

fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)?;
    }

    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_path = path.with_file_name(format!(
        ".tj-{}-{}-{}.tmp",
        std::process::id(),
        now_millis(),
        counter
    ));

    let write_result = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        file.write_all(content)?;
        file.sync_all()?;
        Ok(())
    })();

    if let Err(error) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }

    match fs::rename(&temp_path, path) {
        Ok(()) => Ok(()),
        Err(error) => {
            if matches!(
                error.kind(),
                ErrorKind::PermissionDenied | ErrorKind::AlreadyExists
            ) {
                let copy_result = fs::copy(&temp_path, path);
                let _ = fs::remove_file(&temp_path);
                copy_result.map(|_| ())
            } else {
                let _ = fs::remove_file(&temp_path);
                Err(error)
            }
        }
    }
}

fn read_journal(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(raw) => Ok(Some(raw)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Не удалось прочитать файл журнала: {error}")),
    }
}

fn backup_reason(name: &str) -> String {
    for reason in ["before-restore", "removed", "manual", "smoke", "auto"] {
        if name.ends_with(&format!("-{reason}.json")) {
            return reason.to_string();
        }
    }
    "backup".to_string()
}

fn unique_backup_path(backup_dir: &Path, reason: &str) -> PathBuf {
    let safe_reason: String = reason
        .chars()
        .filter(|character| {
            character.is_ascii_alphanumeric() || *character == '-' || *character == '_'
        })
        .take(24)
        .collect();
    let reason = if safe_reason.is_empty() {
        "backup".to_string()
    } else {
        safe_reason
    };

    let mut index = 0u32;
    loop {
        let suffix = if index == 0 {
            String::new()
        } else {
            format!("-{index}")
        };
        let name = format!("journal-{}-{}{}.json", now_millis(), reason, suffix);
        let path = backup_dir.join(name);
        if !path.exists() {
            return path;
        }
        index = index.saturating_add(1);
    }
}

fn backup_info(path: &Path) -> Option<BackupInfo> {
    let metadata = fs::metadata(path).ok()?;
    Some(BackupInfo {
        name: path.file_name()?.to_string_lossy().to_string(),
        size: metadata.len(),
        mtime: mtime_millis(&metadata),
        reason: backup_reason(&path.file_name()?.to_string_lossy()),
    })
}

fn prune_backups(backup_dir: &Path) {
    let Ok(entries) = fs::read_dir(backup_dir) else {
        return;
    };

    let mut files: Vec<(PathBuf, u64)> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_string_lossy();
            if !name.starts_with("journal-") || !name.ends_with(".json") {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((path, mtime_millis(&metadata)))
        })
        .collect();

    files.sort_by(|left, right| right.1.cmp(&left.1));
    for (path, _) in files.into_iter().skip(MAX_BACKUPS) {
        let _ = fs::remove_file(path);
    }
}

fn make_backup(
    paths: &StorePaths,
    reason: &str,
    raw: &str,
    force: bool,
    last_auto_backup: &Mutex<Option<Instant>>,
) -> Result<Option<BackupInfo>, String> {
    if !force {
        let last = lock_or_recover(last_auto_backup);
        if let Some(previous) = *last {
            if previous.elapsed() < BACKUP_INTERVAL {
                return Ok(None);
            }
        }
    }

    fs::create_dir_all(&paths.backups)
        .map_err(|error| format!("Не удалось создать папку резервных копий: {error}"))?;
    let target = unique_backup_path(&paths.backups, reason);
    fs::write(&target, raw.as_bytes())
        .map_err(|error| format!("Не удалось создать резервную копию: {error}"))?;

    *lock_or_recover(last_auto_backup) = Some(Instant::now());
    prune_backups(&paths.backups);

    Ok(backup_info(&target))
}

fn save_journal(state: &AppState, raw: String) -> Result<usize, String> {
    validate_raw(&raw)?;
    let _guard = lock_or_recover(&state.save_lock);

    fs::create_dir_all(&state.paths.data_dir)
        .map_err(|error| format!("Не удалось создать папку данных: {error}"))?;

    if let Ok(old_raw) = fs::read_to_string(&state.paths.journal) {
        let _ = fs::copy(&state.paths.journal, &state.paths.previous);
        if let Err(error) = make_backup(
            &state.paths,
            "auto",
            &old_raw,
            false,
            &state.last_auto_backup,
        ) {
            eprintln!("TradeJournal: не удалось создать автоматическую копию: {error}");
        }
    }

    let size = raw.len();
    write_atomic(&state.paths.journal, raw.as_bytes())
        .map_err(|error| format!("Не удалось записать файл журнала: {error}"))?;
    Ok(size)
}

fn create_manual_backup(state: &AppState) -> Result<BackupInfo, String> {
    let _guard = lock_or_recover(&state.save_lock);
    let raw = read_journal(&state.paths.journal)?
        .ok_or_else(|| "Файл журнала ещё не создан.".to_string())?;
    make_backup(&state.paths, "manual", &raw, true, &state.last_auto_backup)?
        .ok_or_else(|| "Не удалось создать резервную копию.".to_string())
}

fn list_backups(state: &AppState) -> Result<Vec<BackupInfo>, String> {
    fs::create_dir_all(&state.paths.backups)
        .map_err(|error| format!("Не удалось создать папку резервных копий: {error}"))?;
    let entries = fs::read_dir(&state.paths.backups)
        .map_err(|error| format!("Не удалось прочитать список копий: {error}"))?;

    let mut backups: Vec<BackupInfo> = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("journal-") || !name.ends_with(".json") {
                return None;
            }
            backup_info(&entry.path())
        })
        .collect();

    backups.sort_by(|left, right| right.mtime.cmp(&left.mtime));
    backups.truncate(50);
    Ok(backups)
}

fn valid_backup_name(name: &str) -> bool {
    !name.is_empty()
        && name.starts_with("journal-")
        && name.ends_with(".json")
        && !name.contains("..")
        && !name
            .chars()
            .any(|character| character == '/' || character == '\\' || character == '\0')
        && Path::new(name)
            .file_name()
            .and_then(|file_name| file_name.to_str())
            == Some(name)
}

fn restore_backup(state: &AppState, name: &str) -> Result<String, String> {
    if !valid_backup_name(name) {
        return Err("Некорректное имя резервной копии.".to_string());
    }

    let _guard = lock_or_recover(&state.save_lock);
    let source = state.paths.backups.join(name);
    let raw = fs::read_to_string(&source)
        .map_err(|_| "Резервная копия не найдена или повреждена.".to_string())?;
    validate_raw(&raw)?;

    fs::create_dir_all(&state.paths.data_dir)
        .map_err(|error| format!("Не удалось создать папку данных: {error}"))?;

    if let Ok(current) = fs::read_to_string(&state.paths.journal) {
        let _ = fs::copy(&state.paths.journal, &state.paths.previous);
        let _ = make_backup(
            &state.paths,
            "before-restore",
            &current,
            true,
            &state.last_auto_backup,
        );
    }

    write_atomic(&state.paths.journal, raw.as_bytes())
        .map_err(|error| format!("Не удалось восстановить копию: {error}"))?;
    Ok(raw)
}

fn clear_journal(state: &AppState) -> Result<(), String> {
    let _guard = lock_or_recover(&state.save_lock);
    if !state.paths.journal.exists() {
        return Ok(());
    }

    fs::create_dir_all(&state.paths.backups)
        .map_err(|error| format!("Не удалось создать папку резервных копий: {error}"))?;
    let target = unique_backup_path(&state.paths.backups, "removed");

    match fs::rename(&state.paths.journal, &target) {
        Ok(()) => {}
        Err(_) => {
            fs::copy(&state.paths.journal, &target)
                .map_err(|error| format!("Не удалось сохранить копию перед удалением: {error}"))?;
            fs::remove_file(&state.paths.journal)
                .map_err(|error| format!("Не удалось удалить файл журнала: {error}"))?;
        }
    }

    prune_backups(&state.paths.backups);
    Ok(())
}

fn resolve_paths(app: &tauri::AppHandle) -> Result<StorePaths, Box<dyn std::error::Error>> {
    let app_data_root = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| {
            app.path()
                .app_data_dir()
                .ok()
                .and_then(|path| path.parent().map(Path::to_path_buf))
        })
        .ok_or_else(|| "Не удалось определить папку данных Windows.".to_string())?;

    let data_dir = app_data_root.join("TradeJournal");
    Ok(StorePaths {
        journal: data_dir.join("journal.json"),
        previous: data_dir.join("journal.previous.json"),
        backups: data_dir.join("backups"),
        data_dir,
    })
}

#[tauri::command]
fn storage_has(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.paths.journal.exists())
}

#[tauri::command]
async fn storage_load(state: State<'_, AppState>) -> Result<Option<String>, String> {
    let path = state.paths.journal.clone();
    tauri::async_runtime::spawn_blocking(move || read_journal(&path))
        .await
        .map_err(|error| format!("Не удалось выполнить чтение: {error}"))?
}

#[tauri::command]
async fn storage_save(state: State<'_, AppState>, raw: String) -> Result<usize, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || save_journal(&state, raw))
        .await
        .map_err(|error| format!("Не удалось выполнить сохранение: {error}"))?
}

#[tauri::command]
async fn storage_backup(state: State<'_, AppState>) -> Result<BackupInfo, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || create_manual_backup(&state))
        .await
        .map_err(|error| format!("Не удалось выполнить резервное копирование: {error}"))?
}

#[tauri::command]
async fn storage_list_backups(state: State<'_, AppState>) -> Result<Vec<BackupInfo>, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || list_backups(&state))
        .await
        .map_err(|error| format!("Не удалось прочитать список копий: {error}"))?
}

#[tauri::command]
async fn storage_restore(state: State<'_, AppState>, name: String) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || restore_backup(&state, &name))
        .await
        .map_err(|error| format!("Не удалось выполнить восстановление: {error}"))?
}

#[tauri::command]
async fn storage_clear(state: State<'_, AppState>) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || clear_journal(&state))
        .await
        .map_err(|error| format!("Не удалось выполнить очистку: {error}"))?
}

#[tauri::command]
fn data_info(app: tauri::AppHandle, state: State<'_, AppState>) -> DataInfo {
    DataInfo {
        data_dir: state.paths.data_dir.to_string_lossy().to_string(),
        journal_path: state.paths.journal.to_string_lossy().to_string(),
        backup_dir: state.paths.backups.to_string_lossy().to_string(),
        version: app.package_info().version.to_string(),
        is_desktop: true,
    }
}

#[tauri::command]
fn open_data_folder(state: State<'_, AppState>) -> Result<OkResult, String> {
    fs::create_dir_all(&state.paths.data_dir)
        .map_err(|error| format!("Не удалось создать папку данных: {error}"))?;

    #[cfg(target_os = "windows")]
    let result = Command::new("explorer.exe")
        .arg(&state.paths.data_dir)
        .spawn();

    #[cfg(target_os = "macos")]
    let result = Command::new("open").arg(&state.paths.data_dir).spawn();

    #[cfg(all(unix, not(target_os = "macos")))]
    let result = Command::new("xdg-open").arg(&state.paths.data_dir).spawn();

    result
        .map(|_| OkResult { ok: true })
        .map_err(|error| format!("Не удалось открыть папку данных: {error}"))
}

#[tauri::command]
fn save_download(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<SaveDownloadResult, String> {
    let file_name = Path::new(&filename)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("tradejournal-download");
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let mut dialog = rfd::FileDialog::new().set_file_name(file_name);
    if let Ok(download_dir) = app.path().download_dir() {
        dialog = dialog.set_directory(download_dir);
    }
    if extension == "json" {
        dialog = dialog.add_filter("JSON", &["json"]);
    } else if extension == "csv" {
        dialog = dialog.add_filter("CSV", &["csv"]);
    }

    let Some(path) = dialog.save_file() else {
        return Ok(SaveDownloadResult {
            ok: true,
            canceled: true,
            path: None,
        });
    };

    fs::write(&path, content.as_bytes())
        .map_err(|error| format!("Не удалось сохранить файл: {error}"))?;

    Ok(SaveDownloadResult {
        ok: true,
        canceled: false,
        path: Some(path.to_string_lossy().to_string()),
    })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            let paths = resolve_paths(app.handle())?;
            fs::create_dir_all(&paths.data_dir)?;
            fs::create_dir_all(&paths.backups)?;
            app.manage(AppState {
                paths,
                save_lock: Arc::new(Mutex::new(())),
                last_auto_backup: Arc::new(Mutex::new(None)),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            storage_has,
            storage_load,
            storage_save,
            storage_backup,
            storage_list_backups,
            storage_restore,
            storage_clear,
            data_info,
            open_data_folder,
            save_download
        ])
        .run(tauri::generate_context!())
        .expect("error while running TradeJournal");
}
