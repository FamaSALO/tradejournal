use base64::Engine as _;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs::{self, OpenOptions};
use std::io::{BufWriter, ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{Manager, State};

const MAX_STORAGE_BYTES: usize = 100 * 1024 * 1024;
const MAX_SCREENSHOT_BYTES: usize = 6 * 1024 * 1024;
const MAX_BACKUPS: usize = 20;
const BACKUP_INTERVAL: Duration = Duration::from_secs(10 * 60);
// A screenshot is written just before the journal that references it. Keep a
// grace period so a scan cannot offer a brand-new file for deletion while the
// journal save is still in flight.
const UNUSED_SCREENSHOT_GRACE_MS: u64 = 10 * 60 * 1000;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Clone)]
struct StorePaths {
    data_dir: PathBuf,
    journal: PathBuf,
    previous: PathBuf,
    backups: PathBuf,
    screenshots: PathBuf,
}

struct StagedDownload {
    target_path: PathBuf,
    temp_path: PathBuf,
    writer: Option<BufWriter<fs::File>>,
}

#[derive(Clone)]
struct AppState {
    paths: StorePaths,
    save_lock: Arc<Mutex<()>>,
    last_auto_backup: Arc<Mutex<Option<Instant>>>,
    staged_downloads: Arc<Mutex<HashMap<String, StagedDownload>>>,
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
    screenshot_dir: String,
    version: String,
    is_desktop: bool,
    platform: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UnusedScreenshot {
    name: String,
    size: u64,
    mtime: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StorageHealth {
    journal_size: u64,
    previous_size: u64,
    screenshots_size: u64,
    backups_size: u64,
    screenshots_count: usize,
    backups_count: usize,
    referenced_count: usize,
    missing_count: usize,
    unused_count: usize,
    unused_size: u64,
    unused: Vec<UnusedScreenshot>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CleanupResult {
    deleted: Vec<String>,
    deleted_count: usize,
    deleted_size: u64,
    skipped_referenced: usize,
    skipped_recent: usize,
    failed: Vec<String>,
    remaining_unused: usize,
    remaining_unused_size: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ScreenshotSaved {
    reference: String,
    size: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveDownloadResult {
    ok: bool,
    canceled: bool,
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadBeginResult {
    ok: bool,
    canceled: bool,
    token: Option<String>,
    path: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UpdateInfo {
    available: bool,
    current_version: String,
    version: Option<String>,
    notes: Option<String>,
    date: Option<String>,
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
            let legacy = object
                .get("trades")
                .is_some_and(serde_json::Value::is_array)
                && object.get("notes").is_some_and(serde_json::Value::is_array);
            let accounts = object
                .get("accounts")
                .is_some_and(serde_json::Value::is_array);
            legacy || accounts
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

fn unique_temp_path(path: &Path) -> PathBuf {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    path.with_file_name(format!(
        ".tj-{}-{}-{}.tmp",
        std::process::id(),
        now_millis(),
        counter
    ))
}

fn write_atomic(path: &Path, content: &[u8]) -> std::io::Result<()> {
    if let Some(directory) = path.parent() {
        fs::create_dir_all(directory)?;
    }

    let temp_path = unique_temp_path(path);

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
            // Never fall back to copying over the live file: a failed copy can
            // leave a half-written journal. The old file is still intact.
            let _ = fs::remove_file(&temp_path);
            Err(error)
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
    if !metadata.is_file() {
        return None;
    }
    let file_name = path.file_name()?.to_string_lossy().to_string();
    Some(BackupInfo {
        reason: backup_reason(&file_name),
        name: file_name,
        size: metadata.len(),
        mtime: mtime_millis(&metadata),
    })
}

fn sort_newest_first<T, F>(items: &mut [T], mtime: F)
where
    F: Fn(&T) -> u64,
{
    items.sort_by_key(|item| std::cmp::Reverse(mtime(item)));
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
            if !metadata.is_file() {
                return None;
            }
            Some((path, mtime_millis(&metadata)))
        })
        .collect();

    sort_newest_first(&mut files, |file| file.1);
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
    write_atomic(&target, raw.as_bytes())
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
        if validate_raw(&old_raw).is_ok() {
            if let Err(error) = write_atomic(&state.paths.previous, old_raw.as_bytes()) {
                eprintln!("TradeJournal: не удалось обновить предыдущую версию: {error}");
            }
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
    validate_raw(&raw)?;
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

    sort_newest_first(&mut backups, |backup| backup.mtime);
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
        // On the recovery screen the current journal is usually corrupt. Do not
        // copy it into journal.previous.json or the backup list: that would make
        // the "previous version" button and the backup list point at bad data.
        if validate_raw(&current).is_ok() {
            if let Err(error) = write_atomic(&state.paths.previous, current.as_bytes()) {
                eprintln!("TradeJournal: не удалось обновить предыдущую версию: {error}");
            }
            let _ = make_backup(
                &state.paths,
                "before-restore",
                &current,
                true,
                &state.last_auto_backup,
            );
        }
    }

    write_atomic(&state.paths.journal, raw.as_bytes())
        .map_err(|error| format!("Не удалось восстановить копию: {error}"))?;
    Ok(raw)
}

fn restore_previous(state: &AppState) -> Result<String, String> {
    let _guard = lock_or_recover(&state.save_lock);
    let raw = fs::read_to_string(&state.paths.previous)
        .map_err(|_| "Предыдущая версия журнала не найдена.".to_string())?;
    validate_raw(&raw)?;

    fs::create_dir_all(&state.paths.data_dir)
        .map_err(|error| format!("Не удалось создать папку данных: {error}"))?;

    if let Ok(current) = fs::read_to_string(&state.paths.journal) {
        if validate_raw(&current).is_ok() {
            let _ = make_backup(
                &state.paths,
                "before-restore",
                &current,
                true,
                &state.last_auto_backup,
            );
        }
    }

    write_atomic(&state.paths.journal, raw.as_bytes())
        .map_err(|error| format!("Не удалось восстановить предыдущую версию: {error}"))?;
    Ok(raw)
}

fn clear_journal(state: &AppState) -> Result<(), String> {
    let _guard = lock_or_recover(&state.save_lock);
    let raw = match fs::read_to_string(&state.paths.journal) {
        Ok(raw) => Some(raw),
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(_) => None,
    };
    let is_valid = raw
        .as_deref()
        .is_some_and(|text| validate_raw(text).is_ok());

    let target = if is_valid {
        fs::create_dir_all(&state.paths.backups)
            .map_err(|error| format!("Не удалось создать папку резервных копий: {error}"))?;
        unique_backup_path(&state.paths.backups, "removed")
    } else {
        // Keep unreadable or corrupt files out of backups/ so backup lists and
        // storage health scans do not fail or offer broken files for restore.
        let corrupt_dir = state.paths.data_dir.join("corrupt");
        fs::create_dir_all(&corrupt_dir)
            .map_err(|error| format!("Не удалось создать папку повреждённых файлов: {error}"))?;
        unique_backup_path(&corrupt_dir, "corrupt")
    };

    match fs::rename(&state.paths.journal, &target) {
        Ok(()) => {}
        Err(_) => {
            fs::copy(&state.paths.journal, &target)
                .map_err(|error| format!("Не удалось сохранить копию перед удалением: {error}"))?;
            fs::remove_file(&state.paths.journal)
                .map_err(|error| format!("Не удалось удалить файл журнала: {error}"))?;
        }
    }

    if is_valid {
        prune_backups(&state.paths.backups);
    }
    Ok(())
}

fn valid_screenshot_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
}

fn screenshot_file_name(reference: &str) -> Option<&str> {
    let name = reference
        .strip_prefix("file:screenshots/")
        .unwrap_or(reference);
    if name.is_empty() || name.contains("..") {
        return None;
    }
    let path = Path::new(name);
    if path.file_name().and_then(|value| value.to_str()) != Some(name) {
        return None;
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())?
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "jpg" | "jpeg" | "png" | "webp") {
        return None;
    }
    let stem = path.file_stem().and_then(|value| value.to_str())?;
    if !valid_screenshot_id(stem) {
        return None;
    }
    Some(name)
}

struct ScreenshotFile {
    name: String,
    size: u64,
    mtime: u64,
}

fn valid_screenshot_file_name(name: &str) -> bool {
    screenshot_file_name(name) == Some(name)
}

fn screenshot_reference_name(text: &str) -> Option<String> {
    // Data URLs are much longer than any valid screenshot file name. Rejecting
    // them early also keeps Path parsing away from base64 payloads.
    if text.len() > 128 {
        return None;
    }
    let candidate = text
        .strip_prefix("file:screenshots/")
        .or_else(|| text.strip_prefix("screenshots/"))
        .unwrap_or(text);
    if candidate.len() > 85 || !valid_screenshot_file_name(candidate) {
        return None;
    }
    Some(candidate.to_ascii_lowercase())
}

fn collect_screenshot_refs(value: &serde_json::Value, refs: &mut HashSet<String>) {
    match value {
        serde_json::Value::String(text) => {
            if let Some(name) = screenshot_reference_name(text) {
                refs.insert(name);
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                collect_screenshot_refs(item, refs);
            }
        }
        serde_json::Value::Object(map) => {
            for item in map.values() {
                collect_screenshot_refs(item, refs);
            }
        }
        _ => {}
    }
}

fn display_file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string())
}

struct ReferencedScan {
    refs: HashSet<String>,
    warnings: Vec<String>,
}

fn scan_referenced_screenshots(paths: &StorePaths) -> ReferencedScan {
    let mut sources = vec![paths.journal.clone(), paths.previous.clone()];
    let mut warnings = Vec::new();
    match fs::read_dir(&paths.backups) {
        Ok(entries) => {
            for entry in entries.filter_map(Result::ok) {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with("journal-")
                    && name.ends_with(".json")
                    && entry
                        .metadata()
                        .map(|metadata| metadata.is_file())
                        .unwrap_or(false)
                {
                    sources.push(entry.path());
                }
            }
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => {
            warnings.push(format!(
                "Не удалось прочитать папку резервных копий: {error}."
            ));
        }
    }

    let mut refs = HashSet::new();
    for source in sources {
        let raw = match fs::read_to_string(&source) {
            Ok(raw) => raw,
            Err(error) if error.kind() == ErrorKind::NotFound => continue,
            Err(error) => {
                warnings.push(format!(
                    "Не удалось прочитать {}: {error}.",
                    display_file_name(&source)
                ));
                continue;
            }
        };
        let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
            warnings.push(format!("Файл {} повреждён.", display_file_name(&source)));
            continue;
        };
        collect_screenshot_refs(&parsed, &mut refs);
    }
    ReferencedScan { refs, warnings }
}

fn gather_referenced_screenshots(paths: &StorePaths) -> Result<HashSet<String>, String> {
    let scan = scan_referenced_screenshots(paths);
    if let Some(first_warning) = scan.warnings.first() {
        return Err(format!(
            "{first_warning} Очистка отменена, чтобы не удалить нужные скриншоты."
        ));
    }
    Ok(scan.refs)
}

fn list_screenshot_files(dir: &Path) -> Result<Vec<ScreenshotFile>, String> {
    let entries = match fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => {
            return Err(format!("Не удалось прочитать папку скриншотов: {error}"));
        }
    };

    let mut files = Vec::new();
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        if !valid_screenshot_file_name(&name) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        files.push(ScreenshotFile {
            name,
            size: metadata.len(),
            mtime: mtime_millis(&metadata),
        });
    }
    files.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(files)
}

