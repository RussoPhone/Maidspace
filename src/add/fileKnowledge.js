const fs = require("node:fs");
const path = require("node:path");

const knowledgePath = path.resolve(__dirname, "../../data/add-file-knowledge.json");

let cachedKnowledge = null;

function loadFileKnowledge() {
  if (cachedKnowledge) {
    return cachedKnowledge;
  }

  try {
    cachedKnowledge = JSON.parse(fs.readFileSync(knowledgePath, "utf8"));
  } catch (error) {
    cachedKnowledge = fallbackKnowledge();
  }

  return cachedKnowledge;
}

const ARCHIVE_EXTENSIONS = new Set([
  ".7z",
  ".bak",
  ".gz",
  ".iso",
  ".old",
  ".rar",
  ".tar",
  ".tgz",
  ".zip"
]);

const EXECUTABLE_EXTENSIONS = new Set([
  ".bat",
  ".cmd",
  ".dll",
  ".dylib",
  ".exe",
  ".msi",
  ".ps1",
  ".sh",
  ".so",
  ".sys"
]);

const SOURCE_EXTENSIONS = new Set([
  ".astro",
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".json",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rs",
  ".scss",
  ".svelte",
  ".ts",
  ".tsx",
  ".vue",
  ".xml",
  ".yaml",
  ".yml"
]);

const DOCUMENT_EXTENSIONS = new Set([
  ".csv",
  ".doc",
  ".docx",
  ".md",
  ".pdf",
  ".ppt",
  ".pptx",
  ".rtf",
  ".tsv",
  ".txt",
  ".xls",
  ".xlsx"
]);

const MEDIA_EXTENSIONS = new Set([
  ".ai",
  ".flac",
  ".gif",
  ".jpeg",
  ".jpg",
  ".mkv",
  ".mov",
  ".mp3",
  ".mp4",
  ".png",
  ".psd",
  ".raw",
  ".svg",
  ".wav",
  ".webp"
]);

const LOW_VALUE_EXTENSIONS = new Set([
  ".cache",
  ".chk",
  ".crdownload",
  ".dmp",
  ".log",
  ".old",
  ".part",
  ".temp",
  ".tmp"
]);

const TEMPORARY_DOWNLOAD_EXTENSIONS = new Set([
  ".crdownload",
  ".part",
  ".tmp"
]);

const APPLICATION_STATE_EXTENSIONS = new Set([
  ".cfg",
  ".conf",
  ".crt",
  ".dat",
  ".db",
  ".db3",
  ".ini",
  ".json",
  ".kdbx",
  ".key",
  ".ost",
  ".pem",
  ".pfx",
  ".plist",
  ".prefs",
  ".sqlite",
  ".sqlite3",
  ".wallet",
  ".xml",
  ".yaml",
  ".yml"
]);

const BROAD_APPLICATION_PATHS = [
  "program files/",
  "program files (x86)/"
];

const STRICT_SYSTEM_PATH_FRAGMENTS = [
  "programdata/microsoft/",
  "system volume information/",
  "windowsapps/",
  "$winreagent/",
  "system32/",
  "syswow64/",
  "winsxs/",
  "recovery/",
  "windows/assembly/",
  "windows/diagnostics/",
  "windows/inf/",
  "windows/security/",
  "windows/servicing/",
  "windows/system32/",
  "windows/systemresources/",
  "windows/syswow64/",
  "windows/winsxs/"
];

