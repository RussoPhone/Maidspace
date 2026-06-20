use add_core::{analyze_directory, AnalyzeOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};
use std::env;
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf, Prefix};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

static ALC_CANCELLED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlcRelocationRequest {
    root_path: String,
    target_kind: String,
    target_directory: Option<String>,
    files: Vec<AlcFileSelection>,
    plan_mode: Option<String>,
    target_bytes: Option<u64>,
    expand_plan: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlcExpandRequest {
    root_path: String,
    mode: Option<String>,
    target_bytes: Option<u64>,
    limit: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlcFileSelection {
    relative_path: String,
    size: Option<u64>,
    user_content: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlcRelocationReport {
    target_kind: String,
    target_directory: Option<String>,
    requested_files: usize,
    moved_files: usize,
    failed_files: usize,
    skipped_files: usize,
    cancelled_files: usize,
    cancelled: bool,
    moved_bytes: u64,
    operations: Vec<AlcOperationReport>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlcExpandReport {
    provider: String,
    mode: String,
    target_bytes: u64,
    target_human: String,
    bytes: u64,
    human: String,
    files: usize,
    scanned_files: usize,
    eligible_files: usize,
    complete: bool,
    elapsed_ms: u128,
    stop_reason: Option<String>,
    warnings: Vec<String>,
    candidates: Vec<Value>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlcOperationReport {
    relative_path: String,
    size_bytes: u64,
    status: String,
    target_path: Option<String>,
    user_content: bool,
    error: Option<String>,
}

const MAX_OPERATION_REPORTS: usize = 5_000;
const ALC_TRASH_BATCH_SIZE: usize = 256;
const ALC_PROGRESS_FILE_INTERVAL: usize = 64;
const ALC_PROGRESS_TIME_INTERVAL: Duration = Duration::from_millis(250);
const ALC_COPY_BUFFER_BYTES: usize = 8 * 1024 * 1024;

struct PreparedAlcFile {
    source: PathBuf,
    relative: PathBuf,
    operation: AlcOperationReport,
}

struct AlcProgressTicker {
    last_emit: Instant,
}

impl AlcProgressTicker {
    fn new() -> Self {
        Self {
            last_emit: Instant::now()
                .checked_sub(ALC_PROGRESS_TIME_INTERVAL)
                .unwrap_or_else(Instant::now),
        }
    }

    fn emit(
        &mut self,
        app: &AppHandle,
        phase: &str,
        current_file: Option<&str>,
        index: usize,
        total: usize,
        report: &AlcRelocationReport,
        target_bytes: u64,
        force: bool,
    ) {
        if force
            || index % ALC_PROGRESS_FILE_INTERVAL == 0
            || self.last_emit.elapsed() >= ALC_PROGRESS_TIME_INTERVAL
        {
            emit_alc_progress(app, phase, current_file, index, total, report, target_bytes);
            self.last_emit = Instant::now();
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PreferenceMetadata {
    size: Option<u64>,
    note: Option<String>,
}

#[tauri::command]
fn maidspace_health() -> Value {
    json!({
        "ok": true,
        "mode": "local_tauri",
        "defaultRootPath": default_root_path(),
        "cwd": env::current_dir()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|_| String::from(".")),
        "defaultOptions": {
            "adaptive": true,
            "scanEngine": "rust_local",
            "dependencyMode": "metadata",
            "maxFiles": 120000,
            "maxDepth": 1024,
            "targetFreeBytes": 0u64,
            "minimumFreeBytes": 0u64,
            "includeProgramFiles": true
        },
        "diskStatus": disk_status_value(&default_root_path()).unwrap_or_else(|error| json!({
            "available": false,
            "error": error
        }))
    })
}

#[tauri::command(rename_all = "camelCase")]
fn maidspace_disk(root_path: String) -> Result<Value, String> {
    disk_status_value(&root_path)
}

#[tauri::command(rename_all = "camelCase")]
fn analyze_maidspace(
    root_path: String,
    target_free_bytes: Option<u64>,
    minimum_free_bytes: Option<u64>,
) -> Result<Value, String> {
    let report = analyze_directory(&PathBuf::from(root_path), AnalyzeOptions::default())
        .map_err(|error| error.to_string())?;
    let disk_status = disk_status_value(&report.root_path).unwrap_or_else(|error| json!({
        "available": false,
        "error": error
    }));
    Ok(json!({
        "mode": "local_tauri",
        "targetFreeBytes": target_free_bytes.unwrap_or(0),
        "minimumFreeBytes": minimum_free_bytes.unwrap_or(0),
        "diskStatus": disk_status,
        "report": report
    }))
}

#[tauri::command(rename_all = "camelCase")]
fn analyze_add(root_path: String) -> Result<Value, String> {
    analyze_maidspace(root_path, None, None)
}

#[tauri::command]
fn pick_directory() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.display().to_string()))
}

#[tauri::command(rename_all = "camelCase")]
fn load_preferences(root_path: String) -> Result<Value, String> {
    let store = read_preferences_store()?;
    Ok(root_preferences_from_store(&store, &root_path))
}

#[tauri::command(rename_all = "camelCase")]
fn save_file_decision(
    root_path: String,
    relative_path: String,
    decision: String,
    metadata: Option<PreferenceMetadata>,
) -> Result<Value, String> {
    let mut store = read_preferences_store()?;
    let root_key = preference_root_key(&root_path);
    ensure_preference_root(&mut store, &root_key);
    let relative = normalize_preference_relative(&relative_path)?;
    let now = now_iso_like();

    if decision == "clear" {
        if let Some(root) = store
            .get_mut("roots")
            .and_then(|roots| roots.get_mut(&root_key))
            .and_then(|value| value.as_object_mut())
        {
            if let Some(file_decisions) = root
                .get_mut("fileDecisions")
                .and_then(|value| value.as_object_mut())
            {
                file_decisions.remove(&relative);
            }
        }
    } else {
        let metadata = metadata.unwrap_or(PreferenceMetadata {
            size: Some(0),
            note: None,
        });
        let item = json!({
            "decision": decision,
            "updatedAt": now,
            "note": metadata.note.unwrap_or_default(),
            "size": metadata.size.unwrap_or(0)
        });
        store["roots"][&root_key]["fileDecisions"][&relative] = item;
    }

    write_preferences_store(&store)?;
    Ok(root_preferences_from_store(&store, &root_path))
}

#[tauri::command(rename_all = "camelCase")]
fn save_exempt_directories(root_path: String, directories: Vec<String>) -> Result<Value, String> {
    let mut store = read_preferences_store()?;
    let root_key = preference_root_key(&root_path);
    ensure_preference_root(&mut store, &root_key);
    let now = now_iso_like();
    let mut items = serde_json::Map::new();

    for directory in directories {
        let relative = normalize_preference_relative(&directory)?;
        items.insert(
            relative.clone(),
            json!({
                "path": relative,
                "updatedAt": now
            }),
        );
    }

    store["roots"][&root_key]["exemptDirectories"] = Value::Object(items);
    write_preferences_store(&store)?;
    Ok(root_preferences_from_store(&store, &root_path))
}

#[tauri::command(rename_all = "camelCase")]
fn save_target_preference(
    root_path: String,
    target_free_bytes: Option<u64>,
    minimum_free_bytes: Option<u64>,
) -> Result<Value, String> {
    let mut store = read_preferences_store()?;
    let root_key = preference_root_key(&root_path);
    ensure_preference_root(&mut store, &root_key);
    store["roots"][&root_key]["targetFreeBytes"] = json!(target_free_bytes.unwrap_or(0));
    store["roots"][&root_key]["minimumFreeBytes"] = json!(minimum_free_bytes.unwrap_or(0));
    store["roots"][&root_key]["updatedAt"] = json!(now_iso_like());
    write_preferences_store(&store)?;
    Ok(root_preferences_from_store(&store, &root_path))
}

#[tauri::command(rename_all = "camelCase")]
fn expand_alc_candidates(request: AlcExpandRequest) -> Result<AlcExpandReport, String> {
    let root = fs::canonicalize(&request.root_path)
        .map_err(|error| format!("Nao foi possivel acessar a raiz: {error}"))?;
    if !root.is_dir() {
        return Err(format!("A raiz nao e um diretorio: {}", root.display()));
    }

    let mode = normalize_alc_mode(request.mode.as_deref().unwrap_or("alto"));
    let target_bytes = request.target_bytes.unwrap_or(0);
    let limit = request.limit.unwrap_or(1_000_000).clamp(1, 1_000_000);
    let preferences = root_preferences_from_store(&read_preferences_store()?, &request.root_path);
    let started = Instant::now();
    let mut stack = VecDeque::from([root.clone()]);
    let mut candidates: Vec<Value> = Vec::new();
    let mut skipped_oversized: Vec<Value> = Vec::new();
    let mut bytes = 0u64;
    let mut scanned_files = 0usize;
    let mut eligible_files = 0usize;
    let mut warnings = Vec::new();
    let mut stop_reason = None;

    while let Some(directory) = stack.pop_back() {
        if started.elapsed() > Duration::from_secs(10 * 60) {
            stop_reason = Some(String::from(
                "Expansao A.L.C interrompida por limite de tempo; candidatos parciais mantidos.",
            ));
            break;
        }

        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) => {
                warnings.push(format!("Sem acesso a {}: {error}", directory.display()));
                continue;
            }
        };

        for entry in entries.flatten() {
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            let relative = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let normalized_relative = normalize_preference_key(&relative);

            if file_type.is_dir() {
                if is_strict_system_path(
                    &path.to_string_lossy().to_ascii_lowercase(),
                    &normalized_relative,
                ) || preference_exempts_relative(&preferences, &normalized_relative)
                {
                    continue;
                }
                stack.push_back(path);
                continue;
            }

            if !file_type.is_file() {
                continue;
            }

            scanned_files += 1;
            if preference_decision(&preferences, &normalized_relative) == Some("ignore")
                || preference_exempts_relative(&preferences, &normalized_relative)
            {
                continue;
            }

            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if is_strict_system_file_native(&path, &normalized_relative, &extension)
                || protected_file_name(&path)
            {
                continue;
            }

            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let size = metadata.len();
            if size == 0 {
                continue;
            }
            let days = metadata
                .accessed()
                .ok()
                .map(days_since_system_time)
                .unwrap_or(31);
            let cleanup_mode = match alc_cleanup_mode(&normalized_relative, &extension, size, days) {
                Some(cleanup_mode) => cleanup_mode,
                None => continue,
            };
            if !cleanup_mode_included(&mode, cleanup_mode) {
                continue;
            }

            eligible_files += 1;
            let candidate = alc_candidate_json(
                &relative,
                &extension,
                size,
                days,
                &mode,
                cleanup_mode,
                preference_decision(&preferences, &normalized_relative),
            );
            let remaining = target_bytes.saturating_sub(bytes);
            if target_bytes > 0 && remaining > 0 && size > remaining && bytes > 0 {
                skipped_oversized.push(candidate);
                if skipped_oversized.len() > 5000 {
                    skipped_oversized.sort_by_key(candidate_json_bytes);
                    skipped_oversized.truncate(5000);
                }
                continue;
            }

            bytes = bytes.saturating_add(size);
            candidates.push(candidate);
            if candidates.len() >= limit {
                stop_reason = Some(format!("Expansao A.L.C parou em {limit} candidato(s)."));
                break;
            }
            if target_bytes > 0 && bytes >= target_bytes {
                stop_reason = Some(format!(
                    "Expansao A.L.C atingiu {} para meta {}.",
                    format_bytes(bytes),
                    format_bytes(target_bytes)
                ));
                break;
            }
        }

        if stop_reason.is_some() {
            break;
        }
    }

    if target_bytes > 0 && bytes < target_bytes && !skipped_oversized.is_empty() && candidates.len() < limit {
        skipped_oversized.sort_by_key(|candidate| {
            let candidate_total = bytes.saturating_add(candidate_json_bytes(candidate));
            candidate_total.abs_diff(target_bytes)
        });
        if let Some(candidate) = skipped_oversized.into_iter().next() {
            bytes = bytes.saturating_add(candidate_json_bytes(&candidate));
            candidates.push(candidate);
        }
    }

    candidates.sort_by(|a, b| {
        candidate_json_bytes(b)
            .cmp(&candidate_json_bytes(a))
            .then_with(|| {
                candidate_json_path(a)
                    .cmp(&candidate_json_path(b))
            })
    });

    Ok(AlcExpandReport {
        provider: String::from("rust_local_focused_alc"),
        mode,
        target_bytes,
        target_human: format_bytes(target_bytes),
        bytes,
        human: format_bytes(bytes),
        files: candidates.len(),
        scanned_files,
        eligible_files,
        complete: target_bytes == 0 || bytes >= target_bytes,
        elapsed_ms: started.elapsed().as_millis(),
        stop_reason,
        warnings,
        candidates,
    })
}

#[tauri::command(rename_all = "camelCase")]
fn execute_alc_relocation(
    app: AppHandle,
    request: AlcRelocationRequest,
) -> Result<AlcRelocationReport, String> {
    ALC_CANCELLED.store(false, Ordering::Relaxed);
    let root = fs::canonicalize(&request.root_path)
        .map_err(|error| format!("Nao foi possivel acessar a raiz: {error}"))?;
    if !root.is_dir() {
        return Err(format!("A raiz nao e um diretorio: {}", root.display()));
    }

    let target_kind = request.target_kind.trim().to_ascii_lowercase();
    if target_kind != "directory" && target_kind != "trash" && target_kind != "delete" {
        return Err(String::from("Destino A.L.C invalido."));
    }

    let target_directory = if target_kind == "directory" {
        let value = request
            .target_directory
            .as_ref()
            .map(|path| path.trim())
            .filter(|path| !path.is_empty())
            .ok_or_else(|| String::from("Escolha uma pasta de destino para o A.L.C."))?;
        let target = PathBuf::from(value);
        fs::create_dir_all(&target)
            .map_err(|error| format!("Nao foi possivel criar o destino: {error}"))?;
        let canonical = fs::canonicalize(&target)
            .map_err(|error| format!("Nao foi possivel acessar o destino: {error}"))?;
        if canonical.starts_with(&root) {
            return Err(String::from(
                "O destino esta dentro da raiz varrida; escolha uma pasta fora dela para liberar espaco.",
            ));
        }
        Some(canonical)
    } else {
        None
    };

    let files = request.files.clone();
    let requested_preview_bytes = files
        .iter()
        .fold(0u64, |sum, file| sum.saturating_add(file.size.unwrap_or(0)));
    let target_bytes = request.target_bytes.unwrap_or(0);
    let should_expand_plan = request.expand_plan.unwrap_or(false)
        || (target_bytes > 0
            && requested_preview_bytes < target_bytes.saturating_sub(target_bytes / 50));

    let mut report = AlcRelocationReport {
        target_kind: target_kind.clone(),
        target_directory: target_directory
            .as_ref()
            .map(|path| path.display().to_string()),
        requested_files: 0,
        moved_files: 0,
        failed_files: 0,
        skipped_files: 0,
        cancelled_files: 0,
        cancelled: false,
        moved_bytes: 0,
        operations: Vec::with_capacity(files.len().min(MAX_OPERATION_REPORTS)),
    };
    let mut seen = HashSet::new();
    let total_preview_files = files.len();
    let progress_target_bytes = if target_bytes > 0 {
        target_bytes
    } else {
        requested_preview_bytes
    };
    emit_alc_progress(
        &app,
        "start",
        None,
        0,
        total_preview_files,
        &report,
        progress_target_bytes,
    );

    let mut progress_ticker = AlcProgressTicker::new();
    let mut trash_batch = Vec::with_capacity(ALC_TRASH_BATCH_SIZE);
    let mut created_directories = HashSet::new();

    for (index, file) in files.into_iter().enumerate() {
        if ALC_CANCELLED.load(Ordering::Relaxed) {
            report.cancelled = true;
            break;
        }

        if let Some(prepared) = prepare_alc_file(&root, file, &mut report, &mut seen) {
            if target_kind == "trash" {
                trash_batch.push(prepared);
                if trash_batch.len() >= ALC_TRASH_BATCH_SIZE {
                    flush_trash_batch(&mut trash_batch, &mut report);
                }
            } else if target_kind == "delete" {
                delete_prepared_file(prepared, &mut report);
            } else {
                move_prepared_file_to_directory(
                    target_directory.as_deref(),
                    prepared,
                    &mut report,
                    &mut created_directories,
                );
            }
        }

        progress_ticker.emit(
            &app,
            "move",
            report
                .operations
                .last()
                .map(|operation| operation.relative_path.as_str()),
            index + 1,
            total_preview_files,
            &report,
            progress_target_bytes,
            false,
        );
    }

    if report.cancelled || ALC_CANCELLED.load(Ordering::Relaxed) {
        cancel_trash_batch(&mut trash_batch, &mut report);
    } else {
        flush_trash_batch(&mut trash_batch, &mut report);
    }
    progress_ticker.emit(
        &app,
        "move",
        report
            .operations
            .last()
            .map(|operation| operation.relative_path.as_str()),
        total_preview_files,
        total_preview_files,
        &report,
        progress_target_bytes,
        true,
    );

    if !report.cancelled
        && should_expand_plan
        && target_bytes > 0
        && report.moved_bytes < target_bytes
    {
        stream_relocate_alc_plan(
            &app,
            &root,
            &request.root_path,
            &target_kind,
            target_directory.as_deref(),
            request.plan_mode.as_deref().unwrap_or("alto"),
            target_bytes,
            &mut report,
            &mut seen,
        )?;
    }

    report.cancelled = report.cancelled || ALC_CANCELLED.load(Ordering::Relaxed);
    emit_alc_progress(
        &app,
        if report.cancelled {
            "cancelled"
        } else {
            "done"
        },
        None,
        report.requested_files,
        report.requested_files,
        &report,
        progress_target_bytes,
    );
    Ok(report)
}

#[tauri::command]
fn cancel_alc_relocation() -> Result<(), String> {
    ALC_CANCELLED.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command(rename_all = "camelCase")]
fn reveal_in_explorer(root_path: String, relative_path: String) -> Result<(), String> {
    let root = fs::canonicalize(&root_path)
        .map_err(|error| format!("Nao foi possivel acessar a raiz: {error}"))?;
    let relative = safe_relative_path(&relative_path)?;
    let target = root.join(relative);
    let reveal_target = fs::canonicalize(&target)
        .or_else(|_| {
            target
                .parent()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "sem pasta pai"))
                .and_then(fs::canonicalize)
        })
        .map_err(|error| format!("Nao foi possivel localizar o arquivo: {error}"))?;

    if !reveal_target.starts_with(&root) {
        return Err(String::from("Arquivo fora da raiz varrida."));
    }

    if cfg!(target_os = "windows") {
        let argument = if reveal_target.is_file() {
            format!("/select,{}", reveal_target.display())
        } else {
            reveal_target.display().to_string()
        };
        Command::new("explorer")
            .arg(argument)
            .spawn()
            .map_err(|error| format!("Nao foi possivel abrir o Explorer: {error}"))?;
    } else if cfg!(target_os = "macos") {
        Command::new("open")
            .arg(&reveal_target)
            .spawn()
            .map_err(|error| format!("Nao foi possivel abrir o Finder: {error}"))?;
    } else {
        Command::new("xdg-open")
            .arg(&reveal_target)
            .spawn()
            .map_err(|error| {
                format!("Nao foi possivel abrir o gerenciador de arquivos: {error}")
            })?;
    }

    Ok(())
}