fn file_size(path: &Path) -> u64 {
    fs::metadata(path)
        .map(|metadata| metadata.len())
        .unwrap_or(0)
}

fn backups_stats(dir: &Path) -> (u64, usize) {
    let Ok(entries) = fs::read_dir(dir) else {
        return (0, 0);
    };
    let mut size = 0u64;
    let mut count = 0usize;
    for entry in entries.filter_map(Result::ok) {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("journal-") || !name.ends_with(".json") {
            continue;
        }
        if let Ok(metadata) = entry.metadata() {
            if metadata.is_file() {
                size += metadata.len();
                count += 1;
            }
        }
    }
    (size, count)
}

fn collect_storage_health(state: &AppState) -> Result<StorageHealth, String> {
    let _guard = lock_or_recover(&state.save_lock);
    let scan = scan_referenced_screenshots(&state.paths);
    let referenced = scan.refs;
    let warnings = scan.warnings;
    let files = list_screenshot_files(&state.paths.screenshots)?;

    let now = now_millis();
    let mut screenshots_size = 0u64;
    let mut unused_size = 0u64;
    let mut present = HashSet::new();
    let mut unused = Vec::new();
    for file in &files {
        screenshots_size += file.size;
        let key = file.name.to_ascii_lowercase();
        present.insert(key.clone());
        if warnings.is_empty()
            && !referenced.contains(&key)
            && now.saturating_sub(file.mtime) >= UNUSED_SCREENSHOT_GRACE_MS
        {
            unused_size += file.size;
            unused.push(UnusedScreenshot {
                name: file.name.clone(),
                size: file.size,
                mtime: file.mtime,
            });
        }
    }

    let missing_count = referenced
        .iter()
        .filter(|name| !present.contains(*name))
        .count();
    unused.sort_by(|left, right| {
        right
            .size
            .cmp(&left.size)
            .then_with(|| left.name.cmp(&right.name))
    });

    let (backups_size, backups_count) = backups_stats(&state.paths.backups);
    Ok(StorageHealth {
        journal_size: file_size(&state.paths.journal),
        previous_size: file_size(&state.paths.previous),
        screenshots_size,
        backups_size,
        screenshots_count: files.len(),
        backups_count,
        referenced_count: referenced.len(),
        missing_count,
        unused_count: unused.len(),
        unused_size,
        unused,
        warnings,
    })
}

