const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const CRITICAL_PATH_PATTERNS = [
  /^windows\/system32(\/|$)/,
  /^windows\/syswow64(\/|$)/,
  /^windows\/winsxs(\/|$)/,
  /^windows\/servicing(\/|$)/,
  /^windows\/systemresources(\/|$)/,
  /^windows\/security(\/|$)/,
  /^windows\/inf(\/|$)/,
  /^windows\/assembly(\/|$)/,
  /^programdata\/microsoft(\/|$)/,
  /^system volume information(\/|$)/,
  /^\$winreagent(\/|$)/,
  /^\$recycle\.bin(\/|$)/
];

const CODE_PROJECT_MARKERS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  "node_modules",
  "src-tauri",
  "src-core"
]);

const CODE_PROJECT_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".npmrc",
  ".yarnrc",
  "cargo.lock",
  "cargo.toml",
  "composer.lock",
  "dockerfile",
  "go.mod",
  "go.sum",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pyproject.toml",
  "requirements.txt",
  "tsconfig.json",
  "vite.config.js",
  "vite.config.ts",
  "webpack.config.js",
  "yarn.lock"
]);

const PERSONAL_SEGMENTS = new Set([
  "desktop",
  "documents",
  "documentos",
  "downloads",
  "pictures",
  "imagens",
  "videos",
  "vídeos",
  "music",
  "musicas",
  "músicas",
  "onedrive",
  "dropbox",
  "google drive",
  "icloud drive"
]);

const SAVE_SEGMENTS = new Set([
  "saves",
  "savegames",
  "saved games",
  "jogos salvos"
]);

function normalizeRelativePath(value) {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  const withoutDrive = raw.replace(/^[a-zA-Z]:\/?/, "");
  const normalized = path.posix.normalize(withoutDrive).replace(/^(\.\.\/)+/, "");
  return normalized === "." ? "" : normalized.replace(/^\/+/, "");
}

function protectedPathReason(relativePath, options = {}) {
  const relative = normalizeRelativePath(relativePath).toLowerCase();
  if (!relative) {
    return "caminho vazio";
  }

  if (CRITICAL_PATH_PATTERNS.some((pattern) => pattern.test(relative))) {
    return "diretorio critico do Windows ou do sistema";
  }

  const parts = relative.split("/").filter(Boolean);
  const fileName = parts.at(-1) || "";
  if (parts.some((part) => CODE_PROJECT_MARKERS.has(part)) || CODE_PROJECT_FILES.has(fileName)) {
    return "arquivo ou pasta de projeto protegido";
  }

  if (parts.some((part) => SAVE_SEGMENTS.has(part)) && !options.manualApproval) {
    return "save ou progresso de jogo exige selecao manual";
  }

  if (parts.some((part) => PERSONAL_SEGMENTS.has(part)) && !options.manualApproval) {
    return "conteudo pessoal exige selecao manual";
  }

  return null;
}

function isProtectedPath(relativePath, options = {}) {
  return Boolean(protectedPathReason(relativePath, options));
}

function effectiveActionForTargetKind(targetKind, options = {}) {
  const kind = String(targetKind || "directory").toLowerCase();
  if (kind === "directory") {
    return "move";
  }
  if (kind === "trash") {
    return "trash";
  }
  if (kind === "delete" && options.allowPermanentDelete === true) {
    return "delete_permanent";
  }
  return "quarantine";
}

function buildOperationItem(file = {}, context = {}) {
  const relativePath = normalizeRelativePath(file.relativePath || file.path);
  const manualApproval = Boolean(file.manualApproval || file.userApproved || file.userDecision?.action === "relocate");
  const protectionReason = protectedPathReason(relativePath, { manualApproval });
  const action = protectionReason
    ? "skip"
    : effectiveActionForTargetKind(context.targetKind, {
        allowPermanentDelete: context.allowPermanentDelete
      });
  const originalPath = context.rootPath && relativePath
    ? path.resolve(context.rootPath, relativePath)
    : relativePath;
  const plannedDestination = protectionReason
    ? null
    : plannedDestinationFor(relativePath, action, context);
  const sizeBytes = Number(file.sizeBytes ?? file.size ?? file.packageBytes ?? 0) || 0;

  return {
    id: file.id || stableItemId(relativePath),
    originalPath,
    relativePath,
    sizeBytes,
    action,
    proposedAction: action,
    reason: file.reason || file.justification || file.deletionDecision || "selecionado para limpeza",
    risk: file.risk || file.structuralRisk || null,
    plannedDestination,
    status: protectionReason ? "skipped" : "planned",
    error: protectionReason,
    finalPath: null,
    manualApproval
  };
}