fn prepare_alc_file(
    root: &Path,
    file: AlcFileSelection,
    report: &mut AlcRelocationReport,
    seen: &mut HashSet<String>,
) -> Option<PreparedAlcFile> {
    let mut operation = AlcOperationReport {
        relative_path: file.relative_path.clone(),
        size_bytes: file.size.unwrap_or(0),
        status: String::from("failed"),
        target_path: None,
        user_content: file.user_content.unwrap_or(false),
        error: None,
    };

    if ALC_CANCELLED.load(Ordering::Relaxed) {
        operation.status = String::from("cancelled");
        operation.error = Some(String::from("Cancelado."));
        report.cancelled = true;
        report.cancelled_files += 1;
        push_operation_report(report, operation);
        return None;
    }

    let relative = match safe_relative_path(&file.relative_path) {
        Ok(path) => path,
        Err(error) => {
            operation.error = Some(error);
            report.failed_files += 1;
            push_operation_report(report, operation);
            return None;
        }
    };
    let relative_key = normalize_preference_key(&relative.display().to_string());
    if !seen.insert(relative_key) {
        return None;
    }
    report.requested_files += 1;

    let source = match fs::canonicalize(root.join(&relative)) {
        Ok(path) => path,
        Err(error) => {
            operation.error = Some(format!("Arquivo indisponivel: {error}"));
            report.failed_files += 1;
            push_operation_report(report, operation);
            return None;
        }
    };

    if !source.starts_with(root) {
        operation.error = Some(String::from("Arquivo fora da raiz varrida."));
        report.failed_files += 1;
        push_operation_report(report, operation);
        return None;
    }

    let metadata = match fs::metadata(&source) {
        Ok(metadata) => metadata,
        Err(error) => {
            operation.error = Some(format!("Falha ao ler metadados: {error}"));
            report.failed_files += 1;
            push_operation_report(report, operation);
            return None;
        }
    };

    if !metadata.is_file() {
        operation.status = String::from("skipped");
        operation.error = Some(String::from("A.L.C MVP move apenas arquivos."));
        report.skipped_files += 1;
        push_operation_report(report, operation);
        return None;
    }

    operation.size_bytes = metadata.len();
    Some(PreparedAlcFile {
        source,
        relative,
        operation,
    })
}