fn cleanup_unused_screenshots(
    state: &AppState,
    names: Vec<String>,
) -> Result<CleanupResult, String> {
    let _guard = lock_or_recover(&state.save_lock);
    // Re-scan under the save lock: a journal save between the preview and the
    // click may have started referencing a file that was previously unused.
    let referenced = gather_referenced_screenshots(&state.paths)?;

    let now = now_millis();
    let mut deleted = Vec::new();
    let mut deleted_size = 0u64;
    let mut skipped_referenced = 0usize;
    let mut skipped_recent = 0usize;
    let mut failed = Vec::new();

    for name in names {
        if !valid_screenshot_file_name(&name) {
            failed.push(name);
            continue;
        }
        if referenced.contains(&name.to_ascii_lowercase()) {
            skipped_referenced += 1;
            continue;
        }
        let path = state.paths.screenshots.join(&name);
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        if now.saturating_sub(mtime_millis(&metadata)) < UNUSED_SCREENSHOT_GRACE_MS {
            skipped_recent += 1;
            continue;
        }
        match fs::remove_file(&path) {
            Ok(()) => {
                deleted_size += metadata.len();
                deleted.push(name);
            }
            Err(_) => failed.push(name),
        }
    }

    let remaining = list_screenshot_files(&state.paths.screenshots)?
        .into_iter()
        .filter(|file| {
            !referenced.contains(&file.name.to_ascii_lowercase())
                && now.saturating_sub(file.mtime) >= UNUSED_SCREENSHOT_GRACE_MS
        })
        .collect::<Vec<_>>();
    let remaining_unused_size = remaining.iter().map(|file| file.size).sum();

    Ok(CleanupResult {
        deleted_count: deleted.len(),
        deleted,
        deleted_size,
        skipped_referenced,
        skipped_recent,
        failed,
        remaining_unused: remaining.len(),
        remaining_unused_size,
    })
}

fn valid_image_magic(extension: &str, bytes: &[u8]) -> bool {
    match extension {
        "jpg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "png" => bytes.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        "webp" => bytes.len() >= 12 && bytes.starts_with(b"RIFF") && bytes[8..12] == b"WEBP"[..],
        _ => false,
    }
}

