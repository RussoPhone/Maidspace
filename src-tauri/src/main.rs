use add_core::{analyze_directory, AnalyzeOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AlcRelocationRequest {
    root_path: String,
    target_kind: String,
    target_directory: Option<String>,
    files: Vec<AlcFileSelection>,
}

#[derive(Debug, Deserialize)]
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
    moved_bytes: u64,
    operations: Vec<AlcOperationReport>,
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
            "includeProgramFiles": true
        }
    })
}

#[tauri::command(rename_all = "camelCase")]
fn analyze_maidspace(root_path: String, target_free_bytes: Option<u64>) -> Result<Value, String> {
    let report = analyze_directory(&PathBuf::from(root_path), AnalyzeOptions::default())
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "mode": "local_tauri",
        "targetFreeBytes": target_free_bytes.unwrap_or(0),
        "report": report
    }))
}

#[tauri::command(rename_all = "camelCase")]
fn analyze_add(root_path: String) -> Result<Value, String> {
    analyze_maidspace(root_path, None)
}

#[tauri::command]
fn pick_directory() -> Result<Option<String>, String> {
    Ok(rfd::FileDialog::new()
        .pick_folder()
        .map(|path| path.display().to_string()))
}

#[tauri::command(rename_all = "camelCase")]
fn execute_alc_relocation(request: AlcRelocationRequest) -> Result<AlcRelocationReport, String> {
    let root = fs::canonicalize(&request.root_path)
        .map_err(|error| format!("Nao foi possivel acessar a raiz: {error}"))?;
    if !root.is_dir() {
        return Err(format!("A raiz nao e um diretorio: {}", root.display()));
    }

    let target_kind = request.target_kind.trim().to_ascii_lowercase();
    if target_kind != "directory" && target_kind != "trash" {
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

    let requested_files = request.files.len();
    let mut report = AlcRelocationReport {
        target_kind: target_kind.clone(),
        target_directory: target_directory
            .as_ref()
            .map(|path| path.display().to_string()),
        requested_files,
        moved_files: 0,
        failed_files: 0,
        skipped_files: 0,
        moved_bytes: 0,
        operations: Vec::with_capacity(requested_files),
    };

    for file in request.files {
        let mut operation = AlcOperationReport {
            relative_path: file.relative_path.clone(),
            size_bytes: file.size.unwrap_or(0),
            status: String::from("failed"),
            target_path: None,
            user_content: file.user_content.unwrap_or(false),
            error: None,
        };

        let relative = match safe_relative_path(&file.relative_path) {
            Ok(path) => path,
            Err(error) => {
                operation.error = Some(error);
                report.failed_files += 1;
                report.operations.push(operation);
                continue;
            }
        };

        let source = match fs::canonicalize(root.join(&relative)) {
            Ok(path) => path,
            Err(error) => {
                operation.error = Some(format!("Arquivo indisponivel: {error}"));
                report.failed_files += 1;
                report.operations.push(operation);
                continue;
            }
        };

        if !source.starts_with(&root) {
            operation.error = Some(String::from("Arquivo fora da raiz varrida."));
            report.failed_files += 1;
            report.operations.push(operation);
            continue;
        }

        let metadata = match fs::metadata(&source) {
            Ok(metadata) => metadata,
            Err(error) => {
                operation.error = Some(format!("Falha ao ler metadados: {error}"));
                report.failed_files += 1;
                report.operations.push(operation);
                continue;
            }
        };

        if !metadata.is_file() {
            operation.status = String::from("skipped");
            operation.error = Some(String::from("A.L.C MVP move apenas arquivos."));
            report.skipped_files += 1;
            report.operations.push(operation);
            continue;
        }

        operation.size_bytes = metadata.len();

        let result = if target_kind == "trash" {
            trash::delete(&source)
                .map(|_| {
                    operation.status = String::from("trashed");
                    operation.target_path = Some(String::from("lixeira"));
                })
                .map_err(|error| error.to_string())
        } else {
            let target_root = target_directory
                .as_ref()
                .expect("target_directory should exist for directory target");
            let destination = unique_destination(&target_root.join(&relative));
            move_file_to(&source, &destination)
                .map(|_| {
                    operation.status = String::from("moved");
                    operation.target_path = Some(destination.display().to_string());
                })
                .map_err(|error| error.to_string())
        };

        match result {
            Ok(()) => {
                report.moved_files += 1;
                report.moved_bytes = report.moved_bytes.saturating_add(operation.size_bytes);
            }
            Err(error) => {
                operation.status = String::from("failed");
                operation.error = Some(error);
                report.failed_files += 1;
            }
        }

        report.operations.push(operation);
    }

    Ok(report)
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

fn move_file_to(source: &Path, destination: &Path) -> io::Result<()> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent)?;
    }

    match fs::rename(source, destination) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            fs::copy(source, destination).map_err(|copy_error| {
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            maidspace_health,
            analyze_maidspace,
            analyze_add,
            pick_directory,
            execute_alc_relocation
        ])
        .run(tauri::generate_context!())
        .expect("erro ao iniciar MaidSpace");
}
