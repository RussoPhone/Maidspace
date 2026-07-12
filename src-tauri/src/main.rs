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
static SCAN_CANCELLED: AtomicBool = AtomicBool::new(false);

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
    dry_run: Option<bool>,
    allow_permanent_delete: Option<bool>,
    audit_source: Option<String>,
    audit_manifest_path: Option<String>,
    audited_item_count: Option<usize>,
    audit_fingerprint: Option<String>,
    wave_bytes: Option<u64>,
    planned_wave_count: Option<usize>,
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
    risk: Option<String>,
    reason: Option<String>,
    deletion_decision: Option<String>,
    planned_destination: Option<String>,
    manual_approval: Option<bool>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AlcRelocationReport {
    target_kind: String,
    effective_action: String,
    dry_run: bool,
    target_directory: Option<String>,
    quarantine_directory: Option<String>,
    manifest_path: Option<String>,
    final_manifest_path: Option<String>,
    manifest_used_path: Option<String>,
    audit_source: String,
    audit_manifest_path: Option<String>,
    audited_item_count: usize,
    audit_fingerprint: Option<String>,
    volume_info: Value,
    requested_files: usize,
    planned_files: usize,
    moved_files: usize,
    failed_files: usize,
    skipped_files: usize,
    cancelled_files: usize,
    cancelled: bool,
    planned_bytes: u64,
    moved_bytes: u64,
    wave_bytes: u64,
    wave_count: usize,
    waves_completed: usize,
    stage_timings: Value,
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
    id: String,
    relative_path: String,
    original_path: Option<String>,
    size_bytes: u64,
    status: String,
    action: String,
    reason: String,
    risk: Option<String>,
    planned_destination: Option<String>,
    target_path: Option<String>,
    user_content: bool,
    error: Option<String>,
}

const MAX_OPERATION_REPORTS: usize = 5_000;
const ALC_TRASH_BATCH_SIZE: usize = 256;
const ALC_PROGRESS_FILE_INTERVAL: usize = 64;
const ALC_PROGRESS_TIME_INTERVAL: Duration = Duration::from_millis(250);
const ALC_COPY_BUFFER_BYTES: usize = 8 * 1024 * 1024;
const ALC_DEFAULT_WAVE_BYTES: u64 = 50 * 1024 * 1024 * 1024;
const SCAN_PROGRESS_FILE_INTERVAL: u64 = 128;
const SCAN_PROGRESS_TIME_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Default, Clone)]
struct ScanJobProgress {
    files: u64,
    directories: u64,
    bytes: u64,
    skipped: u64,
    warnings: u64,
    errors: u64,
    cancelled: bool,
    current_file: Option<String>,
}

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

#[tauri::command(rename_all = "camelCase")]
fn start_scan_job(
    app: AppHandle,
    root_path: String,
    target_free_bytes: Option<u64>,
    minimum_free_bytes: Option<u64>,
) -> Result<String, String> {
    let root = fs::canonicalize(&root_path)
        .map_err(|error| format!("Nao foi possivel acessar a raiz: {error}"))?;
    if !root.is_dir() {
        return Err(format!("A raiz nao e um diretorio: {}", root.display()));
    }

    let job_id = operation_id();
    let thread_job_id = job_id.clone();
    SCAN_CANCELLED.store(false, Ordering::Relaxed);
    std::thread::spawn(move || {
        run_scan_job_thread(
            app,
            thread_job_id,
            root,
            target_free_bytes.unwrap_or(0),
            minimum_free_bytes.unwrap_or(0),
        );
    });
    Ok(job_id)
}

#[tauri::command(rename_all = "camelCase")]
fn cancel_scan_job(_job_id: Option<String>) -> Result<(), String> {
    SCAN_CANCELLED.store(true, Ordering::Relaxed);
    Ok(())
}