fn decode_screenshot_data_url(data_url: &str) -> Result<(String, Vec<u8>), String> {
    let (meta, payload) = data_url
        .split_once(',')
        .ok_or_else(|| "Некорректный формат изображения.".to_string())?;
    if !meta.starts_with("data:image/") || !meta.ends_with(";base64") {
        return Err("Поддерживаются только изображения JPEG, PNG и WebP.".to_string());
    }
    let mime = &meta[5..meta.len() - 7];
    let extension = match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        _ => return Err("Поддерживаются только изображения JPEG, PNG и WebP.".to_string()),
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| "Не удалось декодировать изображение.".to_string())?;
    if bytes.is_empty() {
        return Err("Изображение пустое.".to_string());
    }
    if bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err("Скриншот слишком большой (более 6 МБ).".to_string());
    }
    if !valid_image_magic(extension, &bytes) {
        return Err("Файл не похож на изображение JPEG, PNG или WebP.".to_string());
    }
    Ok((extension.to_string(), bytes))
}

fn save_screenshot(state: &AppState, id: &str, data_url: &str) -> Result<ScreenshotSaved, String> {
    if !valid_screenshot_id(id) {
        return Err("Некорректный идентификатор скриншота.".to_string());
    }
    let (extension, bytes) = decode_screenshot_data_url(data_url)?;
    fs::create_dir_all(&state.paths.screenshots)
        .map_err(|error| format!("Не удалось создать папку скриншотов: {error}"))?;
    let file_name = format!("{id}.{extension}");
    let path = state.paths.screenshots.join(&file_name);
    write_atomic(&path, &bytes)
        .map_err(|error| format!("Не удалось сохранить скриншот: {error}"))?;
    Ok(ScreenshotSaved {
        reference: format!("file:screenshots/{file_name}"),
        size: bytes.len(),
    })
}