fn move_prepared_file_to_directory(
    target_directory: Option<&Path>,
    prepared: PreparedAlcFile,
    report: &mut AlcRelocationReport,
    created_directories: &mut HashSet<PathBuf>,
) {
    let PreparedAlcFile {
        source,
        relative,
        mut operation,
    } = prepared;
    let Some(target_root) = target_directory else {
        operation.error = Some(String::from("Destino A.L.C ausente."));
        report.failed_files += 1;
        push_operation_report(report, operation);
        return;
    };
    let destination = unique_destination(&target_root.join(&relative));
    let result = move_file_to(&source, &destination, created_directories)
        .map(|_| {
            operation.status = String::from("moved");
            operation.target_path = Some(destination.display().to_string());
        })
        .map_err(|error| error.to_string());

    match result {
        Ok(()) => {
            report.moved_files += 1;
            report.moved_bytes = report.moved_bytes.saturating_add(operation.size_bytes);
        }
        Err(error) => {
            if ALC_CANCELLED.load(Ordering::Relaxed) || error == "Cancelado." {
                operation.status = String::from("cancelled");
                operation.error = Some(String::from("Cancelado."));
                report.cancelled = true;
                report.cancelled_files += 1;
            } else {
                operation.status = String::from("failed");
                operation.error = Some(error);
                report.failed_files += 1;
            }
        }
    }

    push_operation_report(report, operation);
}