function classifyFileKnowledge(relativePath, fileName, extension, metadata = {}) {
  const knowledge = loadFileKnowledge();
  const normalizedPath = normalizePath(relativePath);
  const normalizedName = String(fileName || "").toLowerCase();
  const normalizedExtension = String(extension || "").toLowerCase();
  const size = Number(metadata.size || 0);
  const typeCategory = typeCategoryFor(normalizedName, normalizedExtension);
  const pathSignals = detectPathSignals(normalizedPath, normalizedName, normalizedExtension, typeCategory);

  const categories = [];
  for (const [key, bucket] of Object.entries(knowledge)) {
    if (!bucket || typeof bucket !== "object") {
      continue;
    }
    if (matchesBucket(key, bucket, normalizedPath, normalizedName, normalizedExtension)) {
      categories.push(key);
    }
  }
  if (isBroadApplicationPath(normalizedPath)) {
    categories.push("installedApplication");
  }
  if (pathSignals.isKnownUserFolder) {
    categories.push("knownUserFolder");
  }
  if (pathSignals.isCloudUserContent) {
    categories.push("cloudUserContent");
  }
  if (pathSignals.isApplicationState) {
    categories.push("applicationState");
  }
  if (pathSignals.isTemporaryDownload) {
    categories.push("temporaryDownload");
  }

  const riskCategory = riskCategoryFor(categories, typeCategory, pathSignals);
  const lastUseBucket = ageBucket(metadata.lastAccessedAt || metadata.accessedAt || metadata.modifiedAt);
  const createdBucket = ageBucket(metadata.createdAt || metadata.birthtime || metadata.modifiedAt);
  const modifiedBucket = ageBucket(metadata.modifiedAt);
  const sizeBucket = sizeBucketFor(size);
  const dependencyGroup = [
    "dpn",
    riskCategory,
    typeCategory,
    normalizedExtension || "sem_ext",
    lastUseBucket,
    createdBucket
  ].join(":");

  return {
    categories,
    isSystemEssential: categories.includes("systemEssential"),
    isProjectDependency: categories.includes("projectDependency"),
    isUserContent: categories.includes("userContent") || pathSignals.isKnownUserFolder || pathSignals.isCloudUserContent,
    isLowValueGenerated: categories.includes("lowValueGenerated") || typeCategory === "baixo_valor" || pathSignals.isTemporaryDownload,
    isInstalledApplication: categories.includes("installedApplication"),
    isKnownUserFolder: pathSignals.isKnownUserFolder,
    isCloudUserContent: pathSignals.isCloudUserContent,
    isApplicationState: pathSignals.isApplicationState,
    isTemporaryDownload: pathSignals.isTemporaryDownload,
    isArchive: typeCategory === "arquivo_compactado",
    isExecutable: typeCategory === "executavel",
    isSourceCode: typeCategory === "codigo_fonte",
    typeCategory,
    riskCategory,
    dependencyGroup,
    lastUseBucket,
    createdBucket,
    modifiedBucket,
    sizeBucket,
    recentUse: knowledge.recentUse || fallbackKnowledge().recentUse
  };
}

function typeCategoryFor(normalizedName, normalizedExtension) {
  if (EXECUTABLE_EXTENSIONS.has(normalizedExtension)) {
    return "executavel";
  }
  if (ARCHIVE_EXTENSIONS.has(normalizedExtension)) {
    return "arquivo_compactado";
  }
  if (SOURCE_EXTENSIONS.has(normalizedExtension) || ["dockerfile", "makefile"].includes(normalizedName)) {
    return "codigo_fonte";
  }
  if (DOCUMENT_EXTENSIONS.has(normalizedExtension)) {
    return "documento_usuario";
  }
  if (MEDIA_EXTENSIONS.has(normalizedExtension)) {
    return "midia_usuario";
  }
  if (LOW_VALUE_EXTENSIONS.has(normalizedExtension)) {
    return "baixo_valor";
  }
  return "desconhecido";
}

function riskCategoryFor(categories, typeCategory, pathSignals = {}) {
  if (categories.includes("systemEssential")) {
    return "sistema";
  }
  if (pathSignals.isApplicationState && typeCategory !== "baixo_valor") {
    return "estado_aplicativo";
  }
  if (categories.includes("installedApplication") || typeCategory === "executavel") {
    return "aplicativo_instalado";
  }
  if (categories.includes("projectDependency") || typeCategory === "codigo_fonte") {
    return "dependencia";
  }
  if (categories.includes("lowValueGenerated") || typeCategory === "baixo_valor") {
    return "gerado_baixo_valor";
  }
  if (categories.includes("userContent") || typeCategory === "documento_usuario" || typeCategory === "midia_usuario") {
    return "conteudo_usuario";
  }
  if (typeCategory === "arquivo_compactado") {
    return "arquivo_pesado";
  }
  return "incerto";
}