fn run_scan_job_thread(
    app: AppHandle,
    job_id: String,
    root: PathBuf,
    target_free_bytes: u64,
    minimum_free_bytes: u64,
) {
    let started_at = Instant::now();
    emit_scan_progress(
        &app,
        &job_id,
        "scanning",
        None,
        &ScanJobProgress::default(),
        0,
        0,
        started_at,
        false,
        "Varrendo arquivos",
        None,
        None,
    );

    let scan_started = Instant::now();
    let inventory = scan_for_job_progress(&app, &job_id, &root, started_at);
    let scanning_seconds = scan_started.elapsed().as_secs_f64();

    if inventory.cancelled || SCAN_CANCELLED.load(Ordering::Relaxed) {
        let mut final_report = scan_final_report_json(
            "cancelado",
            &inventory,
            started_at,
            scanning_seconds,
            0.0,
            None,
        );
        attach_scan_log(&job_id, &mut final_report);
        emit_scan_progress(
            &app,
            &job_id,
            "cancelled",
            inventory.current_file.as_deref(),
            &inventory,
            inventory.files,
            inventory.bytes,
            started_at,
            true,
            "Varredura cancelada com seguranca",
            None,
            Some(final_report),
        );
        return;
    }

    emit_scan_progress(
        &app,
        &job_id,
        "analyzing",
        inventory.current_file.as_deref(),
        &inventory,
        inventory.files,
        inventory.bytes,
        started_at,
        true,
        "Analisando riscos e plano",
        None,
        None,
    );

    let analyze_started = Instant::now();
    let report = match analyze_directory(&root, AnalyzeOptions::default()) {
        Ok(report) => report,
        Err(error) => {
            let mut failed = inventory.clone();
            failed.errors = failed.errors.saturating_add(1);
            let mut final_report = scan_final_report_json(
                "falhou",
                &failed,
                started_at,
                scanning_seconds,
                analyze_started.elapsed().as_secs_f64(),
                Some(&error.to_string()),
            );
            attach_scan_log(&job_id, &mut final_report);
            emit_scan_progress(
                &app,
                &job_id,
                "failed",
                failed.current_file.as_deref(),
                &failed,
                failed.files,
                failed.bytes,
                started_at,
                true,
                "Falha na analise local",
                None,
                Some(final_report),
            );
            return;
        }
    };
    let analyzing_seconds = analyze_started.elapsed().as_secs_f64();

    if SCAN_CANCELLED.load(Ordering::Relaxed) {
        let mut final_report = scan_final_report_json(
            "cancelado",
            &inventory,
            started_at,
            scanning_seconds,
            analyzing_seconds,
            None,
        );
        attach_scan_log(&job_id, &mut final_report);
        emit_scan_progress(
            &app,
            &job_id,
            "cancelled",
            inventory.current_file.as_deref(),
            &inventory,
            inventory.files,
            inventory.bytes,
            started_at,
            true,
            "Cancelado apos a etapa atual",
            None,
            Some(final_report),
        );
        return;
    }

    let disk_status = disk_status_value(&report.root_path).unwrap_or_else(|error| json!({
        "available": false,
        "error": error
    }));
    let result = json!({
        "mode": "local_tauri_job",
        "targetFreeBytes": target_free_bytes,
        "minimumFreeBytes": minimum_free_bytes,
        "diskStatus": disk_status,
        "report": report
    });
    let mut final_report = scan_final_report_json(
        "concluido",
        &inventory,
        started_at,
        scanning_seconds,
        analyzing_seconds,
        None,
    );
    attach_scan_log(&job_id, &mut final_report);
    emit_scan_progress(
        &app,
        &job_id,
        "finished",
        inventory.current_file.as_deref(),
        &inventory,
        inventory.files,
        inventory.bytes,
        started_at,
        true,
        "Varredura concluida",
        Some(result),
        Some(final_report),
    );
}