fn delete_prepared_file(prepared: PreparedAlcFile, report: &mut AlcRelocationReport) {
    if ALC_CANCELLED.load(Ordering::Relaxed) {
        mark_prepared_cancelled(prepared, report);
        return;
    }

    let result = fs::remove_file(&prepared.source).map_err(|error| error.to_string());
    match result {
        Ok(()) => {
            let mut operation = prepared.operation;
            operation.status = String::from("deleted");
            operation.target_path = Some(String::from("excluido"));
            report.moved_files += 1;
            report.moved_bytes = report.moved_bytes.saturating_add(operation.size_bytes);
            push_operation_report(report, operation);
        }
        Err(error) => {
            if ALC_CANCELLED.load(Ordering::Relaxed) || error == "Cancelado." {
                mark_prepared_cancelled(prepared, report);
            } else {
                mark_prepared_failed(prepared, report, error);
            }
        }
    }
}

fn flush_trash_batch(batch: &mut Vec<PreparedAlcFile>, report: &mut AlcRelocationReport) {
    if batch.is_empty() {
        return;
    }
    if ALC_CANCELLED.load(Ordering::Relaxed) {
        cancel_trash_batch(batch, report);
        return;
    }

    let files = std::mem::take(batch);
    let paths: Vec<PathBuf> = files.iter().map(|item| item.source.clone()).collect();
    match trash::delete_all(paths.iter()) {
        Ok(()) => {
            for prepared in files {
                mark_prepared_trashed(prepared, report);
            }
        }
        Err(error) => {
            trash_files_individually(files, report, error.to_string());
        }
    }
}

fn trash_files_individually(
    files: Vec<PreparedAlcFile>,
    report: &mut AlcRelocationReport,
    batch_error: String,
) {
    for prepared in files {
        if ALC_CANCELLED.load(Ordering::Relaxed) {
            mark_prepared_cancelled(prepared, report);
            continue;
        }
        if !prepared.source.exists() {
            mark_prepared_trashed(prepared, report);
            continue;
        }
        let result = trash::delete(&prepared.source).map_err(|error| error.to_string());
        match result {
            Ok(()) => mark_prepared_trashed(prepared, report),
            Err(error) => {
                let message = if error.is_empty() {
                    batch_error.clone()
                } else {
                    error
                };
                mark_prepared_failed(prepared, report, message);
            }
        }
    }
}

fn mark_prepared_trashed(prepared: PreparedAlcFile, report: &mut AlcRelocationReport) {
    let mut operation = prepared.operation;
    operation.status = String::from("trashed");
    operation.target_path = Some(String::from("lixeira"));
    report.moved_files += 1;
    report.moved_bytes = report.moved_bytes.saturating_add(operation.size_bytes);
    push_operation_report(report, operation);
}