function detectPathSignals(normalizedPath, normalizedName, normalizedExtension, typeCategory) {
  const isKnownUserFolder = isKnownUserFolderPath(normalizedPath);
  const isCloudUserContent = isCloudUserContentPath(normalizedPath);
  const isAppDataPath = isApplicationDataPath(normalizedPath);
  const isGeneratedPath = isGeneratedPathLike(normalizedPath);
  const isTemporaryDownload = TEMPORARY_DOWNLOAD_EXTENSIONS.has(normalizedExtension)
    && (isKnownUserFolder || /(^|\/)(downloads?|temp|tmp)(\/|$)/.test(normalizedPath) || typeCategory === "baixo_valor");
  const isApplicationState = isAppDataPath
    && !isGeneratedPath
    && !isTemporaryDownload
    && (
      APPLICATION_STATE_EXTENSIONS.has(normalizedExtension)
      || !["arquivo_compactado", "baixo_valor", "midia_usuario"].includes(typeCategory)
    );

  return {
    isKnownUserFolder,
    isCloudUserContent,
    isApplicationState,
    isTemporaryDownload,
    isGeneratedPath,
    normalizedName
  };
}

function ageBucket(value) {
  const date = value instanceof Date ? value : new Date(value || 0);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "idade_desconhecida";
  }

  const days = Math.floor((Date.now() - timestamp) / 86400000);
  if (!Number.isFinite(days) || days < 0) {
    return "futuro";
  }
  if (days <= 1) {
    return "0_1d";
  }
  if (days <= 7) {
    return "2_7d";
  }
  if (days <= 30) {
    return "8_30d";
  }
  if (days <= 180) {
    return "31_180d";
  }
  if (days <= 365) {
    return "181_365d";
  }
  return "365d_plus";
}

function sizeBucketFor(size) {
  if (!Number.isFinite(size) || size <= 0) {
    return "0b";
  }
  if (size < 1024 * 1024) {
    return "ate_1mb";
  }
  if (size < 100 * 1024 * 1024) {
    return "1_100mb";
  }
  if (size < 1024 * 1024 * 1024) {
    return "100mb_1gb";
  }
  return "1gb_plus";
}

function matchesBucket(key, bucket, normalizedPath, normalizedName, normalizedExtension) {
  const nameMatch = includes(bucket.names, normalizedName);
  const extensionMatch = includes(bucket.extensions, normalizedExtension);
  const pathMatch = (bucket.pathFragments || []).some((fragment) => normalizedPath.includes(normalizePath(fragment)));

  if (key === "systemEssential") {
    const strictSystemPath = isStrictSystemPath(normalizedPath);
    const broadApplicationPathOnly = !strictSystemPath
      && BROAD_APPLICATION_PATHS.some((fragment) => normalizedPath.includes(fragment));
    return nameMatch
      || (extensionMatch && strictSystemPath)
      || (pathMatch && !broadApplicationPathOnly);
  }

  if (key === "projectDependency") {
    return nameMatch
      || pathMatch
      || (extensionMatch && looksProjectLike(normalizedPath));
  }

  return nameMatch || extensionMatch || pathMatch;
}

function includes(items, value) {
  return Array.isArray(items) && items.map((item) => String(item).toLowerCase()).includes(value);
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function isStrictSystemPath(normalizedPath) {
  return STRICT_SYSTEM_PATH_FRAGMENTS.some((fragment) => normalizedPath.includes(fragment));
}

function isBroadApplicationPath(normalizedPath) {
  return BROAD_APPLICATION_PATHS.some((fragment) => normalizedPath.includes(fragment));
}

function isKnownUserFolderPath(normalizedPath) {
  return /(^|\/)((users\/[^/]+\/)?(desktop|documents|downloads|pictures|videos|music|favorites|contacts|saved games|links))(\/|$)/.test(normalizedPath);
}

function isCloudUserContentPath(normalizedPath) {
  return /(^|\/)((users\/[^/]+\/)?(onedrive|dropbox|google drive|icloud drive|box|mega))(\/|$)/.test(normalizedPath);
}

function isApplicationDataPath(normalizedPath) {
  return /(^|\/)((users\/[^/]+\/)?appdata\/(roaming|local|locallow)|programdata)(\/|$)/.test(normalizedPath);
}

function isGeneratedPathLike(normalizedPath) {
  return /(^|\/)(cache|caches|tmp|temp|logs?|\.cache|crashdumps|dumps|shadercache|webcache|code cache|gpucache)(\/|$)/.test(normalizedPath);
}

function looksProjectLike(normalizedPath) {
  return /(^|\/)(\.git|\.hg|\.svn|node_modules|vendor|\.venv|venv|target|obj|bin|src|source)(\/|$)/.test(normalizedPath);
}

function fallbackKnowledge() {
  return {
    recentUse: {
      frequentWindowDays: 7,
      unusedWindowDays: 30
    }
  };
}

module.exports = {
  classifyFileKnowledge,
  loadFileKnowledge
};