fn scan_for_job_progress(
    app: &AppHandle,
    job_id: &str,
    root: &Path,
    started_at: Instant,
) -> ScanJobProgress {
    let mut progress = ScanJobProgress::default();
    let mut stack = VecDeque::new();
    let mut last_emit = Instant::now()
        .checked_sub(SCAN_PROGRESS_TIME_INTERVAL)
        .unwrap_or_else(Instant::now);
    stack.push_back(root.to_path_buf());

    while let Some(directory) = stack.pop_back() {
        if SCAN_CANCELLED.load(Ordering::Relaxed) {
            progress.cancelled = true;
            break;
        }
        progress.directories = progress.directories.saturating_add(1);
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                progress.skipped = progress.skipped.saturating_add(1);
                progress.warnings = progress.warnings.saturating_add(1);
                continue;
            }
        };

        for entry in entries {
            if SCAN_CANCELLED.load(Ordering::Relaxed) {
                progress.cancelled = true;
                break;
            }
            let entry = match entry {
                Ok(entry) => entry,
                Err(_) => {
                    progress.skipped = progress.skipped.saturating_add(1);
                    progress.warnings = progress.warnings.saturating_add(1);
                    continue;
                }
            };
            let file_type = match entry.file_type() {
                Ok(file_type) => file_type,
                Err(_) => {
                    progress.skipped = progress.skipped.saturating_add(1);
                    progress.warnings = progress.warnings.saturating_add(1);
                    continue;
                }
            };

            if file_type.is_dir() {
                stack.push_back(entry.path());
            } else if file_type.is_file() {
                progress.files = progress.files.saturating_add(1);
                progress.current_file = Some(entry.path().display().to_string());
                match entry.metadata() {
                    Ok(metadata) => {
                        progress.bytes = progress.bytes.saturating_add(metadata.len());
                    }
                    Err(_) => {
                        progress.skipped = progress.skipped.saturating_add(1);
                        progress.warnings = progress.warnings.saturating_add(1);
                    }
                }
            } else {
                progress.skipped = progress.skipped.saturating_add(1);
            }

            if progress.files % SCAN_PROGRESS_FILE_INTERVAL == 0
                || last_emit.elapsed() >= SCAN_PROGRESS_TIME_INTERVAL
            {
                emit_scan_progress(
                    app,
                    job_id,
                    "scanning",
                    progress.current_file.as_deref(),
                    &progress,
                    0,
                    0,
                    started_at,
                    false,
                    "Varrendo arquivos",
                    None,
                    None,
                );
                last_emit = Instant::now();
            }
        }
    }

    emit_scan_progress(
        app,
        job_id,
        if progress.cancelled { "cancelled" } else { "scanning" },
        progress.current_file.as_deref(),
        &progress,
        progress.files,
        progress.bytes,
        started_at,
        true,
        if progress.cancelled {
            "Cancelamento solicitado"
        } else {
            "Inventario inicial concluido"
        },
        None,
        None,
    );
    progress
}

fn emit_scan_progress(
    app: &AppHandle,
    job_id: &str,
    stage: &str,
    current_file: Option<&str>,
    progress: &ScanJobProgress,
    total_files: u64,
    total_bytes: u64,
    started_at: Instant,
    total_known: bool,
    message: &str,
    result: Option<Value>,
    final_report: Option<Value>,
) {
    let elapsed_seconds = started_at.elapsed().as_secs_f64();
    let speed = if elapsed_seconds > 0.0 {
        progress.bytes as f64 / elapsed_seconds
    } else {
        0.0
    };
    let percent = if total_known && total_bytes > 0 {
        ((progress.bytes as f64 / total_bytes as f64) * 100.0).clamp(0.0, 100.0)
    } else if total_known && total_files > 0 {
        ((progress.files as f64 / total_files as f64) * 100.0).clamp(0.0, 100.0)
    } else {
        0.0
    };
    let estimated_remaining_seconds = if percent > 0.0 && percent < 100.0 {
        Some(elapsed_seconds * ((100.0 - percent) / percent))
    } else {
        None
    };
    let mut payload = json!({
        "jobId": job_id,
        "stage": stage,
        "currentFile": current_file.unwrap_or(""),
        "processedFiles": progress.files,
        "totalFiles": total_files,
        "totalKnown": total_known,
        "processedBytes": progress.bytes,
        "totalBytes": total_bytes,
        "elapsedSeconds": elapsed_seconds,
        "estimatedRemainingSeconds": estimated_remaining_seconds,
        "currentSpeedBytesPerSecond": speed,
        "warningsCount": progress.warnings,
        "skippedCount": progress.skipped,
        "errorsCount": progress.errors,
        "percent": percent,
        "message": message,
        "cancelled": progress.cancelled || SCAN_CANCELLED.load(Ordering::Relaxed),
    });
    if let Some(result) = result {
        payload["result"] = result;
    }
    if let Some(final_report) = final_report {
        payload["finalReport"] = final_report;
    }
    let _ = app.emit("scan-progress", payload);
}

fn scan_final_report_json(
    status: &str,
    progress: &ScanJobProgress,
    started_at: Instant,
    scanning_seconds: f64,
    analyzing_seconds: f64,
    error: Option<&str>,
) -> Value {
    let total_seconds = started_at.elapsed().as_secs_f64();
    json!({
        "status": status,
        "filesAnalyzed": progress.files,
        "filesProcessed": progress.files,
        "filesMoved": 0,
        "filesSkipped": progress.skipped,
        "errors": progress.errors,
        "warnings": progress.warnings,
        "processedBytes": progress.bytes,
        "processedHuman": format_bytes(progress.bytes),
        "totalSeconds": total_seconds,
        "stageTimings": {
            "scanning": scanning_seconds,
            "analyzing": analyzing_seconds,
            "moving": 0.0,
            "quarantining": 0.0,
            "logging": 0.0,
            "total": total_seconds
        },
        "averageSpeedBytesPerSecond": if total_seconds > 0.0 {
            progress.bytes as f64 / total_seconds
        } else {
            0.0
        },
        "logPath": null,
        "error": error
    })
}