fn load_screenshot(state: &AppState, reference: &str) -> Result<String, String> {
    let file_name = screenshot_file_name(reference)
        .ok_or_else(|| "Некорректная ссылка на скриншот.".to_string())?;
    let path = state.paths.screenshots.join(file_name);
    let bytes = fs::read(&path).map_err(|_| "Скриншот не найден.".to_string())?;
    if bytes.len() > MAX_SCREENSHOT_BYTES {
        return Err("Скриншот слишком большой.".to_string());
    }
    let extension = Path::new(file_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mime = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "webp" => "image/webp",
        _ => return Err("Неподдерживаемый формат скриншота.".to_string()),
    };
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

fn resolve_paths(app: &tauri::AppHandle) -> Result<StorePaths, Box<dyn std::error::Error>> {
    // %APPDATA%\TradeJournal on Windows, ~/Library/Application Support/TradeJournal
    // on macOS, and the XDG data directory on Linux. The app-specific folder is
    // resolved without the bundle identifier so existing Windows journals keep
    // their historical location.
    let data_dir = app
        .path()
        .data_dir()
        .map_err(|error| format!("Не удалось определить папку данных приложения: {error}"))?
        .join("TradeJournal");
    Ok(StorePaths {
        journal: data_dir.join("journal.json"),
        previous: data_dir.join("journal.previous.json"),
        backups: data_dir.join("backups"),
        screenshots: data_dir.join("screenshots"),
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
async fn storage_restore_previous(state: State<'_, AppState>) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || restore_previous(&state))
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
async fn storage_health(state: State<'_, AppState>) -> Result<StorageHealth, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || collect_storage_health(&state))
        .await
        .map_err(|error| format!("Не удалось проверить хранилище: {error}"))?
}

#[tauri::command]
async fn storage_cleanup_unused(
    state: State<'_, AppState>,
    names: Vec<String>,
) -> Result<CleanupResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || cleanup_unused_screenshots(&state, names))
        .await
        .map_err(|error| format!("Не удалось очистить скриншоты: {error}"))?
}

#[tauri::command]
async fn screenshot_save(
    state: State<'_, AppState>,
    id: String,
    data_url: String,
) -> Result<ScreenshotSaved, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || save_screenshot(&state, &id, &data_url))
        .await
        .map_err(|error| format!("Не удалось выполнить сохранение скриншота: {error}"))?
}

#[tauri::command]
async fn screenshot_load(state: State<'_, AppState>, reference: String) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || load_screenshot(&state, &reference))
        .await
        .map_err(|error| format!("Не удалось выполнить чтение скриншота: {error}"))?
}

#[tauri::command]
fn data_info(app: tauri::AppHandle, state: State<'_, AppState>) -> DataInfo {
    DataInfo {
        data_dir: state.paths.data_dir.to_string_lossy().to_string(),
        journal_path: state.paths.journal.to_string_lossy().to_string(),
        backup_dir: state.paths.backups.to_string_lossy().to_string(),
        screenshot_dir: state.paths.screenshots.to_string_lossy().to_string(),
        version: app.package_info().version.to_string(),
        is_desktop: true,
        platform: std::env::consts::OS.to_string(),
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

fn choose_download_path(app: &tauri::AppHandle, filename: &str) -> Option<PathBuf> {
    let file_name = Path::new(filename)
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
    } else if extension == "zip" {
        dialog = dialog.add_filter("ZIP", &["zip"]);
    }

    dialog.save_file()
}

async fn choose_download_path_async(
    app: tauri::AppHandle,
    filename: String,
) -> Result<Option<PathBuf>, String> {
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let dialog_app = app.clone();
    app.run_on_main_thread(move || {
        let path = choose_download_path(&dialog_app, &filename);
        let _ = tx.send(path);
    })
    .map_err(|error| format!("Не удалось открыть диалог сохранения: {error}"))?;

    tauri::async_runtime::spawn_blocking(move || {
        rx.recv()
            .map_err(|error| format!("Не удалось получить путь сохранения: {error}"))
    })
    .await
    .map_err(|error| format!("Не удалось выбрать файл для сохранения: {error}"))?
}

#[tauri::command]
async fn save_download(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<SaveDownloadResult, String> {
    let Some(path) = choose_download_path_async(app, filename).await? else {
        return Ok(SaveDownloadResult {
            ok: true,
            canceled: true,
            path: None,
        });
    };

    let saved_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || write_atomic(&path, content.as_bytes()))
        .await
        .map_err(|error| format!("Не удалось выполнить сохранение файла: {error}"))?
        .map_err(|error| format!("Не удалось сохранить файл: {error}"))?;

    Ok(SaveDownloadResult {
        ok: true,
        canceled: false,
        path: Some(saved_path.to_string_lossy().to_string()),
    })
}

#[tauri::command]
async fn save_download_bytes(
    app: tauri::AppHandle,
    filename: String,
    content: String,
) -> Result<SaveDownloadResult, String> {
    let Some(path) = choose_download_path_async(app, filename).await? else {
        return Ok(SaveDownloadResult {
            ok: true,
            canceled: true,
            path: None,
        });
    };

    let saved_path = path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(content.as_bytes())
            .map_err(|_| "Не удалось декодировать данные файла.".to_string())?;
        write_atomic(&path, &bytes)
            .map_err(|error| format!("Не удалось сохранить файл: {error}"))?;
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("Не удалось выполнить сохранение файла: {error}"))??;

    Ok(SaveDownloadResult {
        ok: true,
        canceled: false,
        path: Some(saved_path.to_string_lossy().to_string()),
    })
}

fn begin_staged_download(state: &AppState, target_path: PathBuf) -> Result<String, String> {
    if let Some(directory) = target_path.parent() {
        fs::create_dir_all(directory)
            .map_err(|error| format!("Не удалось создать папку для экспорта: {error}"))?;
    }
    let temp_path = unique_temp_path(&target_path);
    let file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp_path)
        .map_err(|error| format!("Не удалось подготовить файл экспорта: {error}"))?;
    let token = format!(
        "dl-{}-{}",
        std::process::id(),
        TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let mut map = lock_or_recover(&state.staged_downloads);
    if map.len() >= 16 {
        let _ = fs::remove_file(&temp_path);
        return Err("Слишком много незавершённых операций экспорта.".to_string());
    }
    map.insert(
        token.clone(),
        StagedDownload {
            target_path,
            temp_path,
            writer: Some(BufWriter::with_capacity(64 * 1024, file)),
        },
    );
    Ok(token)
}

fn append_staged_download_chunk(
    state: &AppState,
    token: &str,
    chunk_base64: &str,
) -> Result<(), String> {
    if chunk_base64.len() > 8 * 1024 * 1024 {
        return Err("Слишком большой фрагмент экспорта.".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(chunk_base64.as_bytes())
        .map_err(|_| "Не удалось декодировать фрагмент файла.".to_string())?;
    let mut map = lock_or_recover(&state.staged_downloads);
    let staged = map
        .get_mut(token)
        .ok_or_else(|| "Сессия экспорта не найдена.".to_string())?;
    let writer = staged
        .writer
        .as_mut()
        .ok_or_else(|| "Файл экспорта уже закрыт.".to_string())?;
    writer
        .write_all(&bytes)
        .map_err(|error| format!("Не удалось записать фрагмент файла: {error}"))?;
    Ok(())
}

fn finish_staged_download(state: &AppState, token: &str) -> Result<String, String> {
    let mut staged = {
        let mut map = lock_or_recover(&state.staged_downloads);
        map.remove(token)
            .ok_or_else(|| "Сессия экспорта не найдена.".to_string())?
    };

    let finish_result = (|| -> std::io::Result<()> {
        if let Some(mut writer) = staged.writer.take() {
            writer.flush()?;
            let file = writer
                .into_inner()
                .map_err(std::io::IntoInnerError::into_error)?;
            file.sync_all()?;
        }
        fs::rename(&staged.temp_path, &staged.target_path)?;
        Ok(())
    })();

    if let Err(error) = finish_result {
        drop(staged.writer.take());
        let _ = fs::remove_file(&staged.temp_path);
        return Err(format!("Не удалось завершить сохранение файла: {error}"));
    }

    Ok(staged.target_path.to_string_lossy().to_string())
}

fn abort_staged_download(state: &AppState, token: &str) {
    let staged = {
        let mut map = lock_or_recover(&state.staged_downloads);
        map.remove(token)
    };
    if let Some(mut entry) = staged {
        drop(entry.writer.take());
        let _ = fs::remove_file(&entry.temp_path);
    }
}

#[tauri::command]
async fn save_download_begin(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    filename: String,
) -> Result<DownloadBeginResult, String> {
    let Some(path) = choose_download_path_async(app, filename).await? else {
        return Ok(DownloadBeginResult {
            ok: true,
            canceled: true,
            token: None,
            path: None,
        });
    };

    let saved_path = path.to_string_lossy().to_string();
    let state = state.inner().clone();
    let token = tauri::async_runtime::spawn_blocking(move || begin_staged_download(&state, path))
        .await
        .map_err(|error| format!("Не удалось подготовить экспорт: {error}"))??;

    Ok(DownloadBeginResult {
        ok: true,
        canceled: false,
        token: Some(token),
        path: Some(saved_path),
    })
}

#[tauri::command]
async fn save_download_chunk(
    state: State<'_, AppState>,
    token: String,
    chunk: String,
) -> Result<OkResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        append_staged_download_chunk(&state, &token, &chunk)
    })
    .await
    .map_err(|error| format!("Не удалось записать данные экспорта: {error}"))??;
    Ok(OkResult { ok: true })
}

