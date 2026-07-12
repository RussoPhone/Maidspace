use anyhow::{anyhow, Context};
use rayon::prelude::*;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use walkdir::{DirEntry, WalkDir};

#[derive(Debug, Clone)]
pub struct AnalyzeOptions {
    pub max_files: usize,
    pub max_depth: usize,
    pub unused_days_threshold: u64,
    pub frequent_use_days_threshold: u64,
}

impl Default for AnalyzeOptions {
    fn default() -> Self {
        Self {
            max_files: 120_000,
            max_depth: 1024,
            unused_days_threshold: 30,
            frequent_use_days_threshold: 4,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct AddReport {
    pub algorithm: String,
    pub root_path: String,
    pub summary: Summary,
    pub files: Vec<FileDecision>,
}

#[derive(Debug, Serialize)]
pub struct Summary {
    pub files: usize,
    pub analyzed_files: usize,
    pub directories: usize,
    pub total_bytes: u64,
    pub analyzed_bytes: u64,
    pub inventory_reclaimable: InventoryReclaimable,
    pub can_delete: usize,
    pub probably_useless: usize,
    pub must_keep: usize,
    pub review: usize,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct InventoryReclaimable {
    pub baixo: ReclaimableBucket,
    pub medio: ReclaimableBucket,
    pub alto: ReclaimableBucket,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ReclaimableBucket {
    pub bytes: u64,
    pub files: usize,
}

impl ReclaimableBucket {
    fn add(&mut self, bytes: u64) {
        self.bytes = self.bytes.saturating_add(bytes);
        self.files += 1;
    }
}

#[derive(Debug, Serialize)]
pub struct FileDecision {
    pub path: String,
    pub extension: String,
    pub size: u64,
    pub days_since_access: u64,
    pub protected_reasons: Vec<String>,
    pub dependency_hint: DependencyHint,
    pub utility_status: UtilityStatus,
    pub deletion_decision: DeletionDecision,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DependencyHint {
    None,
    Low,
    Medium,
    High,
    Uncertain,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum UtilityStatus {
    System,
    Protected,
    UsedByUser,
    DependencyRelevant,
    LowUse,
    ProbablyUseless,
    Uncertain,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeletionDecision {
    CanDelete,
    ProbablyUseless,
    Review,
    DoNotDelete,
}

pub fn analyze_directory(root: &Path, options: AnalyzeOptions) -> anyhow::Result<AddReport> {
    let root = root
        .canonicalize()
        .with_context(|| format!("Diretorio nao encontrado: {}", root.display()))?;

    if !root.is_dir() {
        return Err(anyhow!(
            "O caminho informado nao e um diretorio: {}",
            root.display()
        ));
    }

    let mut directories = 0usize;
    let mut total_files = 0usize;
    let mut total_bytes = 0u64;
    let mut inventory_reclaimable = InventoryReclaimable::default();
    let mut file_paths = Vec::new();

    for entry in WalkDir::new(&root)
        .max_depth(options.max_depth)
        .into_iter()
        .filter_entry(|entry| should_enter(entry))
    {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };

        if entry.file_type().is_dir() {
            directories += 1;
            continue;
        }

        if entry.file_type().is_file() {
            total_files += 1;
            if let Ok(metadata) = entry.metadata() {
                let bytes = metadata.len();
                total_bytes = total_bytes.saturating_add(bytes);
                let relative = entry
                    .path()
                    .strip_prefix(&root)
                    .unwrap_or(entry.path())
                    .to_string_lossy()
                    .replace('\\', "/");
                let extension = entry
                    .path()
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let days_since_access = metadata
                    .accessed()
                    .ok()
                    .map(days_since)
                    .unwrap_or(options.unused_days_threshold + 1);
                add_inventory_estimate(
                    &mut inventory_reclaimable,
                    entry.path(),
                    &relative,
                    &extension,
                    bytes,
                    days_since_access,
                    &options,
                );
            }
            if file_paths.len() < options.max_files {
                file_paths.push(entry.path().to_path_buf());
            }
        }
    }

    let provider_names = build_provider_name_index(&file_paths);
    let files: Vec<FileDecision> = file_paths
        .par_iter()
        .filter_map(|path| analyze_file(&root, path, &provider_names, &options).ok())
        .collect();

    let summary = Summary {
        files: total_files,
        analyzed_files: files.len(),
        directories: directories.saturating_sub(1),
        total_bytes,
        analyzed_bytes: files.iter().map(|file| file.size).sum(),
        inventory_reclaimable,
        can_delete: files
            .iter()
            .filter(|file| file.deletion_decision == DeletionDecision::CanDelete)
            .count(),
        probably_useless: files
            .iter()
            .filter(|file| file.deletion_decision == DeletionDecision::ProbablyUseless)
            .count(),
        must_keep: files
            .iter()
            .filter(|file| file.deletion_decision == DeletionDecision::DoNotDelete)
            .count(),
        review: files
            .iter()
            .filter(|file| file.deletion_decision == DeletionDecision::Review)
            .count(),
    };

    Ok(AddReport {
        algorithm: "Grafo".to_string(),
        root_path: root.display().to_string(),
        summary,
        files,
    })
}

fn analyze_file(
    root: &Path,
    path: &Path,
    provider_names: &HashSet<String>,
    options: &AnalyzeOptions,
) -> anyhow::Result<FileDecision> {
    let metadata = fs::metadata(path)?;
    let relative = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let days_since_access = metadata
        .accessed()
        .ok()
        .map(days_since)
        .unwrap_or(options.unused_days_threshold + 1);
    let protected_reasons = protected_reasons(path, &relative);
    let dependency_hint = dependency_hint(path, &extension, provider_names);
    let utility_status = utility_status(
        &protected_reasons,
        dependency_hint,
        days_since_access,
        &relative,
        &extension,
        options,
    );
    let deletion_decision = deletion_decision(utility_status, dependency_hint);

    Ok(FileDecision {
        path: relative,
        extension,
        size: metadata.len(),
        days_since_access,
        protected_reasons,
        dependency_hint,
        utility_status,
        deletion_decision,
    })
}

fn add_inventory_estimate(
    inventory: &mut InventoryReclaimable,
    path: &Path,
    relative: &str,
    extension: &str,
    bytes: u64,
    days_since_access: u64,
    options: &AnalyzeOptions,
) {
    if bytes == 0 || is_strict_system_file(path, relative, extension) {
        return;
    }

    let low_value = is_low_value_path(relative, extension);
    let archive_or_installer = is_archive_or_installer(extension);
    let bulky_user_file = is_bulky_user_file(relative, extension);
    let application_state = is_application_state_path(relative, extension) && !low_value;
    let stale = days_since_access >= options.unused_days_threshold;
    let not_hot = days_since_access > options.frequent_use_days_threshold;

    if low_value && stale {
        inventory.baixo.add(bytes);
    }

    if not_hot
        && !application_state
        && (low_value || (archive_or_installer && stale) || (bulky_user_file && stale))
        && !protected_file_name(path)
    {
        inventory.medio.add(bytes);
    }

    inventory.alto.add(bytes);
}

fn is_strict_system_file(path: &Path, relative: &str, extension: &str) -> bool {
    let absolute = path.to_string_lossy().to_ascii_lowercase();
    let relative = relative.to_ascii_lowercase();
    matches!(extension, "sys" | "reg") || is_strict_system_path(&absolute, &relative)
}

fn is_low_value_path(relative: &str, extension: &str) -> bool {
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

fn is_bulky_user_file(relative: &str, extension: &str) -> bool {
    let normalized = relative.replace('\\', "/").to_ascii_lowercase();
    matches!(
        extension,
        "zip"
            | "7z"
            | "rar"
            | "tar"
            | "gz"
            | "xz"
            | "iso"
            | "dmg"
            | "msi"
            | "mp4"
            | "mov"
            | "mkv"
            | "avi"
            | "webm"
            | "mp3"
            | "wav"
            | "flac"
            | "jpg"
            | "jpeg"
            | "png"
            | "webp"
    ) || normalized.contains("/backup/")
        || normalized.contains("/backups/")
        || normalized.contains("/archives/")
}

fn is_archive_or_installer(extension: &str) -> bool {
    matches!(
        extension,
        "zip"
            | "7z"
            | "rar"
            | "tar"
            | "gz"
            | "xz"
            | "iso"
            | "dmg"
            | "msi"
            | "exe"
            | "pkg"
            | "deb"
            | "rpm"
    )
}

fn is_user_content_path(relative: &str, extension: &str) -> bool {
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
            "csv"
                | "doc"
                | "docx"
                | "md"
                | "pdf"
                | "ppt"
                | "pptx"
                | "rtf"
                | "txt"
                | "xls"
                | "xlsx"
                | "jpg"
                | "jpeg"
                | "png"
                | "gif"
                | "webp"
                | "svg"
                | "psd"
                | "ai"
                | "mp3"
                | "wav"
                | "flac"
                | "mp4"
                | "mov"
                | "mkv"
        )
}

fn is_application_state_path(relative: &str, extension: &str) -> bool {
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
            "cfg"
                | "conf"
                | "crt"
                | "dat"
                | "db"
                | "db3"
                | "ini"
                | "json"
                | "kdbx"
                | "key"
                | "ost"
                | "pem"
                | "pfx"
                | "plist"
                | "prefs"
                | "sqlite"
                | "sqlite3"
                | "wallet"
                | "xml"
                | "yaml"
                | "yml"
        )
}

fn should_enter(entry: &DirEntry) -> bool {
    let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
    !matches!(
        name.as_str(),
        "$winreagent"
            | "$windows.~bt"
            | "$windows.~ws"
            | "recovery"
            | "system32"
            | "syswow64"
            | "winsxs"
            | "windowsapps"
            | "system volume information"
    )
}

fn build_provider_name_index(paths: &[PathBuf]) -> HashSet<String> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for path in paths {
        if let Some(stem) = path.file_stem().and_then(|value| value.to_str()) {
            *counts.entry(stem.to_ascii_lowercase()).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .filter_map(|(name, count)| (count > 1).then_some(name))
        .collect()
}

fn dependency_hint(
    path: &Path,
    extension: &str,
    provider_names: &HashSet<String>,
) -> DependencyHint {
    if protected_file_name(path) {
        return DependencyHint::High;
    }

    if matches!(
        extension,
        "dll"
            | "exe"
            | "sys"
            | "so"
            | "dylib"
            | "lock"
            | "toml"
            | "json"
            | "db"
            | "sqlite"
            | "sqlite3"
            | "dat"
            | "ini"
            | "cfg"
            | "conf"
            | "pem"
            | "key"
    ) {
        return DependencyHint::Medium;
    }

    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if provider_names.contains(&stem) {
        return DependencyHint::Medium;
    }

    if matches!(extension, "tmp" | "log" | "bak" | "old" | "cache") {
        return DependencyHint::Low;
    }

    DependencyHint::None
}

fn utility_status(
    protected_reasons: &[String],
    dependency_hint: DependencyHint,
    days_since_access: u64,
    relative: &str,
    extension: &str,
    options: &AnalyzeOptions,
) -> UtilityStatus {
    if protected_reasons
        .iter()
        .any(|reason| reason.contains("sistema") || reason.contains("executavel"))
    {
        return UtilityStatus::System;
    }
    if !protected_reasons.is_empty() {
        return UtilityStatus::Protected;
    }
    let low_value = is_low_value_path(relative, extension);
    let user_content = is_user_content_path(relative, extension);
    let application_state = is_application_state_path(relative, extension) && !low_value;

    if days_since_access <= options.frequent_use_days_threshold {
        return UtilityStatus::UsedByUser;
    }
    if low_value && days_since_access >= options.unused_days_threshold {
        return UtilityStatus::ProbablyUseless;
    }
    if application_state {
        return UtilityStatus::DependencyRelevant;
    }
    if matches!(
        dependency_hint,
        DependencyHint::High | DependencyHint::Medium
    ) {
        return UtilityStatus::DependencyRelevant;
    }
    if user_content && days_since_access >= options.unused_days_threshold {
        return UtilityStatus::LowUse;
    }
    if user_content {
        return UtilityStatus::Uncertain;
    }
    if days_since_access >= options.unused_days_threshold && dependency_hint == DependencyHint::None
    {
        return UtilityStatus::ProbablyUseless;
    }
    if days_since_access >= options.unused_days_threshold {
        return UtilityStatus::LowUse;
    }
    UtilityStatus::Uncertain
}

fn deletion_decision(
    utility_status: UtilityStatus,
    dependency_hint: DependencyHint,
) -> DeletionDecision {
    match utility_status {
        UtilityStatus::System | UtilityStatus::Protected | UtilityStatus::UsedByUser => {
            DeletionDecision::DoNotDelete
        }
        UtilityStatus::ProbablyUseless => DeletionDecision::CanDelete,
        UtilityStatus::LowUse if dependency_hint == DependencyHint::Low => {
            DeletionDecision::ProbablyUseless
        }
        UtilityStatus::DependencyRelevant | UtilityStatus::LowUse | UtilityStatus::Uncertain => {
            DeletionDecision::Review
        }
    }
}

fn protected_reasons(path: &Path, relative: &str) -> Vec<String> {
    let mut reasons = Vec::new();
    let absolute = path.to_string_lossy().to_ascii_lowercase();
    let relative = relative.to_ascii_lowercase();

    if protected_file_name(path) {
        reasons.push("arquivo de configuracao/lock".to_string());
    }

    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if matches!(extension.as_str(), "sys" | "reg") {
        reasons.push("arquivo essencial do sistema".to_string());
    } else if matches!(
        extension.as_str(),
        "exe" | "dll" | "msi" | "bat" | "cmd" | "ps1" | "so" | "dylib"
    ) && is_strict_system_path(&absolute, &relative)
    {
        reasons.push("binario em diretorio critico do sistema".to_string());
    }

    if is_strict_system_path(&absolute, &relative) {
        reasons.push("diretorio critico do sistema".to_string());
    }

    reasons.sort();
    reasons.dedup();
    reasons
}

fn is_strict_system_path(absolute: &str, relative: &str) -> bool {
    let normalized_absolute = absolute.replace('\\', "/");
    let normalized_relative = relative.replace('\\', "/");
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
        "/windows/",
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
            | "package.json"
            | "package-lock.json"
            | "pnpm-lock.yaml"
            | "yarn.lock"
            | "cargo.toml"
            | "cargo.lock"
            | "pyproject.toml"
            | "requirements.txt"
            | "go.mod"
            | "go.sum"
            | "tsconfig.json"
            | "dockerfile"
    )
}

fn days_since(time: SystemTime) -> u64 {
    SystemTime::now()
        .duration_since(time)
        .unwrap_or(Duration::ZERO)
        .as_secs()
        / 86_400
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn inventory_estimate_counts_program_files_but_not_windows() {
        let root = std::env::temp_dir().join(format!(
            "maidspace-rust-estimate-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::ZERO)
                .as_nanos()
        ));
        fs::create_dir_all(root.join("Program Files (x86)").join("Steam")).unwrap();
        fs::create_dir_all(root.join("Windows").join("Fonts")).unwrap();
        fs::create_dir_all(root.join("Users").join("demo").join("Videos")).unwrap();

        create_sized_file(
            &root
                .join("Program Files (x86)")
                .join("Steam")
                .join("game.dat"),
            20 * 1024 * 1024,
        );
        create_sized_file(
            &root.join("Windows").join("Fonts").join("system.dat"),
            30 * 1024 * 1024,
        );
        create_sized_file(
            &root
                .join("Users")
                .join("demo")
                .join("Videos")
                .join("clip.mp4"),
            10 * 1024 * 1024,
        );

        let report = analyze_directory(
            &root,
            AnalyzeOptions {
                max_files: 1,
                max_depth: 16,
                unused_days_threshold: 30,
                frequent_use_days_threshold: 4,
            },
        )
        .unwrap();

        assert_eq!(report.summary.total_bytes, 60 * 1024 * 1024);
        assert!(report.summary.analyzed_bytes < report.summary.total_bytes);
        assert_eq!(
            report.summary.inventory_reclaimable.alto.bytes,
            30 * 1024 * 1024
        );
        assert_eq!(report.summary.inventory_reclaimable.alto.files, 2);

        fs::remove_dir_all(root).ok();
    }

    #[test]
    fn user_content_and_app_state_are_not_safe_delete() {
        let options = AnalyzeOptions {
            max_files: 100,
            max_depth: 16,
            unused_days_threshold: 30,
            frequent_use_days_threshold: 4,
        };

        let user_doc = utility_status(
            &[],
            DependencyHint::None,
            90,
            "Users/demo/Downloads/notes.txt",
            "txt",
            &options,
        );
        assert_eq!(user_doc, UtilityStatus::LowUse);
        assert_ne!(
            deletion_decision(user_doc, DependencyHint::None),
            DeletionDecision::CanDelete
        );

        let app_state = utility_status(
            &[],
            DependencyHint::Medium,
            90,
            "Users/demo/AppData/Roaming/Editor/profile.sqlite",
            "sqlite",
            &options,
        );
        assert_eq!(app_state, UtilityStatus::DependencyRelevant);
        assert_eq!(
            deletion_decision(app_state, DependencyHint::Medium),
            DeletionDecision::Review
        );

        let temp_file = utility_status(
            &[],
            DependencyHint::Low,
            90,
            "Users/demo/AppData/Local/Temp/cache.tmp",
            "tmp",
            &options,
        );
        assert_eq!(temp_file, UtilityStatus::ProbablyUseless);
        assert_eq!(
            deletion_decision(temp_file, DependencyHint::Low),
            DeletionDecision::CanDelete
        );
    }

    fn create_sized_file(path: &Path, bytes: u64) {
        let file = File::create(path).unwrap();
        file.set_len(bytes).unwrap();
    }
}