fn attach_scan_log(job_id: &str, report: &mut Value) {
    if let Err(error) = write_scan_final_report(job_id, report) {
        report["logError"] = json!(error);
    }
}

fn write_scan_final_report(job_id: &str, report: &mut Value) -> Result<(), String> {
    let logging_started = Instant::now();
    let directory = operation_log_dir();
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Nao foi possivel criar diretorio de log: {error}"))?;
    let path = directory.join(format!("{job_id}-scan-report.json"));
    report["logPath"] = json!(path.display().to_string());
    let first_pass = serde_json::to_string_pretty(report)
        .map_err(|error| format!("Nao foi possivel serializar relatorio: {error}"))?;
    fs::write(&path, format!("{first_pass}\n"))
        .map_err(|error| format!("Nao foi possivel gravar relatorio: {error}"))?;
    let logging_seconds = logging_started.elapsed().as_secs_f64();
    report["stageTimings"]["logging"] = json!(logging_seconds);
    let total = report["totalSeconds"].as_f64().unwrap_or(0.0) + logging_seconds;
    report["stageTimings"]["total"] = json!(total);
    let final_pass = serde_json::to_string_pretty(report)
        .map_err(|error| format!("Nao foi possivel serializar relatorio final: {error}"))?;
    fs::write(&path, format!("{final_pass}\n"))
        .map_err(|error| format!("Nao foi possivel atualizar relatorio: {error}"))?;
    Ok(())
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
                "Expansao da limpeza interrompida por limite de tempo; candidatos parciais mantidos.",
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
                stop_reason = Some(format!("Expansao da limpeza parou em {limit} candidato(s)."));
                break;
            }
            if target_bytes > 0 && bytes >= target_bytes {
                stop_reason = Some(format!(
                    "Expansao da limpeza atingiu {} para meta {}.",
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
    let operation_started = Instant::now();
    let planning_started = Instant::now();
    let root = fs::canonicalize(&request.root_path)
        .map_err(|error| format!("Nao foi possivel acessar a raiz: {error}"))?;
    if !root.is_dir() {
        return Err(format!("A raiz nao e um diretorio: {}", root.display()));
    }

    let target_kind = request.target_kind.trim().to_ascii_lowercase();
    if target_kind != "directory"
        && target_kind != "trash"
        && target_kind != "delete"
        && target_kind != "quarantine"
    {
        return Err(String::from("Destino de limpeza invalido."));
    }
    let dry_run = request.dry_run.unwrap_or(false);
    let allow_permanent_delete = request.allow_permanent_delete.unwrap_or(false);
    let effective_action = effective_alc_action(&target_kind, allow_permanent_delete);
    if request.expand_plan.unwrap_or(false) && !dry_run {
        return Err(String::from(
            "Expanda ou simule o plano antes de executar; a execucao real exige lista auditavel no manifesto.",
        ));
    }
    let operation_id = operation_id();
    let quarantine_root = if effective_action == "quarantine" {
        Some(quarantine_directory(&operation_id))
    } else {
        None
    };

    let target_directory = if target_kind == "directory" {
        let value = request
            .target_directory
            .as_ref()
            .map(|path| path.trim())
            .filter(|path| !path.is_empty())
            .ok_or_else(|| String::from("Escolha uma pasta de destino para a limpeza."))?;
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
    } else if let Some(quarantine) = quarantine_root.as_ref() {
        Some(quarantine.join("files"))
    } else {
        None
    };

    let files = request.files.clone();
    let requested_preview_bytes = files
        .iter()
        .fold(0u64, |sum, file| sum.saturating_add(file.size.unwrap_or(0)));
    let target_bytes = request.target_bytes.unwrap_or(0);
    let wave_bytes = request.wave_bytes.unwrap_or(ALC_DEFAULT_WAVE_BYTES).max(1);
    let requested_wave_count = request.planned_wave_count.unwrap_or(1).max(1);
    let should_expand_plan = false;

    let mut report = AlcRelocationReport {
        target_kind: target_kind.clone(),
        effective_action: effective_action.clone(),
        dry_run,
        target_directory: target_directory
            .as_ref()
            .map(|path| path.display().to_string()),
        quarantine_directory: quarantine_root
            .as_ref()
            .map(|path| path.display().to_string()),
        manifest_path: None,
        final_manifest_path: None,
        manifest_used_path: None,
        audit_source: request
            .audit_source
            .clone()
            .unwrap_or_else(|| if dry_run { String::from("simulation") } else { String::from("direct") }),
        audit_manifest_path: request.audit_manifest_path.clone(),
        audited_item_count: request.audited_item_count.unwrap_or(files.len()),
        audit_fingerprint: request.audit_fingerprint.clone(),
        volume_info: volume_info_for_relocation(&root, target_directory.as_deref()),
        requested_files: 0,
        planned_files: 0,
        moved_files: 0,
        failed_files: 0,
        skipped_files: 0,
        cancelled_files: 0,
        cancelled: false,
        planned_bytes: 0,
        moved_bytes: 0,
        wave_bytes,
        wave_count: requested_wave_count,
        waves_completed: 0,
        stage_timings: json!({}),
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
    let manifest = operation_manifest_json(
        &operation_id,
        &root,
        &target_kind,
        &effective_action,
        dry_run,
        target_directory.as_deref(),
        quarantine_root.as_deref(),
        &files,
        &[],
    );
    report.manifest_path = Some(write_operation_manifest(&operation_id, false, &manifest)?);
    report.manifest_used_path = report.manifest_path.clone();
    let planning_seconds = planning_started.elapsed().as_secs_f64();
    let execution_started = Instant::now();

    let mut trash_batch = Vec::with_capacity(ALC_TRASH_BATCH_SIZE);
    let mut created_directories = HashSet::new();

    for (index, file) in files.into_iter().enumerate() {
        if ALC_CANCELLED.load(Ordering::Relaxed) {
            report.cancelled = true;
            break;
        }

        if let Some(prepared) = prepare_alc_file(&root, file, &mut report, &mut seen) {
            report.planned_files += 1;
            report.planned_bytes = report.planned_bytes.saturating_add(prepared.operation.size_bytes);
            if dry_run {
                mark_prepared_planned(prepared, &mut report);
            } else if effective_action == "trash" {
                trash_batch.push(prepared);
                if trash_batch.len() >= ALC_TRASH_BATCH_SIZE {
                    flush_trash_batch(&mut trash_batch, &mut report);
                }
            } else if effective_action == "delete_permanent" {
                delete_prepared_file(prepared, &mut report);
            } else {
                move_prepared_file_to_directory(
                    target_directory.as_deref(),
                    prepared,
                    &mut report,
                    &mut created_directories,
                    if effective_action == "quarantine" {
                        Some("quarantined")
                    } else {
                        None
                    },
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

    if dry_run || report.cancelled || ALC_CANCELLED.load(Ordering::Relaxed) {
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
    let planned_for_waves = report.planned_bytes.max(progress_target_bytes);
    let estimated_wave_count = if planned_for_waves == 0 {
        1
    } else {
        (planned_for_waves
            .saturating_add(report.wave_bytes.saturating_sub(1))
            / report.wave_bytes) as usize
    };
    report.wave_count = report.wave_count.max(estimated_wave_count).max(1);
    report.waves_completed = if dry_run {
        0
    } else if report.cancelled {
        ((report.moved_bytes / report.wave_bytes) as usize).min(report.wave_count)
    } else {
        report.wave_count
    };
    let execution_seconds = execution_started.elapsed().as_secs_f64();
    let logging_started = Instant::now();
    let final_manifest = operation_manifest_json(
        &operation_id,
        &root,
        &target_kind,
        &effective_action,
        dry_run,
        target_directory.as_deref(),
        quarantine_root.as_deref(),
        &[],
        &report.operations,
    );
    report.final_manifest_path = Some(write_operation_manifest(&operation_id, true, &final_manifest)?);
    report.manifest_used_path = report
        .final_manifest_path
        .clone()
        .or_else(|| report.manifest_path.clone());
    report.audited_item_count = report.planned_files;
    let logging_seconds = logging_started.elapsed().as_secs_f64();
    let mut moving_seconds = 0.0;
    let mut deleting_seconds = 0.0;
    let mut quarantining_seconds = 0.0;
    if !dry_run {
        if effective_action == "delete_permanent" {
            deleting_seconds = execution_seconds;
        } else if effective_action == "quarantine" {
            quarantining_seconds = execution_seconds;
        } else {
            moving_seconds = execution_seconds;
        }
    }
    report.stage_timings = json!({
        "planning": planning_seconds,
        "moving": moving_seconds,
        "deleting": deleting_seconds,
        "quarantining": quarantining_seconds,
        "logging": logging_seconds,
        "total": operation_started.elapsed().as_secs_f64()
    });
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

#[tauri::command(rename_all = "camelCase")]
fn reveal_system_path(path: String) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err(String::from("Caminho vazio."));
    }
    let reveal_target = if target.exists() {
        target
    } else {
        target
            .parent()
            .map(Path::to_path_buf)
            .ok_or_else(|| String::from("Caminho sem pasta pai."))?
    };

    if cfg!(target_os = "windows") {
        Command::new("explorer")
            .arg(reveal_target.display().to_string())
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
            .map_err(|error| format!("Nao foi possivel abrir o gerenciador de arquivos: {error}"))?;
    }

    Ok(())
}

fn prepare_alc_file(
    root: &Path,
    file: AlcFileSelection,
    report: &mut AlcRelocationReport,
    seen: &mut HashSet<String>,
) -> Option<PreparedAlcFile> {
    let operation_id = item_id_for(&file.relative_path);
    let mut operation = AlcOperationReport {
        id: operation_id,
        relative_path: file.relative_path.clone(),
        original_path: None,
        size_bytes: file.size.unwrap_or(0),
        status: String::from("error"),
        action: String::from("planned"),
        reason: file
            .reason
            .clone()
            .or(file.deletion_decision.clone())
            .unwrap_or_else(|| String::from("selecionado para limpeza")),
        risk: file.risk.clone(),
        planned_destination: file.planned_destination.clone(),
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
    if let Some(reason) = protected_operation_reason(&relative_key, &file) {
        operation.status = String::from("skipped");
        operation.error = Some(reason);
        report.skipped_files += 1;
        push_operation_report(report, operation);
        return None;
    }
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

    operation.original_path = Some(source.display().to_string());
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
        operation.error = Some(String::from("A limpeza move apenas arquivos."));
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
    success_action: Option<&str>,
) {
    let PreparedAlcFile {
        source,
        relative,
        mut operation,
    } = prepared;
    let Some(target_root) = target_directory else {
        operation.error = Some(String::from("Destino de limpeza ausente."));
        report.failed_files += 1;
        push_operation_report(report, operation);
        return;
    };
    let destination = unique_destination(&target_root.join(&relative));
    let result = move_file_to(&source, &destination, created_directories)
        .map(|_| {
            operation.status = String::from("success");
            operation.action = success_action.unwrap_or("moved").to_string();
            operation.target_path = Some(destination.display().to_string());
            operation.planned_destination = operation.target_path.clone();
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
                operation.status = String::from("error");
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
            operation.status = String::from("success");
            operation.action = String::from("delete_permanent");
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
    operation.status = String::from("success");
    operation.action = String::from("trashed");
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
    operation.status = String::from("error");
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

fn mark_prepared_planned(prepared: PreparedAlcFile, report: &mut AlcRelocationReport) {
    let mut operation = prepared.operation;
    operation.status = String::from("planned");
    operation.action = report.effective_action.clone();
    if operation.planned_destination.is_none() {
        operation.planned_destination = planned_destination_from_report(report, &operation.relative_path);
    }
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
                    risk: None,
                    reason: Some(String::from("expansao local de limpeza")),
                    deletion_decision: None,
                    planned_destination: None,
                    manual_approval: None,
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
                    None,
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
            "waveBytes": report.wave_bytes,
            "waveCount": report.wave_count,
            "cancelled": report.cancelled || ALC_CANCELLED.load(Ordering::Relaxed)
        }),
    );
}

fn effective_alc_action(target_kind: &str, allow_permanent_delete: bool) -> String {
    match target_kind {
        "directory" => String::from("move"),
        "trash" => String::from("trash"),
        "delete" if allow_permanent_delete => String::from("delete_permanent"),
        _ => String::from("quarantine"),
    }
}

fn volume_info_for_relocation(root: &Path, target_directory: Option<&Path>) -> Value {
    let source_root = path_volume_root(root);
    let destination_root = target_directory.and_then(path_volume_root);
    let known = source_root.is_some() && destination_root.is_some();
    let same_volume = known
        && source_root.as_ref().map(|item| item.to_ascii_lowercase())
            == destination_root.as_ref().map(|item| item.to_ascii_lowercase());
    json!({
        "known": known,
        "sameVolume": if known { Value::Bool(same_volume) } else { Value::Null },
        "sourceRoot": source_root,
        "destinationRoot": destination_root,
        "message": if !known {
            "destino gerenciado pelo sistema, quarentena ou volume nao confirmado"
        } else if same_volume {
            "mesmo volume: move/rename tende a ser rapido"
        } else {
            "volumes diferentes: copia e remocao podem demorar mais"
        }
    })
}

fn path_volume_root(path: &Path) -> Option<String> {
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                return Some(prefix.as_os_str().to_string_lossy().to_string());
            }
            Component::RootDir => return Some(String::from("/")),
            _ => {}
        }
    }
    None
}

fn operation_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("op-{millis}-{}", std::process::id())
}

fn maidspace_data_dir() -> PathBuf {
    if let Ok(custom_dir) = env::var("MAIDSPACE_DATA_DIR") {
        return PathBuf::from(custom_dir);
    }
    if let Ok(local_app_data) = env::var("LOCALAPPDATA") {
        return PathBuf::from(local_app_data).join("MaidSpace");
    }
    env::temp_dir().join("MaidSpace")
}

fn operation_log_dir() -> PathBuf {
    maidspace_data_dir().join("operations")
}

fn quarantine_directory(operation_id: &str) -> PathBuf {
    maidspace_data_dir().join("quarantine").join(operation_id)
}

fn write_operation_manifest(
    operation_id: &str,
    final_manifest: bool,
    manifest: &Value,
) -> Result<String, String> {
    let directory = operation_log_dir();
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Nao foi possivel criar pasta de manifestos: {error}"))?;
    let suffix = if final_manifest { "final" } else { "planned" };
    let path = directory.join(format!("{operation_id}.{suffix}.json"));
    let text = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("Nao foi possivel serializar manifesto: {error}"))?;
    fs::write(&path, format!("{text}\n"))
        .map_err(|error| format!("Nao foi possivel salvar manifesto: {error}"))?;
    Ok(path.display().to_string())
}

fn operation_manifest_json(
    operation_id: &str,
    root: &Path,
    target_kind: &str,
    effective_action: &str,
    dry_run: bool,
    target_directory: Option<&Path>,
    quarantine_root: Option<&Path>,
    files: &[AlcFileSelection],
    operations: &[AlcOperationReport],
) -> Value {
    let items: Vec<Value> = if operations.is_empty() {
        files
            .iter()
            .map(|file| {
                let relative = normalize_preference_key(&file.relative_path);
                let protected = protected_operation_reason(&relative, file);
                let action = if protected.is_some() {
                    String::from("skip")
                } else {
                    effective_action.to_string()
                };
                json!({
                    "id": item_id_for(&relative),
                    "originalPath": root.join(&relative).display().to_string(),
                    "relativePath": relative,
                    "sizeBytes": file.size.unwrap_or(0),
                    "action": action,
                    "proposedAction": action,
                    "reason": file.reason.clone().or(file.deletion_decision.clone()).unwrap_or_else(|| String::from("selecionado para limpeza")),
                    "risk": file.risk.clone(),
                    "plannedDestination": planned_destination_for_manifest(&relative, effective_action, target_directory, quarantine_root),
                    "status": if protected.is_some() { "skipped" } else { "planned" },
                    "error": protected,
                    "finalPath": Value::Null,
                    "manualApproval": file.manual_approval.unwrap_or(false)
                })
            })
            .collect()
    } else {
        operations.iter().map(operation_to_manifest_item).collect()
    };
    let planned_items: Vec<&Value> = items
        .iter()
        .filter(|item| item.get("status").and_then(Value::as_str) != Some("skipped"))
        .collect();
    let total_bytes = planned_items.iter().fold(0u64, |sum, item| {
        sum.saturating_add(item.get("sizeBytes").and_then(Value::as_u64).unwrap_or(0))
    });

    json!({
        "schemaVersion": 1,
        "operationId": operation_id,
        "timestamp": now_iso_like(),
        "mode": if dry_run { "dry-run" } else { "real" },
        "rootPath": root.display().to_string(),
        "targetKind": target_kind,
        "effectiveAction": effective_action,
        "targetDirectory": target_directory.map(|path| path.display().to_string()),
        "quarantineDirectory": quarantine_root.map(|path| path.display().to_string()),
        "totalFiles": planned_items.len(),
        "totalBytes": total_bytes,
        "status": if operations.is_empty() { "created" } else { "completed" },
        "items": items
    })
}

fn operation_to_manifest_item(operation: &AlcOperationReport) -> Value {
    json!({
        "id": operation.id,
        "originalPath": operation.original_path,
        "relativePath": operation.relative_path,
        "sizeBytes": operation.size_bytes,
        "action": operation.action,
        "proposedAction": operation.action,
        "reason": operation.reason,
        "risk": operation.risk,
        "plannedDestination": operation.planned_destination,
        "status": operation.status,
        "error": operation.error,
        "finalPath": operation.target_path,
        "manualApproval": Value::Null
    })
}

fn planned_destination_for_manifest(
    relative: &str,
    action: &str,
    target_directory: Option<&Path>,
    quarantine_root: Option<&Path>,
) -> Option<String> {
    match action {
        "move" => target_directory.map(|path| path.join(relative).display().to_string()),
        "quarantine" => quarantine_root.map(|path| path.join("files").join(relative).display().to_string()),
        "trash" => Some(String::from("lixeira")),
        "delete_permanent" => Some(String::from("exclusao_permanente")),
        _ => None,
    }
}

fn planned_destination_from_report(report: &AlcRelocationReport, relative: &str) -> Option<String> {
    match report.effective_action.as_str() {
        "move" => report
            .target_directory
            .as_ref()
            .map(|directory| PathBuf::from(directory).join(relative).display().to_string()),
        "quarantine" => report
            .quarantine_directory
            .as_ref()
            .map(|directory| PathBuf::from(directory).join("files").join(relative).display().to_string()),
        "trash" => Some(String::from("lixeira")),
        "delete_permanent" => Some(String::from("exclusao_permanente")),
        _ => None,
    }
}

fn item_id_for(relative: &str) -> String {
    let normalized = normalize_preference_key(relative);
    let mut id = String::from("item-");
    for ch in normalized.chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch);
        } else {
            id.push('-');
        }
    }
    id
}