#[tauri::command]
async fn save_download_finish(
    state: State<'_, AppState>,
    token: String,
) -> Result<SaveDownloadResult, String> {
    let state = state.inner().clone();
    let path = tauri::async_runtime::spawn_blocking(move || finish_staged_download(&state, &token))
        .await
        .map_err(|error| format!("Не удалось завершить сохранение файла: {error}"))??;
    Ok(SaveDownloadResult {
        ok: true,
        canceled: false,
        path: Some(path),
    })
}

#[tauri::command]
async fn save_download_abort(
    state: State<'_, AppState>,
    token: String,
) -> Result<OkResult, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || abort_staged_download(&state, &token))
        .await
        .map_err(|error| format!("Не удалось отменить экспорт: {error}"))?;
    Ok(OkResult { ok: true })
}

#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Result<UpdateInfo, String> {
    use tauri_plugin_updater::UpdaterExt;

    let current_version = app.package_info().version.to_string();
    let updater = app
        .updater()
        .map_err(|error| format!("Не удалось подготовить проверку обновлений: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Не удалось проверить обновления: {error}"))?;

    match update {
        Some(update) => Ok(UpdateInfo {
            available: true,
            current_version: update.current_version,
            version: Some(update.version),
            notes: update.body,
            date: update.date.map(|date| date.to_string()),
        }),
        None => Ok(UpdateInfo {
            available: false,
            current_version,
            version: None,
            notes: None,
            date: None,
        }),
    }
}