fn mark_prepared_failed(
    prepared: PreparedAlcFile,
    report: &mut AlcRelocationReport,
    error: String,
) {
    let mut operation = prepared.operation;
    operation.status = String::from("failed");
    operation.error = Some(error);
    report.failed_files += 1;
    push_operation_report(report, operation);
}

fn mark_prepared_cancelled(prepared: PreparedAlcFile, report: &mut AlcRelocationReport) {
    let mut operation = prepared.operation;
    operation.status = String::from("cancelled");
    operation.error = Some(String::from("Cancelado."));
    report.cancelled = true;
    report.cancelled_files += 1;
    push_operation_report(report, operation);
}

fn cancel_trash_batch(batch: &mut Vec<PreparedAlcFile>, report: &mut AlcRelocationReport) {
    for prepared in std::mem::take(batch) {
        mark_prepared_cancelled(prepared, report);
    }
}

fn stream_relocate_alc_plan(
    app: &AppHandle,
    root: &Path,
    root_path: &str,
    target_kind: &str,
    target_directory: Option<&Path>,
    plan_mode: &str,
    target_bytes: u64,
    report: &mut AlcRelocationReport,
    seen: &mut HashSet<String>,
) -> Result<(), String> {
    let preferences = root_preferences_from_store(&read_preferences_store()?, root_path);
    let mode = normalize_alc_mode(plan_mode);
    let mut stack = VecDeque::from([root.to_path_buf()]);
    let mut progress_ticker = AlcProgressTicker::new();
    let mut trash_batch = Vec::with_capacity(ALC_TRASH_BATCH_SIZE);
    let mut pending_trash_bytes = 0u64;
    let mut created_directories = HashSet::new();
    emit_alc_progress(
        app,
        "expand",
        None,
        report.requested_files,
        report.requested_files,
        report,
        target_bytes,
    );

    while let Some(directory) = stack.pop_back() {
        if ALC_CANCELLED.load(Ordering::Relaxed) {
            report.cancelled = true;
            break;
        }
        if report.moved_bytes.saturating_add(pending_trash_bytes) >= target_bytes {
            break;
        }
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => continue,
        };

        for entry in entries.flatten() {
            if report.moved_bytes.saturating_add(pending_trash_bytes) >= target_bytes {
                break;
            }
            if ALC_CANCELLED.load(Ordering::Relaxed) {
                report.cancelled = true;
                break;
            }
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => continue,
            };
            if file_type.is_symlink() {
                continue;
            }

            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let normalized_relative = normalize_preference_key(&relative);

            if file_type.is_dir() {
                if is_strict_system_path(
                    &path.to_string_lossy().to_ascii_lowercase(),
                    &normalized_relative,
                ) || preference_exempts_relative(&preferences, &normalized_relative)
                {
                    continue;
                }
                stack.push_back(path);
                continue;
            }

            if !file_type.is_file()
                || seen.contains(&normalized_relative)
                || preference_decision(&preferences, &normalized_relative) == Some("ignore")
                || preference_exempts_relative(&preferences, &normalized_relative)
            {
                continue;
            }

            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if is_strict_system_file_native(&path, &normalized_relative, &extension)
                || protected_file_name(&path)
            {
                continue;
            }

            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(_) => continue,
            };
            let size = metadata.len();
            if size == 0 {
                continue;
            }
            let days = metadata
                .accessed()
                .ok()
                .map(days_since_system_time)
                .unwrap_or(31);
            let Some(cleanup_mode) = alc_cleanup_mode(&normalized_relative, &extension, size, days)
            else {
                continue;
            };
            if !cleanup_mode_included(&mode, cleanup_mode) {
                continue;
            }

            if let Some(prepared) = prepare_alc_file(
                root,
                AlcFileSelection {
                    relative_path: relative,
                    size: Some(size),
                    user_content: Some(is_user_content_path_native(
                        &normalized_relative,
                        &extension,
                    )),
                },
                report,
                seen,
            ) {
                if target_kind == "trash" {
                    pending_trash_bytes =
                        pending_trash_bytes.saturating_add(prepared.operation.size_bytes);
                    trash_batch.push(prepared);
                    if trash_batch.len() >= ALC_TRASH_BATCH_SIZE
                        || report.moved_bytes.saturating_add(pending_trash_bytes) >= target_bytes
                    {
                        flush_trash_batch(&mut trash_batch, report);
                        pending_trash_bytes = 0;
                    }
                } else if target_kind == "delete" {
                    delete_prepared_file(prepared, report);
                } else {
                    move_prepared_file_to_directory(
                        target_directory,
                        prepared,
                        report,
                        &mut created_directories,
                    );
                }
            }
            progress_ticker.emit(
                app,
                "move",
                report
                    .operations
                    .last()
                    .map(|operation| operation.relative_path.as_str()),
                report.requested_files,
                report.requested_files,
                report,
                target_bytes,
                false,
            );
        }
    }

    if report.cancelled || ALC_CANCELLED.load(Ordering::Relaxed) {
        cancel_trash_batch(&mut trash_batch, report);
    } else {
        flush_trash_batch(&mut trash_batch, report);
    }
    progress_ticker.emit(
        app,
        "move",
        report
            .operations
            .last()
            .map(|operation| operation.relative_path.as_str()),
        report.requested_files,
        report.requested_files,
        report,
        target_bytes,
        true,
    );

    Ok(())
}

fn push_operation_report(report: &mut AlcRelocationReport, operation: AlcOperationReport) {
    if report.operations.len() < MAX_OPERATION_REPORTS {
        report.operations.push(operation);
    }
}

fn emit_alc_progress(
    app: &AppHandle,
    phase: &str,
    current_file: Option<&str>,
    index: usize,
    total: usize,
    report: &AlcRelocationReport,
    target_bytes: u64,
) {
    let byte_percent = if target_bytes > 0 {
        (report.moved_bytes as f64 / target_bytes as f64) * 100.0
    } else {
        0.0
    };
    let file_percent = if total > 0 {
        (index as f64 / total as f64) * 100.0
    } else {
        0.0
    };
    let percent = byte_percent.max(file_percent).clamp(0.0, 100.0);
    let _ = app.emit(
        "alc-progress",
        json!({
            "phase": phase,
            "currentFile": current_file.unwrap_or(""),
            "index": index,
            "total": total,
            "percent": percent,
            "movedFiles": report.moved_files,
            "failedFiles": report.failed_files,
            "skippedFiles": report.skipped_files,
            "cancelledFiles": report.cancelled_files,
            "movedBytes": report.moved_bytes,
            "movedHuman": format_bytes(report.moved_bytes),
            "targetBytes": target_bytes,
            "targetHuman": format_bytes(target_bytes),
            "cancelled": report.cancelled || ALC_CANCELLED.load(Ordering::Relaxed)
        }),
    );
}