function createOperationManifest(input = {}) {
  const timestamp = input.timestamp || new Date().toISOString();
  const operationId = input.operationId || createOperationId(timestamp);
  const items = (input.items || input.files || []).map((item) => {
    if (item.originalPath && item.action && item.status) {
      return { ...item };
    }
    return buildOperationItem(item, {
      ...input,
      operationId
    });
  });
  const plannedItems = items.filter((item) => item.status !== "skipped");
  const totalBytes = plannedItems.reduce((sum, item) => sum + Number(item.sizeBytes || 0), 0);

  return {
    schemaVersion: 1,
    operationId,
    timestamp,
    mode: input.dryRun ? "dry-run" : "real",
    rootPath: input.rootPath || null,
    targetKind: input.targetKind || null,
    effectiveAction: effectiveActionForTargetKind(input.targetKind, {
      allowPermanentDelete: input.allowPermanentDelete
    }),
    targetDirectory: input.targetDirectory || null,
    quarantineDirectory: input.quarantineDirectory || null,
    totalFiles: plannedItems.length,
    totalBytes,
    status: input.dryRun ? "planned" : "created",
    items
  };
}

function recordOperationResult(manifest, itemId, result = {}) {
  const item = manifest.items.find((candidate) => candidate.id === itemId || candidate.relativePath === itemId);
  if (!item) {
    return manifest;
  }
  item.status = result.status || item.status;
  item.finalPath = result.finalPath || item.finalPath || null;
  item.error = result.error || null;
  item.completedAt = result.completedAt || new Date().toISOString();
  manifest.status = "updated";
  return manifest;
}

async function writeOperationManifest(manifest, options = {}) {
  const directory = options.directory || operationLogDirectory();
  await fs.mkdir(directory, { recursive: true });
  const suffix = options.final ? "final" : "planned";
  const filePath = path.join(directory, `${manifest.operationId}.${suffix}.json`);
  await fs.writeFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return filePath;
}

function operationLogDirectory() {
  return path.join(maidspaceDataDirectory(), "operations");
}

function quarantineDirectoryFor(operationId) {
  return path.join(maidspaceDataDirectory(), "quarantine", operationId);
}

function maidspaceDataDirectory() {
  if (process.env.MAIDSPACE_DATA_DIR) {
    return path.resolve(process.env.MAIDSPACE_DATA_DIR);
  }
  return process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "MaidSpace")
    : path.join(os.tmpdir(), "MaidSpace");
}

function plannedDestinationFor(relativePath, action, context = {}) {
  if (action === "move") {
    return context.targetDirectory ? path.resolve(context.targetDirectory, relativePath) : null;
  }
  if (action === "quarantine") {
    const quarantine = context.quarantineDirectory || quarantineDirectoryFor(context.operationId || "manual");
    return path.join(quarantine, "files", relativePath);
  }
  if (action === "trash") {
    return "lixeira";
  }
  if (action === "delete_permanent") {
    return "exclusao_permanente";
  }
  return null;
}

function createOperationId(timestamp = new Date().toISOString()) {
  const base = String(timestamp).replace(/[^0-9A-Za-z]+/g, "-").replace(/^-|-$/g, "");
  return `${base}-${crypto.randomBytes(4).toString("hex")}`;
}

function stableItemId(relativePath) {
  return crypto.createHash("sha1").update(normalizeRelativePath(relativePath)).digest("hex").slice(0, 12);
}

module.exports = {
  buildOperationItem,
  createOperationId,
  createOperationManifest,
  effectiveActionForTargetKind,
  isProtectedPath,
  normalizeRelativePath,
  operationLogDirectory,
  protectedPathReason,
  quarantineDirectoryFor,
  recordOperationResult,
  writeOperationManifest
};