#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<OkResult, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app
        .updater()
        .map_err(|error| format!("Не удалось подготовить установку обновления: {error}"))?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Не удалось проверить обновления: {error}"))?;
    let Some(update) = update else {
        return Err("Обновление не найдено. Возможно, установлена последняя версия.".to_string());
    };

    update
        .download_and_install(|_chunk_length, _content_length| {}, || {})
        .await
        .map_err(|error| format!("Не удалось установить обновление: {error}"))?;

    Ok(OkResult { ok: true })
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            fs::create_dir_all(&paths.screenshots)?;
            app.manage(AppState {
                paths,
                save_lock: Arc::new(Mutex::new(())),
                last_auto_backup: Arc::new(Mutex::new(None)),
                staged_downloads: Arc::new(Mutex::new(HashMap::new())),
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
            storage_restore_previous,
            storage_clear,
            storage_health,
            storage_cleanup_unused,
            screenshot_save,
            screenshot_load,
            data_info,
            open_data_folder,
            save_download,
            save_download_bytes,
            save_download_begin,
            save_download_chunk,
            save_download_finish,
            save_download_abort,
            update_check,
            update_install
        ])
        .run(tauri::generate_context!())
        .expect("error while running TradeJournal");
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn screenshot_references_are_collected_from_nested_journal_data() {
        let raw = json!({
            "accounts": [
                {
                    "trades": [
                        { "screenshot": "file:screenshots/abc-123.webp" },
                        { "screenshot": "data:image/png;base64,AAAA" }
                    ],
                    "notes": [
                        { "screenshot": "screenshots/note_shot.PNG" }
                    ]
                }
            ],
            "legacy": "old-shot.jpg"
        });

        let mut refs = std::collections::HashSet::new();
        collect_screenshot_refs(&raw, &mut refs);

        assert!(refs.contains("abc-123.webp"));
        assert!(refs.contains("note_shot.png"));
        assert!(refs.contains("old-shot.jpg"));
        assert_eq!(refs.len(), 3);
    }

    #[test]
    fn write_atomic_replaces_existing_file_and_cleans_temp_files() {
        let directory = std::env::temp_dir().join(format!(
            "tradejournal-write-atomic-{}-{}",
            std::process::id(),
            now_millis()
        ));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("export.json");

        write_atomic(&path, b"first version").unwrap();
        write_atomic(&path, b"second version").unwrap();

        assert_eq!(fs::read_to_string(&path).unwrap(), "second version");
        let temp_files: Vec<String> = fs::read_dir(&directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(".tj-") && name.ends_with(".tmp"))
            .collect();
        assert!(
            temp_files.is_empty(),
            "temporary files left: {temp_files:?}"
        );

        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn newest_backups_sort_first_and_equal_timestamps_keep_their_order() {
        let mut entries = vec![
            ("old", 10_u64),
            ("newest-a", 30_u64),
            ("middle", 20_u64),
            ("newest-b", 30_u64),
        ];

        sort_newest_first(&mut entries, |entry| entry.1);

        let names: Vec<&str> = entries.iter().map(|entry| entry.0).collect();
        assert_eq!(names, vec!["newest-a", "newest-b", "middle", "old"]);
    }

    #[test]
    fn unsafe_or_unknown_screenshot_names_are_rejected() {
        assert!(valid_screenshot_file_name("abc-123.webp"));
        assert!(valid_screenshot_file_name("ABC_123.JPG"));
        assert!(!valid_screenshot_file_name("../abc.png"));
        assert!(!valid_screenshot_file_name("folder/abc.png"));
        assert!(!valid_screenshot_file_name("abc.gif"));
        assert!(!valid_screenshot_file_name("file:screenshots/abc.png"));
        assert!(!valid_screenshot_file_name("abc.png.txt"));
        assert!(screenshot_reference_name("data:image/png;base64,AAAA").is_none());
    }

    struct TempStore {
        dir: PathBuf,
        state: AppState,
    }

    impl TempStore {
        fn new(label: &str) -> Self {
            let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
            let dir = std::env::temp_dir().join(format!(
                "tradejournal-{label}-{}-{}-{}",
                std::process::id(),
                now_millis(),
                counter
            ));
            let paths = StorePaths {
                journal: dir.join("journal.json"),
                previous: dir.join("journal.previous.json"),
                backups: dir.join("backups"),
                screenshots: dir.join("screenshots"),
                data_dir: dir.clone(),
            };
            fs::create_dir_all(&paths.backups).unwrap();
            fs::create_dir_all(&paths.screenshots).unwrap();
            let state = AppState {
                paths,
                save_lock: Arc::new(Mutex::new(())),
                last_auto_backup: Arc::new(Mutex::new(None)),
                staged_downloads: Arc::new(Mutex::new(HashMap::new())),
            };
            Self { dir, state }
        }
    }

    impl Drop for TempStore {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    fn sample_journal(tag: &str) -> String {
        json!({
            "version": 4,
            "accounts": [{
                "id": format!("acc-{tag}"),
                "trades": [{ "id": format!("t-{tag}"), "screenshot": "file:screenshots/kept.png" }],
                "notes": []
            }]
        })
        .to_string()
    }

    #[test]
    fn clear_journal_moves_corrupt_file_outside_backups_and_preserves_health() {
        let store = TempStore::new("clear-corrupt");
        fs::write(&store.state.paths.journal, "{broken-json").unwrap();

        clear_journal(&store.state).unwrap();

        assert!(!store.state.paths.journal.exists());
        assert!(list_backups(&store.state).unwrap().is_empty());

        let corrupt_files: Vec<String> = fs::read_dir(store.dir.join("corrupt"))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(corrupt_files.len(), 1);
        assert!(corrupt_files[0].ends_with("-corrupt.json"));

        let health = collect_storage_health(&store.state).unwrap();
        assert_eq!(health.backups_count, 0);
        assert!(health.warnings.is_empty());
        let cleanup = cleanup_unused_screenshots(&store.state, vec![]).unwrap();
        assert_eq!(cleanup.deleted_count, 0);
    }

    #[test]
    fn clear_journal_moves_valid_file_into_backups_removed() {
        let store = TempStore::new("clear-valid");
        let valid = sample_journal("valid");
        save_journal(&store.state, valid.clone()).unwrap();

        clear_journal(&store.state).unwrap();

        assert!(!store.state.paths.journal.exists());
        let backups = list_backups(&store.state).unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].reason, "removed");
        assert!(backups[0].name.ends_with("-removed.json"));
        let health = collect_storage_health(&store.state).unwrap();
        assert_eq!(health.backups_count, 1);
        assert_eq!(health.referenced_count, 1);
    }

    #[test]
    fn save_journal_skips_corrupt_previous_and_backs_up_valid_previous() {
        let store = TempStore::new("save-journal");
        fs::write(&store.state.paths.journal, "{not-valid").unwrap();

        let first = sample_journal("first");
        save_journal(&store.state, first.clone()).unwrap();

        assert!(!store.state.paths.previous.exists());
        assert!(list_backups(&store.state).unwrap().is_empty());

        let second = sample_journal("second");
        save_journal(&store.state, second.clone()).unwrap();

        assert_eq!(
            fs::read_to_string(&store.state.paths.previous).unwrap(),
            first
        );
        assert_eq!(
            fs::read_to_string(&store.state.paths.journal).unwrap(),
            second
        );
        let backups = list_backups(&store.state).unwrap();
        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].reason, "auto");
    }

    #[test]
    fn restore_backup_skips_corrupt_current_and_preserves_valid_current() {
        let store = TempStore::new("restore-backup");
        let first = sample_journal("v1");
        save_journal(&store.state, first.clone()).unwrap();
        let manual = create_manual_backup(&store.state).unwrap();

        let second = sample_journal("v2");
        save_journal(&store.state, second.clone()).unwrap();

        let restored = restore_backup(&store.state, &manual.name).unwrap();
        assert_eq!(restored, first);
        assert_eq!(
            fs::read_to_string(&store.state.paths.previous).unwrap(),
            second
        );
        assert!(list_backups(&store.state)
            .unwrap()
            .iter()
            .any(|backup| backup.reason == "before-restore"));

        fs::write(&store.state.paths.journal, "{corrupt-again").unwrap();
        restore_backup(&store.state, &manual.name).unwrap();
        assert_eq!(
            fs::read_to_string(&store.state.paths.previous).unwrap(),
            second
        );
    }

    #[test]
    fn corrupt_external_backup_reports_warning_and_blocks_cleanup() {
        let store = TempStore::new("external-corrupt");
        save_journal(&store.state, sample_journal("ok")).unwrap();
        fs::write(
            store
                .state
                .paths
                .backups
                .join("journal-external-broken.json"),
            "{bad-json",
        )
        .unwrap();

        let health = collect_storage_health(&store.state).unwrap();
        assert_eq!(health.backups_count, 1);
        assert!(health.backups_size > 0);
        assert_eq!(health.unused_count, 0);
        assert_eq!(health.warnings.len(), 1);
        assert!(health.warnings[0].contains("journal-external-broken.json"));

        let err = cleanup_unused_screenshots(&store.state, vec!["kept.png".to_string()])
            .err()
            .unwrap();
        assert!(err.contains("journal-external-broken.json"));
    }

    #[test]
    fn cleanup_unused_screenshots_respects_grace_period_references_and_invalid_names() {
        let store = TempStore::new("cleanup-grace");
        save_journal(&store.state, sample_journal("clean")).unwrap();

        let kept_path = store.state.paths.screenshots.join("kept.png");
        let fresh_path = store.state.paths.screenshots.join("fresh-orphan.png");
        let old_path = store.state.paths.screenshots.join("old-orphan.png");

        fs::write(&kept_path, b"kept").unwrap();
        fs::write(&fresh_path, b"fresh").unwrap();
        fs::write(&old_path, b"old-bytes").unwrap();

        let past = std::time::SystemTime::now()
            - std::time::Duration::from_millis(UNUSED_SCREENSHOT_GRACE_MS + 60_000);
        let old_file = fs::OpenOptions::new().write(true).open(&old_path).unwrap();
        old_file.set_modified(past).unwrap();
        drop(old_file);

        let result = cleanup_unused_screenshots(
            &store.state,
            vec![
                "kept.png".to_string(),
                "fresh-orphan.png".to_string(),
                "old-orphan.png".to_string(),
                "../escape.png".to_string(),
            ],
        )
        .unwrap();

        assert_eq!(result.skipped_referenced, 1);
        assert_eq!(result.skipped_recent, 1);
        assert_eq!(result.deleted_count, 1);
        assert_eq!(result.deleted, vec!["old-orphan.png".to_string()]);
        assert_eq!(result.deleted_size, 9);
        assert_eq!(result.failed, vec!["../escape.png".to_string()]);
        assert!(kept_path.exists());
        assert!(fresh_path.exists());
        assert!(!old_path.exists());
    }

    #[test]
    fn decode_screenshot_data_url_validates_mime_payload_and_magic_bytes() {
        let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);

        let png = b"\x89PNG\r\n\x1a\nrest";
        let (ext_png, decoded_png) =
            decode_screenshot_data_url(&format!("data:image/png;base64,{}", b64(png))).unwrap();
        assert_eq!(ext_png, "png");
        assert_eq!(decoded_png, png);

        let jpg = b"\xFF\xD8\xFF\xE0data";
        let (ext_jpg, decoded_jpg) =
            decode_screenshot_data_url(&format!("data:image/jpeg;base64,{}", b64(jpg))).unwrap();
        assert_eq!(ext_jpg, "jpg");
        assert_eq!(decoded_jpg, jpg);

        let webp = b"RIFF\x00\x00\x00\x00WEBPvp8";
        let (ext_webp, decoded_webp) =
            decode_screenshot_data_url(&format!("data:image/webp;base64,{}", b64(webp))).unwrap();
        assert_eq!(ext_webp, "webp");
        assert_eq!(decoded_webp, webp);

        assert!(decode_screenshot_data_url("not-a-data-url").is_err());
        assert!(decode_screenshot_data_url("data:image/svg+xml;base64,AAAA").is_err());
        assert!(decode_screenshot_data_url("data:image/png;base64,!!!").is_err());
        assert!(decode_screenshot_data_url("data:image/png;base64,").is_err());
        assert!(
            decode_screenshot_data_url(&format!("data:image/png;base64,{}", b64(jpg))).is_err()
        );

        let too_large = vec![0x89u8; MAX_SCREENSHOT_BYTES + 1];
        assert!(
            decode_screenshot_data_url(&format!("data:image/png;base64,{}", b64(&too_large)))
                .is_err()
        );
    }

    #[test]
    fn staged_download_streams_chunks_atomically_and_cleans_up_on_abort() {
        let store = TempStore::new("staged-download");
        let target = store.dir.join("export.zip");
        let b64 = |bytes: &[u8]| base64::engine::general_purpose::STANDARD.encode(bytes);

        let token = begin_staged_download(&store.state, target.clone()).unwrap();
        append_staged_download_chunk(&store.state, &token, &b64(b"hello ")).unwrap();
        append_staged_download_chunk(&store.state, &token, &b64(b"zip world")).unwrap();
        assert!(!target.exists());

        let saved_path = finish_staged_download(&store.state, &token).unwrap();
        assert_eq!(saved_path, target.to_string_lossy().to_string());
        assert_eq!(fs::read(&target).unwrap(), b"hello zip world");

        let aborted_target = store.dir.join("aborted.zip");
        let abort_token = begin_staged_download(&store.state, aborted_target.clone()).unwrap();
        append_staged_download_chunk(&store.state, &abort_token, &b64(b"partial")).unwrap();
        abort_staged_download(&store.state, &abort_token);
        assert!(!aborted_target.exists());
    }
}