fn normalize_alc_mode(raw: &str) -> String {
    match raw {
        "baixo" | "medio" | "alto" => raw.to_string(),
        _ => String::from("alto"),
    }
}

fn cleanup_mode_included(selected: &str, cleanup_mode: &str) -> bool {
    cleanup_rank(cleanup_mode) <= cleanup_rank(selected)
}

fn cleanup_rank(mode: &str) -> u8 {
    match mode {
        "baixo" => 0,
        "medio" => 1,
        "alto" => 2,
        _ => 2,
    }
}

fn alc_cleanup_mode(relative: &str, extension: &str, bytes: u64, days: u64) -> Option<&'static str> {
    if bytes == 0 {
        return None;
    }
    let low_value = is_low_value_path_native(relative, extension);
    let archive_or_installer = is_archive_or_installer_native(extension);
    let bulky_user_file = is_bulky_user_file_native(relative, extension);
    let application_state = is_application_state_path_native(relative, extension) && !low_value;
    let stale = days >= 30;
    let not_hot = days > 4;

    if low_value && stale {
        return Some("baixo");
    }
    if not_hot
        && !application_state
        && (low_value || (archive_or_installer && stale) || (bulky_user_file && stale))
    {
        return Some("medio");
    }
    Some("alto")
}

fn alc_candidate_json(
    relative: &str,
    extension: &str,
    bytes: u64,
    days: u64,
    selected_mode: &str,
    cleanup_mode: &str,
    preference: Option<&str>,
) -> Value {
    let deletion_decision = match cleanup_mode {
        "baixo" => "pode_apagar",
        "medio" => {
            if is_low_value_path_native(relative, extension) {
                "pode_apagar"
            } else {
                "inutil_provavel"
            }
        }
        _ => "averiguar",
    };
    let risk = if is_application_state_path_native(relative, extension)
        || matches!(
            extension,
            "dll" | "exe" | "json" | "db" | "sqlite" | "sqlite3" | "dat" | "ini" | "cfg" | "conf"
        ) {
        "alto"
    } else if cleanup_mode == "baixo" {
        "baixo"
    } else {
        "medio"
    };
    let justification = match cleanup_mode {
        "baixo" => "inventario local A.L.C: cache, temporario ou log antigo",
        "medio" => "inventario local A.L.C: pacote, instalador ou gerado de baixo uso",
        _ if is_user_content_path_native(relative, extension) => {
            "inventario local A.L.C: conteudo grande ou antigo para revisao"
        }
        _ => "inventario local A.L.C: candidato do nivel alto",
    };
    json!({
        "mode": selected_mode,
        "cleanupMode": cleanup_mode,
        "source": "rust_local_focused_alc",
        "path": relative,
        "sizeBytes": bytes,
        "sizeHuman": format_bytes(bytes),
        "packageBytes": bytes,
        "packageHuman": format_bytes(bytes),
        "packagePaths": [relative],
        "packageFileCount": 1,
        "targetDirectory": if deletion_decision == "pode_apagar" { "/lixeira_segura" } else { "/revisar/baixo_uso" },
        "classification": "isolado",
        "risk": risk,
        "structuralRisk": risk,
        "deletionDecision": deletion_decision,
        "relocationDecision": "pode_mexer",
        "daysSinceAccess": days,
        "incoming": 0,
        "outgoing": 0,
        "dependencyImpact": "metadata",
        "userImpact": if is_user_content_path_native(relative, extension) { "medio" } else { "baixo" },
        "systemImpact": "nao_afeta_sistema",
        "spatialCategories": [],
        "justification": justification,
        "requiresConfirmation": true,
        "userDecision": if preference == Some("relocate") { json!({ "action": "relocate" }) } else { Value::Null }
    })
}

fn is_strict_system_file_native(path: &Path, relative: &str, extension: &str) -> bool {
    let absolute = path.to_string_lossy().to_ascii_lowercase();
    matches!(extension, "sys" | "reg") || is_strict_system_path(&absolute, relative)
}

fn is_strict_system_path(absolute: &str, relative: &str) -> bool {
    let normalized_absolute = absolute.replace('\\', "/").to_ascii_lowercase();
    let normalized_relative = relative.replace('\\', "/").to_ascii_lowercase();
    let corpus = format!("{normalized_absolute}\n{normalized_relative}");

    [
        "/system32/",
        "/syswow64/",
        "/winsxs/",
        "/windowsapps/",
        "/recovery/",
        "/system volume information/",
        "/$winreagent/",
        "/windows/system32/",
        "/windows/syswow64/",
        "/windows/winsxs/",
        "/windows/servicing/",
        "/windows/systemresources/",
        "/windows/security/",
        "/windows/inf/",
        "/windows/assembly/",
        "/windows/diagnostics/",
        "/programdata/microsoft/",
    ]
    .iter()
    .any(|token| corpus.contains(token))
}

fn protected_file_name(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    matches!(
        name.as_str(),
        ".env"
            | ".env.local"
            | ".env.production"
            | ".gitignore"
            | ".npmrc"
            | ".yarnrc"
            | "cargo.lock"
            | "cargo.toml"
            | "composer.lock"
            | "dockerfile"
            | "go.mod"
            | "go.sum"
            | "package-lock.json"
            | "package.json"
            | "pnpm-lock.yaml"
            | "poetry.lock"
            | "pyproject.toml"
            | "requirements.txt"
            | "tsconfig.json"
            | "vite.config.js"
            | "vite.config.ts"
            | "webpack.config.js"
            | "yarn.lock"
    )
}

fn is_low_value_path_native(relative: &str, extension: &str) -> bool {
    let normalized = relative.replace('\\', "/").to_ascii_lowercase();
    matches!(
        extension,
        "tmp" | "temp" | "log" | "bak" | "old" | "cache" | "dmp" | "chk" | "crdownload" | "part"
    ) || normalized.contains("/cache/")
        || normalized.contains("/caches/")
        || normalized.contains("/tmp/")
        || normalized.contains("/temp/")
        || normalized.contains("/logs/")
        || normalized.contains("/node_modules/.cache/")
        || normalized.contains("/target/")
        || normalized.contains("/dist/")
        || normalized.contains("/build/")
        || normalized.contains("/coverage/")
}