fn protected_operation_reason(relative: &str, file: &AlcFileSelection) -> Option<String> {
    let normalized = normalize_preference_key(relative);
    if normalized.is_empty() {
        return Some(String::from("caminho vazio"));
    }
    if is_strict_system_path("", &normalized)
        || [
            "windows/system32/",
            "windows/syswow64/",
            "windows/winsxs/",
            "windows/servicing/",
            "windows/systemresources/",
            "windows/security/",
            "windows/inf/",
            "windows/assembly/",
            "programdata/microsoft/",
            "system volume information/",
            "$winreagent/",
            "$recycle.bin/",
        ]
        .iter()
        .any(|prefix| normalized.starts_with(prefix))
    {
        return Some(String::from("diretorio critico do Windows ou do sistema"));
    }
    let parts: Vec<&str> = normalized.split('/').filter(|part| !part.is_empty()).collect();
    if parts
        .iter()
        .any(|part| matches!(*part, ".git" | ".hg" | ".svn" | ".idea" | ".vscode" | "node_modules"))
        || protected_file_name(Path::new(&normalized))
    {
        return Some(String::from("arquivo ou pasta de projeto protegido"));
    }
    let manual = file.manual_approval.unwrap_or(false);
    if parts
        .iter()
        .any(|part| matches!(*part, "saves" | "savegames" | "saved games" | "jogos salvos"))
        && !manual
    {
        return Some(String::from("save ou progresso de jogo exige selecao manual"));
    }
    let personal = parts.iter().any(|part| {
        matches!(
            *part,
            "desktop"
                | "documents"
                | "documentos"
                | "downloads"
                | "pictures"
                | "imagens"
                | "videos"
                | "music"
                | "musicas"
                | "onedrive"
                | "dropbox"
                | "google drive"
                | "icloud drive"
        )
    });
    if (file.user_content.unwrap_or(false) || personal) && !manual {
        return Some(String::from("conteudo pessoal exige selecao manual"));
    }
    None
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
        "baixo" => "inventario local: cache, temporario ou log antigo",
        "medio" => "inventario local: pacote, instalador ou gerado de baixo uso",
        _ if is_user_content_path_native(relative, extension) => {
            "inventario local: conteudo grande ou antigo para revisao"
        }
        _ => "inventario local: candidato do nivel alto",
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
        return Err(String::from("Caminho absoluto nao e aceito na limpeza."));
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
            start_scan_job,
            cancel_scan_job,
            pick_directory,
            load_preferences,
            save_file_decision,
            save_exempt_directories,
            save_target_preference,
            expand_alc_candidates,
            execute_alc_relocation,
            cancel_alc_relocation,
            reveal_in_explorer,
            reveal_system_path
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar MaidSpace");
}