fn is_archive_or_installer_native(extension: &str) -> bool {
    matches!(
        extension,
        "zip" | "7z" | "rar" | "tar" | "gz" | "xz" | "iso" | "dmg" | "msi" | "exe" | "pkg" | "deb" | "rpm"
    )
}

fn is_bulky_user_file_native(relative: &str, extension: &str) -> bool {
    let normalized = relative.replace('\\', "/").to_ascii_lowercase();
    matches!(
        extension,
        "zip" | "7z" | "rar" | "tar" | "gz" | "xz" | "iso" | "dmg" | "msi" | "mp4" | "mov" | "mkv" | "avi" | "webm" | "mp3" | "wav" | "flac" | "jpg" | "jpeg" | "png" | "webp"
    ) || normalized.contains("/backup/")
        || normalized.contains("/backups/")
        || normalized.contains("/archives/")
}

fn is_user_content_path_native(relative: &str, extension: &str) -> bool {
    let normalized = relative.replace('\\', "/").to_ascii_lowercase();
    let in_user_area = [
        "/desktop/",
        "/documents/",
        "/downloads/",
        "/pictures/",
        "/videos/",
        "/music/",
        "/onedrive/",
        "/dropbox/",
        "/google drive/",
        "/icloud drive/",
    ]
    .iter()
    .any(|token| normalized.contains(token))
        || normalized.starts_with("desktop/")
        || normalized.starts_with("documents/")
        || normalized.starts_with("downloads/")
        || normalized.starts_with("pictures/")
        || normalized.starts_with("videos/")
        || normalized.starts_with("music/")
        || normalized.starts_with("onedrive/");

    in_user_area
        || matches!(
            extension,
            "csv" | "doc" | "docx" | "md" | "pdf" | "ppt" | "pptx" | "rtf" | "txt" | "xls" | "xlsx" | "jpg" | "jpeg" | "png" | "gif" | "webp" | "svg" | "psd" | "ai" | "mp3" | "wav" | "flac" | "mp4" | "mov" | "mkv"
        )
}

fn is_application_state_path_native(relative: &str, extension: &str) -> bool {
    let normalized = relative.replace('\\', "/").to_ascii_lowercase();
    let in_app_data = normalized.contains("/appdata/roaming/")
        || normalized.contains("/appdata/local/")
        || normalized.contains("/appdata/locallow/")
        || normalized.starts_with("appdata/roaming/")
        || normalized.starts_with("appdata/local/")
        || normalized.starts_with("appdata/locallow/")
        || normalized.contains("/programdata/")
        || normalized.starts_with("programdata/");

    in_app_data
        && matches!(
            extension,
            "cfg" | "conf" | "crt" | "dat" | "db" | "db3" | "ini" | "json" | "kdbx" | "key" | "ost" | "pem" | "pfx" | "plist" | "prefs" | "sqlite" | "sqlite3" | "wallet" | "xml" | "yaml" | "yml"
        )
}

fn preference_decision<'a>(preferences: &'a Value, relative: &str) -> Option<&'a str> {
    preferences
        .get("fileDecisions")
        .and_then(|value| value.get(relative))
        .and_then(|value| value.get("decision"))
        .and_then(Value::as_str)
}

fn preference_exempts_relative(preferences: &Value, relative: &str) -> bool {
    let Some(exemptions) = preferences
        .get("exemptDirectories")
        .and_then(Value::as_object)
    else {
        return false;
    };
    exemptions.keys().any(|directory| {
        let directory = normalize_preference_key(directory);
        !directory.is_empty() && (relative == directory || relative.starts_with(&format!("{directory}/")))
    })
}

fn normalize_preference_key(raw: &str) -> String {
    raw.replace('\\', "/")
        .trim_start_matches('/')
        .trim()
        .to_ascii_lowercase()
}

fn candidate_json_bytes(candidate: &Value) -> u64 {
    candidate
        .get("packageBytes")
        .and_then(Value::as_u64)
        .or_else(|| candidate.get("sizeBytes").and_then(Value::as_u64))
        .unwrap_or(0)
}

fn candidate_json_path(candidate: &Value) -> String {
    candidate
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn days_since_system_time(time: SystemTime) -> u64 {
    SystemTime::now()
        .duration_since(time)
        .unwrap_or(Duration::ZERO)
        .as_secs()
        / 86_400
}

fn format_bytes(bytes: u64) -> String {
    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit_index = 0usize;
    while value >= 1024.0 && unit_index < units.len() - 1 {
        value /= 1024.0;
        unit_index += 1;
    }
    let digits = if value >= 10.0 || unit_index == 0 { 0 } else { 1 };
    format!("{value:.digits$} {}", units[unit_index])
}

fn default_root_path() -> String {
    if cfg!(target_os = "windows") {
        env::var("SystemDrive")
            .map(|drive| format!("{}\\", drive.trim_end_matches('\\')))
            .unwrap_or_else(|_| String::from("C:\\"))
    } else {
        String::from("/")
    }
}

fn disk_status_value(root_path: &str) -> Result<Value, String> {
    let path = PathBuf::from(root_path);
    let resolved = fs::canonicalize(&path).unwrap_or(path);
    let (free_bytes, total_bytes) = if cfg!(target_os = "windows") {
        windows_disk_bytes(&resolved)?
    } else {
        unix_disk_bytes(&resolved)?
    };
    Ok(json!({
        "available": true,
        "rootPath": resolved.display().to_string(),
        "freeBytes": free_bytes,
        "totalBytes": total_bytes,
        "freeHuman": format_bytes(free_bytes),
        "totalHuman": format_bytes(total_bytes),
        "checkedAt": now_iso_like()
    }))
}

fn windows_disk_bytes(path: &Path) -> Result<(u64, u64), String> {
    let drive = path
        .components()
        .find_map(|component| match component {
            Component::Prefix(prefix) => match prefix.kind() {
                Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => {
                    Some((letter as char).to_ascii_uppercase().to_string())
                }
                _ => None,
            },
            _ => None,
        })
        .ok_or_else(|| String::from("Drive nao encontrado."))?;
    let script = format!(
        "$d=Get-PSDrive -Name '{}'; [Console]::WriteLine([string]$d.Free + ',' + [string]($d.Free + $d.Used))",
        drive
    );
    let output = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .output()
        .map_err(|error| format!("Disco indisponivel: {error}"))?;
    if !output.status.success() {
        return Err(String::from("Disco indisponivel."));
    }
    parse_disk_pair(&String::from_utf8_lossy(&output.stdout))
}

fn unix_disk_bytes(path: &Path) -> Result<(u64, u64), String> {
    let output = Command::new("df")
        .arg("-Pk")
        .arg(path)
        .output()
        .map_err(|error| format!("Disco indisponivel: {error}"))?;
    if !output.status.success() {
        return Err(String::from("Disco indisponivel."));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let line = text
        .lines()
        .nth(1)
        .ok_or_else(|| String::from("Disco indisponivel."))?;
    let parts: Vec<&str> = line.split_whitespace().collect();
    if parts.len() < 4 {
        return Err(String::from("Disco indisponivel."));
    }
    let total = parts[1].parse::<u64>().map_err(|_| String::from("Disco invalido."))? * 1024;
    let free = parts[3].parse::<u64>().map_err(|_| String::from("Disco invalido."))? * 1024;
    Ok((free, total))
}

fn parse_disk_pair(text: &str) -> Result<(u64, u64), String> {
    let line = text.trim();
    let mut parts = line.split(',').map(str::trim);
    let free = parts
        .next()
        .ok_or_else(|| String::from("Disco invalido."))?
        .parse::<u64>()
        .map_err(|_| String::from("Disco invalido."))?;
    let total = parts
        .next()
        .ok_or_else(|| String::from("Disco invalido."))?
        .parse::<u64>()
        .map_err(|_| String::from("Disco invalido."))?;
    Ok((free, total))
}

fn safe_relative_path(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err(String::from("Caminho absoluto nao e aceito pelo A.L.C."));
    }

    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return Err(String::from("Caminho relativo inseguro.")),
        }
    }

    if clean.as_os_str().is_empty() {
        return Err(String::from("Caminho vazio."));
    }

    Ok(clean)
}

fn unique_destination(base: &Path) -> PathBuf {
    if !base.exists() {
        return base.to_path_buf();
    }

    let parent = base.parent().unwrap_or_else(|| Path::new("."));
    let file_name = base
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("arquivo");

    for index in 1..10_000 {
        let candidate = parent.join(format!("{file_name}.maidspace-{index}"));
        if !candidate.exists() {
            return candidate;
        }
    }

    parent.join(format!("{file_name}.maidspace-final"))
}

fn move_file_to(
    source: &Path,
    destination: &Path,
    created_directories: &mut HashSet<PathBuf>,
) -> io::Result<()> {
    if let Some(parent) = destination.parent() {
        if created_directories.insert(parent.to_path_buf()) {
            fs::create_dir_all(parent)?;
        }
    }

    if ALC_CANCELLED.load(Ordering::Relaxed) {
        return Err(io::Error::new(io::ErrorKind::Interrupted, "Cancelado."));
    }

    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            copy_file_cancellable(source, destination).map_err(|copy_error| {
                io::Error::new(
                    copy_error.kind(),
                    format!("rename: {rename_error}; copy: {copy_error}"),
                )
            })?;

            if let Err(remove_error) = fs::remove_file(source) {
                let _ = fs::remove_file(destination);
                return Err(remove_error);
            }

            Ok(())
        }
    }
}

fn copy_file_cancellable(source: &Path, destination: &Path) -> io::Result<u64> {
    let mut input = fs::File::open(source)?;
    let mut output = fs::File::create(destination)?;
    let mut buffer = vec![0u8; ALC_COPY_BUFFER_BYTES];
    let mut written = 0u64;

    loop {
        if ALC_CANCELLED.load(Ordering::Relaxed) {
            let _ = fs::remove_file(destination);
            return Err(io::Error::new(io::ErrorKind::Interrupted, "Cancelado."));
        }
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        written = written.saturating_add(read as u64);
    }

    output.flush()?;
    Ok(written)
}

fn read_preferences_store() -> Result<Value, String> {
    let path = preferences_file_path();
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|error| format!("Preferencias MaidSpace invalidas: {error}")),
        Err(_) => Ok(json!({
            "schemaVersion": 1,
            "roots": {}
        })),
    }
}

fn write_preferences_store(store: &Value) -> Result<(), String> {
    let path = preferences_file_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Nao foi possivel criar banco de preferencias: {error}"))?;
    }
    fs::write(
        &path,
        serde_json::to_string_pretty(store)
            .map_err(|error| format!("Nao foi possivel serializar preferencias: {error}"))?,
    )
    .map_err(|error| format!("Nao foi possivel salvar preferencias: {error}"))
}

fn preferences_file_path() -> PathBuf {
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        return PathBuf::from(local_app_data)
            .join("MaidSpace")
            .join("preferences.json");
    }
    env::temp_dir().join("maidspace").join("preferences.json")
}

fn root_preferences_from_store(store: &Value, root_path: &str) -> Value {
    let root_key = preference_root_key(root_path);
    store
        .get("roots")
        .and_then(|roots| roots.get(&root_key))
        .cloned()
        .unwrap_or_else(|| {
            json!({
                "schemaVersion": 1,
                "fileDecisions": {},
                "exemptDirectories": {},
                "targetFreeBytes": 0u64,
                "minimumFreeBytes": 0u64,
                "updatedAt": null
            })
        })
}

fn ensure_preference_root(store: &mut Value, root_key: &str) {
    if !store.is_object() {
        *store = json!({ "schemaVersion": 1, "roots": {} });
    }
    if store.get("roots").and_then(Value::as_object).is_none() {
        store["roots"] = json!({});
    }
    if store["roots"].get(root_key).is_none() {
        store["roots"][root_key] = json!({
            "fileDecisions": {},
            "exemptDirectories": {},
            "targetFreeBytes": 0u64,
            "minimumFreeBytes": 0u64,
            "updatedAt": now_iso_like()
        });
    }
}

fn preference_root_key(root_path: &str) -> String {
    PathBuf::from(root_path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(root_path))
        .display()
        .to_string()
        .replace('\\', "/")
        .to_ascii_lowercase()
}

fn normalize_preference_relative(raw: &str) -> Result<String, String> {
    let clean = safe_relative_path(raw)?;
    Ok(clean.display().to_string().replace('\\', "/"))
}

fn now_iso_like() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("{seconds}")
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            maidspace_health,
            maidspace_disk,
            analyze_maidspace,
            analyze_add,
            pick_directory,
            load_preferences,
            save_file_decision,
            save_exempt_directories,
            save_target_preference,
            expand_alc_candidates,
            execute_alc_relocation,
            cancel_alc_relocation,
            reveal_in_explorer
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar MaidSpace");
}
