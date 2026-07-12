const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { classifyFileKnowledge } = require("../add/fileKnowledge");

const PROTECTED_FILE_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".gitignore",
  ".npmrc",
  ".yarnrc",
  "cargo.lock",
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

const PROTECTED_EXTENSIONS = new Set([
  ".bat",
  ".cmd",
  ".dll",
  ".dylib",
  ".exe",
  ".msi",
  ".ps1",
  ".reg",
  ".sh",
  ".so",
  ".sys"
]);

const SYSTEM_PROTECTED_EXTENSIONS = new Set([
  ".reg",
  ".sys"
]);

const TEXT_EXTENSIONS = new Set([
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
  ".less",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rs",
  ".scss",
  ".svelte",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
  ".md"
]);

const SPECIAL_TEXT_FILES = new Set([
  "dockerfile",
  "makefile",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle"
]);

const DEFAULT_HEAVY_FOLDER_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_FAST_DETAIL_FILES = 120000;
const DEFAULT_FAST_DETAIL_DIRECTORIES = 120000;
const CLEANUP_MODE_ORDER = ["baixo", "medio", "alto"];

async function scanFastInventory(rootPath, options = {}, onProgress = null) {
  if (process.platform === "win32") {
    return scanWithRobocopy(rootPath, options, onProgress);
  }

  return {
    provider: "indisponivel",
    nodes: [],
    fileNodes: [],
    skipped: [],
    warnings: ["Inventario turbo nativo ainda esta disponivel apenas no Windows."],
    stopReason: "Inventario turbo indisponivel nesta plataforma.",
    stats: emptyStats("indisponivel")
  };
}

async function scanRelocationCandidates(rootPath, request = {}, onProgress = null) {
  if (process.platform === "win32") {
    return scanRelocationCandidatesWithRobocopy(rootPath, request, onProgress);
  }

  return scanRelocationCandidatesWithFs(rootPath, request, onProgress);
}

async function scanRelocationCandidatesWithRobocopy(rootPath, request = {}, onProgress = null) {
  const root = path.resolve(rootPath);
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "maidspace-alc-null-"));
  await fs.mkdir(destination, { recursive: true });

  const mode = normalizeCleanupMode(request.mode || request.selectedMode || "alto");
  const targetBytes = Math.max(0, Number(request.targetBytes || 0));
  const maxMs = clampNumber(request.fastScanMs || request.maxMs, 1000, 30 * 60 * 1000, 10 * 60 * 1000);
  const maxCandidates = clampNumber(request.limit, 1, Infinity, targetBytes ? 1000000 : 200000);
  const options = {
    ...request.options,
    includeProgramFiles: request.options?.includeProgramFiles !== false
  };
  const excludedDirectories = Array.from(new Set([
    destination,
    ...((request.skipDirectories || options.skipDirectories || []).map((item) => String(item)).filter(Boolean))
  ]));
  const args = [
    root,
    destination,
    "/L",
    "/E",
    "/BYTES",
    "/FP",
    "/TS",
    "/XJ",
    "/R:0",
    "/W:0",
    "/NJH",
    "/NJS",
    "/NP",
    "/XD",
    ...excludedDirectories
  ];
  const state = createFocusedCandidateState({ root, mode, targetBytes, maxCandidates, options, request });
  let buffer = "";
  let stopReason = null;
  let settled = false;
  const startedAt = Date.now();
  let lastProgressAt = 0;
  let lastPath = ".";

  const child = spawn("robocopy", args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const timer = setTimeout(() => {
    stopReason = `Expansao da limpeza interrompida por limite de ${maxMs} ms; candidatos parciais mantidos.`;
    killProcessTree(child);
  }, maxMs);

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      consumeLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      state.warnings.push(text.slice(0, 300));
    }
  });

  try {
    await new Promise((resolve) => {
      const hardTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        stopReason = stopReason || `Expansao da limpeza forcada a encerrar apos ${maxMs + 5000} ms; candidatos parciais mantidos.`;
        killProcessTree(child);
        resolve();
      }, maxMs + 5000);

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        if (buffer.trim()) {
          consumeLine(buffer);
          buffer = "";
        }
        if (code >= 8 && !stopReason) {
          stopReason = `Robocopy retornou codigo ${code}; expansao da limpeza parcial mantida.`;
        }
        resolve();
      });

      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        stopReason = `Falha ao iniciar expansao da limpeza: ${error.message}`;
        resolve();
      });
    });
  } finally {
    clearTimeout(timer);
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
  }

  if (stopReason) {
    state.warnings.push(stopReason);
  }

  return finalizeFocusedCandidateState(state, {
    provider: "robocopy_focused_alc",
    elapsedMs: Date.now() - startedAt,
    stopReason
  });

  function consumeLine(rawLine) {
    const line = rawLine.trim();
    if (!line || state.complete) {
      return;
    }
    const file = parseRobocopyFileLine(line);
    if (!file) {
      return;
    }
    const absolutePath = path.resolve(file.absolutePath);
    const relativePath = normalizeRelative(path.relative(root, absolutePath));
    if (!relativePath || relativePath.startsWith("..")) {
      return;
    }
    const node = createInventoryNode({
      root,
      absolutePath,
      relativePath,
      size: file.size,
      modifiedAt: file.modifiedAt,
      options
    });
    lastPath = relativePath;
    rememberFocusedCandidate(state, node);
    emitProgress();
    if (state.complete) {
      stopReason = targetBytes
        ? `Expansao da limpeza atingiu ${formatBytes(state.selectedBytes)} para meta ${formatBytes(targetBytes)}.`
        : null;
      killProcessTree(child);
    }
  }

  function emitProgress() {
    const now = Date.now();
    if (!onProgress || now - lastProgressAt < 1000) {
      return;
    }
    lastProgressAt = now;
    onProgress({
      provider: "robocopy_focused_alc",
      phase: "expansao_alc",
      mode,
      currentPath: lastPath,
      scannedFiles: state.scannedFiles,
      eligibleFiles: state.eligibleFiles,
      selectedFiles: state.selected.length,
      selectedBytes: state.selectedBytes,
      selectedHuman: formatBytes(state.selectedBytes),
      targetBytes,
      targetHuman: formatBytes(targetBytes),
      elapsedMs: now - startedAt
    });
  }
}

async function scanRelocationCandidatesWithFs(rootPath, request = {}, onProgress = null) {
  const root = path.resolve(rootPath);
  const mode = normalizeCleanupMode(request.mode || request.selectedMode || "alto");
  const targetBytes = Math.max(0, Number(request.targetBytes || 0));
  const maxMs = clampNumber(request.fastScanMs || request.maxMs, 1000, 30 * 60 * 1000, 10 * 60 * 1000);
  const maxCandidates = clampNumber(request.limit, 1, Infinity, targetBytes ? 1000000 : 200000);
  const options = {
    ...request.options,
    includeProgramFiles: request.options?.includeProgramFiles !== false
  };
  const state = createFocusedCandidateState({ root, mode, targetBytes, maxCandidates, options, request });
  const startedAt = Date.now();
  let lastProgressAt = 0;
  let lastPath = ".";
  let stopReason = null;
  const stack = [root];

  while (stack.length && !state.complete) {
    if (Date.now() - startedAt > maxMs) {
      stopReason = `Expansao da limpeza interrompida por limite de ${maxMs} ms; candidatos parciais mantidos.`;
      break;
    }
    const directory = stack.pop();
    let entries = [];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      state.warnings.push(`Sem acesso a ${directory}: ${error.message}`.slice(0, 300));
      continue;
    }

    for (const entry of entries) {
      if (state.complete) {
        break;
      }
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelative(path.relative(root, absolutePath));
      if (!relativePath || relativePath.startsWith("..") || focusedPathBlocked(relativePath, request)) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      let metadata;
      try {
        metadata = await fs.stat(absolutePath);
      } catch (error) {
        state.warnings.push(`Sem metadados de ${relativePath}: ${error.message}`.slice(0, 300));
        continue;
      }
      const node = createInventoryNode({
        root,
        absolutePath,
        relativePath,
        size: metadata.size,
        modifiedAt: metadata.mtime instanceof Date ? metadata.mtime : new Date(),
        options
      });
      lastPath = relativePath;
      rememberFocusedCandidate(state, node);
      const now = Date.now();
      if (onProgress && now - lastProgressAt >= 1000) {
        lastProgressAt = now;
        onProgress({
          provider: "fs_focused_alc",
          phase: "expansao_alc",
          mode,
          currentPath: lastPath,
          scannedFiles: state.scannedFiles,
          eligibleFiles: state.eligibleFiles,
          selectedFiles: state.selected.length,
          selectedBytes: state.selectedBytes,
          selectedHuman: formatBytes(state.selectedBytes),
          targetBytes,
          targetHuman: formatBytes(targetBytes),
          elapsedMs: now - startedAt
        });
      }
    }
  }

  return finalizeFocusedCandidateState(state, {
    provider: "fs_focused_alc",
    elapsedMs: Date.now() - startedAt,
    stopReason
  });
}

async function scanWithRobocopy(rootPath, options = {}, onProgress = null) {
  const root = path.resolve(rootPath);
  const destination = await fs.mkdtemp(path.join(os.tmpdir(), "src-robocopy-null-"));
  await fs.mkdir(destination, { recursive: true });

  const maxMs = clampNumber(options.fastScanMs, 1000, 10 * 60 * 1000, 30000);
  const maxStoredFiles = clampNumber(options.fastStoredFiles, 1000, Infinity, DEFAULT_FAST_DETAIL_FILES);
  const maxStoredDirectories = clampNumber(options.fastStoredDirectories, 500, Infinity, DEFAULT_FAST_DETAIL_DIRECTORIES);
  const overflowPruneThreshold = Number.isFinite(maxStoredFiles)
    ? Math.max(2500, Math.min(50000, Math.floor(maxStoredFiles * 0.25)))
    : Infinity;
  const stats = emptyStats("robocopy");
  const nodes = [];
  const fileNodes = [];
  const skipped = [];
  const warnings = [];
  const overflow = [];
  const inventoryReclaimable = createInventoryReclaimable();
  const folderDatabase = new Map();
  const dependencyGroupDatabase = new Map();
  const startedAt = Date.now();
  let buffer = "";
  let lastProgressAt = 0;
  let lastPath = ".";
  let stopReason = null;
  let settled = false;

  const excludedDirectories = Array.from(new Set([
    destination,
    ...((options.skipDirectories || []).map((item) => String(item)).filter(Boolean))
  ]));
  const args = [
    root,
    destination,
    "/L",
    "/E",
    "/BYTES",
    "/FP",
    "/TS",
    "/XJ",
    "/R:0",
    "/W:0",
    "/NJH",
    "/NJS",
    "/NP",
    "/XD",
    ...excludedDirectories
  ];

  const child = spawn("robocopy", args, {
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  const timer = setTimeout(() => {
    stopReason = `Inventario turbo interrompido por limite de ${maxMs} ms; resultado parcial gerado.`;
    killProcessTree(child);
  }, maxMs);

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || "";
    for (const line of lines) {
      consumeRobocopyLine(line);
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) {
      warnings.push(text.slice(0, 300));
    }
  });

  try {
    await new Promise((resolve) => {
      const hardTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        stopReason = stopReason || `Inventario turbo forcado a encerrar apos ${maxMs + 5000} ms; resultado parcial gerado.`;
        killProcessTree(child);
        resolve();
      }, maxMs + 5000);

      child.on("close", (code) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        if (buffer.trim()) {
          consumeRobocopyLine(buffer);
          buffer = "";
        }
        if (code >= 8 && !stopReason) {
          stopReason = `Robocopy retornou codigo ${code}; inventario parcial mantido.`;
        }
        resolve();
      });
      child.on("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearTimeout(hardTimer);
        stopReason = `Falha ao iniciar inventario turbo: ${error.message}`;
        resolve();
      });
    });
  } finally {
    clearTimeout(timer);
    await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
  }

  pruneStoredFiles(true);
  const auxiliaryInventory = buildAuxiliaryInventory(folderDatabase, dependencyGroupDatabase, options);
  applyInventoryScanStrategy(fileNodes, auxiliaryInventory.heavyFolders, options);
  stats.elapsedMs = Date.now() - startedAt;
  stats.storedFiles = fileNodes.length;
  stats.storedDirectories = nodes.filter((node) => node.kind === "directory").length;
  stats.truncated = stats.files > stats.storedFiles;
  stats.heavyFolders = auxiliaryInventory.heavyFolders;
  stats.dependencyGroups = auxiliaryInventory.dependencyGroups;
  stats.auxiliaryDatabase = auxiliaryInventory.auxiliaryDatabase;
  stats.inventoryReclaimable = finalizeInventoryReclaimable(inventoryReclaimable);
  if (stopReason) {
    warnings.push(stopReason);
  }

  return {
    provider: "robocopy",
    nodes,
    fileNodes,
    skipped,
    warnings,
    stopReason,
    stats
  };

  function consumeRobocopyLine(rawLine) {
    const line = rawLine.trim();
    if (!line) {
      return;
    }

    const file = parseRobocopyFileLine(line);
    if (file) {
      const absolutePath = path.resolve(file.absolutePath);
      const relativePath = normalizeRelative(path.relative(root, absolutePath));
      if (!relativePath || relativePath.startsWith("..")) {
        return;
      }
      const node = createInventoryNode({
        root,
        absolutePath,
        relativePath,
        size: file.size,
        modifiedAt: file.modifiedAt,
        options
      });
      stats.files += 1;
      stats.totalBytes += node.size || 0;
      lastPath = relativePath;
      rememberInventoryReclaimable(node);
      rememberAuxiliaryFile(node);
      rememberFileNode(node);
      emitProgress();
      return;
    }

    const directory = parseRobocopyDirectoryLine(line);
    if (directory) {
      const absolutePath = path.resolve(directory.absolutePath);
      const relativePath = normalizeRelative(path.relative(root, absolutePath));
      if (!relativePath || relativePath.startsWith("..")) {
        return;
      }
      stats.directories += 1;
      lastPath = relativePath;
      rememberAuxiliaryDirectory(relativePath);
      if (nodes.length < maxStoredDirectories) {
        nodes.push({
          id: `dir:${relativePath}`,
          kind: "directory",
          name: path.basename(relativePath),
          relativePath,
          scanDepth: filesystemDepth(relativePath) + 1,
          size: 0,
          extension: "",
          protectedReasons: protectedReasonsFor(absolutePath, relativePath, path.basename(relativePath), "", options),
          classification: "diretorio",
          risk: "baixo"
        });
      }
      emitProgress();
    }
  }

  function rememberAuxiliaryDirectory(relativePath) {
    if (!folderDatabase.has(relativePath)) {
      folderDatabase.set(relativePath, createFolderRecord(relativePath));
    }
  }

  function rememberAuxiliaryFile(node) {
    for (const folderPath of folderCandidatesFor(node.relativePath)) {
      if (!folderDatabase.has(folderPath)) {
        folderDatabase.set(folderPath, createFolderRecord(folderPath));
      }
      const folder = folderDatabase.get(folderPath);
      folder.files += 1;
      folder.bytes += node.size || 0;
      folder.riskScore += fileRiskWeight(node);
      for (const category of node.fileKnowledge?.categories || []) {
        folder.categories[category] = (folder.categories[category] || 0) + 1;
      }
      const dependencyGroup = node.dependencyGroup || node.fileKnowledge?.dependencyGroup || "dpn:incerto";
      folder.dependencyGroups[dependencyGroup] = (folder.dependencyGroups[dependencyGroup] || 0) + 1;
      if (folder.samples.length < 8) {
        folder.samples.push(node.relativePath);
      }
    }

    const dependencyGroup = node.dependencyGroup || node.fileKnowledge?.dependencyGroup || "dpn:incerto";
    if (!dependencyGroupDatabase.has(dependencyGroup)) {
      dependencyGroupDatabase.set(dependencyGroup, {
        key: dependencyGroup,
        files: 0,
        bytes: 0,
        riskCategory: node.fileKnowledge?.riskCategory || "incerto",
        typeCategory: node.fileKnowledge?.typeCategory || "desconhecido",
        lastUseBucket: node.fileKnowledge?.lastUseBucket || "idade_desconhecida",
        createdBucket: node.fileKnowledge?.createdBucket || "idade_desconhecida",
        samples: []
      });
    }
    const group = dependencyGroupDatabase.get(dependencyGroup);
    group.files += 1;
    group.bytes += node.size || 0;
    if (group.samples.length < 8) {
      group.samples.push(node.relativePath);
    }
  }

  function rememberFileNode(node) {
    if (fileNodes.length < maxStoredFiles) {
      fileNodes.push(node);
      nodes.push(node);
      return;
    }
    overflow.push(node);
    if (overflow.length >= overflowPruneThreshold) {
      pruneStoredFiles(false);
    }
  }

  function pruneStoredFiles(finalPass) {
    if (!overflow.length && !finalPass) {
      return;
    }
    if (!overflow.length) {
      return;
    }
    if (overflow.length) {
      fileNodes.push(...overflow.splice(0));
    }
    if (!Number.isFinite(maxStoredFiles)) {
      return;
    }
    const selectedFiles = selectBalancedInventoryNodes(fileNodes, maxStoredFiles);
    fileNodes.length = 0;
    fileNodes.push(...selectedFiles);
    const directories = nodes.filter((node) => node.kind === "directory");
    nodes.length = 0;
    nodes.push(...directories.slice(0, maxStoredDirectories), ...fileNodes);
  }

  function emitProgress() {
    const now = Date.now();
    if (now - lastProgressAt < 1000) {
      return;
    }
    lastProgressAt = now;
    onProgress?.({
      provider: "robocopy",
      phase: "inventario_turbo",
      currentPath: lastPath,
      files: stats.files,
      directories: stats.directories,
      totalBytes: stats.totalBytes,
      totalHuman: formatBytes(stats.totalBytes),
      elapsedMs: now - startedAt,
      storedFiles: fileNodes.length,
      dependencyGroups: dependencyGroupDatabase.size,
      heavyFolderCandidates: Array.from(folderDatabase.values()).filter((folder) => isHeavyFolder(folder, options)).length,
      inventoryReclaimable: finalizeInventoryReclaimable(inventoryReclaimable)
    });
  }

  function rememberInventoryReclaimable(node) {
    updateInventoryReclaimable(inventoryReclaimable, node);
  }
}

function parseRobocopyFileLine(line) {
  const match = line.match(/^\s*(?:.+?\s+)?(\d+)\s+(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})\s+(.+?)\s*$/);
  if (!match) {
    return null;
  }
  const absolutePath = match[3];
  if (!/^[a-zA-Z]:[\\/]/.test(absolutePath) && !absolutePath.startsWith("\\\\")) {
    return null;
  }
  return {
    size: Number(match[1]) || 0,
    modifiedAt: parseRobocopyTimestamp(match[2]),
    absolutePath
  };
}

function killProcessTree(child) {
  if (!child || !child.pid) {
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore"
    });
    killer.on("error", () => {
      child.kill();
    });
    return;
  }

  child.kill("SIGKILL");
}

function parseRobocopyDirectoryLine(line) {
  const match = line.match(/^\s*\d+\s+([a-zA-Z]:[\\/].*?[\\/]?)\s*$/);
  if (!match) {
    return null;
  }
  return { absolutePath: match[1] };
}

function parseRobocopyTimestamp(value) {
  const isoLike = String(value || "").replace(/\//g, "-").replace(" ", "T");
  const date = new Date(isoLike);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function createInventoryNode({ absolutePath, relativePath, size, modifiedAt, options }) {
  const name = path.basename(relativePath);
  const extension = path.extname(name).toLowerCase();
  const fileKnowledge = classifyFileKnowledge(relativePath, name, extension, {
    size,
    modifiedAt,
    lastAccessedAt: modifiedAt,
    createdAt: modifiedAt
  });
  const protectedReasons = protectedReasonsFor(absolutePath, relativePath, name, extension, options);
  const lastAccessedAt = modifiedAt;

  return {
    id: `file:${relativePath}`,
    kind: "file",
    name,
    relativePath,
    absolutePath,
    extension,
    size,
    modifiedAt: modifiedAt.toISOString(),
    lastAccessedAt: lastAccessedAt.toISOString(),
    createdAt: modifiedAt.toISOString(),
    daysSinceAccess: daysBetween(lastAccessedAt, new Date()),
    protectedReasons,
    fileKnowledge,
    dependencyGroup: fileKnowledge.dependencyGroup,
    scanStrategy: {
      discovery: "balanced_search_ntfs",
      inventoryProvider: "robocopy",
      dependencyGroup: fileKnowledge.dependencyGroup,
      heavyFolderPath: null
    },
    dependencyProbe: {
      enabled: false,
      reason: null,
      status: "not_needed"
    },
    incoming: 0,
    outgoing: 0,
    incomingFrom: [],
    outgoingTo: [],
    depth: 0,
    scanDepth: filesystemDepth(relativePath),
    impactCount: 0,
    componentId: null,
    componentSize: 1,
    dfsColor: "branco",
    inCycle: false,
    cycleBlockId: null,
    cycleBlockIds: [],
    cycleGroupSize: 0,
    dependsOn: [],
    dependents: [],
    classification: "isolado",
    risk: "baixo",
    riskScore: 0,
    riskReasons: [],
    impact: {
      system: "desconhecido",
      user: "desconhecido",
      dependencies: "desconhecido"
    },
    utilityStatus: "desconhecido",
    deletionDecision: "averiguar",
    relocationDecision: "pode_mexer",
    simulationAction: "separar_como_isolado",
    simulation: null,
    canReadContent: false,
    readError: null,
    detectedDependencies: [],
    initialUnresolvedDependencies: 0,
    initialUnresolvedSpecifiers: [],
    unresolvedDependencies: 0,
    unresolvedSpecifiers: [],
    externalDependencies: 0
  };
}

function protectedReasonsFor(absolutePath, relativePath, name, extension, options = {}) {
  const reasons = [];
  const lowerAbsolute = String(absolutePath || "").toLowerCase();
  const lowerRelative = normalizeRelative(relativePath).toLowerCase();
  const lowerName = String(name || "").toLowerCase();
  const lowerExtension = String(extension || path.extname(lowerName)).toLowerCase();
  const knowledge = classifyFileKnowledge(relativePath, name, lowerExtension);

  if (PROTECTED_FILE_NAMES.has(lowerName)) {
    reasons.push("arquivo de configuracao/lock");
  }
  if (SYSTEM_PROTECTED_EXTENSIONS.has(lowerExtension)) {
    reasons.push("arquivo essencial do sistema");
  } else if (PROTECTED_EXTENSIONS.has(lowerExtension) && isStrictSystemPath(lowerAbsolute, lowerRelative)) {
    reasons.push("binario em diretorio critico do sistema");
  }
  if (knowledge.isSystemEssential) {
    reasons.push("tipo essencial do sistema");
  }
  if (knowledge.isProjectDependency && PROTECTED_FILE_NAMES.has(lowerName)) {
    reasons.push("dependencia/configuracao de projeto");
  }
  if (isStrictSystemPath(lowerAbsolute, lowerRelative)) {
    reasons.push("diretorio critico do sistema operacional");
  }
  if (!options.includeProgramFiles && /(^|[\\/])program files( \(x86\))?([\\/]|$)/i.test(lowerAbsolute)) {
    reasons.push("diretorio do sistema operacional");
  }

  return Array.from(new Set(reasons));
}

function isStrictSystemPath(absolutePath, relativePath = "") {
  const corpus = [
    String(absolutePath || "").replace(/\\/g, "/").toLowerCase(),
    normalizeRelative(relativePath).toLowerCase()
  ].join("\n");

  return /(^|\/)(system32|syswow64|winsxs|windowsapps|recovery|system volume information|\$winreagent)(\/|$)/i.test(corpus)
    || /(^|\/)windows\/(system32|syswow64|winsxs|servicing|systemresources|security|inf|assembly|diagnostics)(\/|$)/i.test(corpus)
    || /(^|\/)programdata\/microsoft(\/|$)/i.test(corpus);
}

function inventoryNodeScore(node) {
  const relativePath = String(node.relativePath || "").toLowerCase();
  const extension = String(node.extension || "").toLowerCase();
  let score = node.size || 0;
  if (/(^|\/)(downloads|desktop|videos|pictures|music|backup|backups|archive|archives)(\/|$)/.test(relativePath)) {
    score += 2 * 1024 * 1024 * 1024;
  }
  if (/(^|\/)(cache|tmp|temp|logs?|\.cache|dist|build|out|target|coverage)(\/|$)/.test(relativePath)) {
    score += 1024 * 1024 * 1024;
  }
  if ([".zip", ".7z", ".rar", ".iso", ".mp4", ".mov", ".mkv", ".bak", ".old", ".tmp", ".log"].includes(extension)) {
    score += 512 * 1024 * 1024;
  }
  if (node.fileKnowledge?.isProjectDependency || node.fileKnowledge?.isSourceCode) {
    score += 256 * 1024 * 1024;
  }
  if (node.fileKnowledge?.isSystemEssential) {
    score += 128 * 1024 * 1024;
  }
  if (node.protectedReasons?.length) {
    score -= 4 * 1024 * 1024 * 1024;
  }
  return score;
}

function createInventoryReclaimable() {
  const blank = () => ({ files: 0, bytes: 0, human: "0 B" });
  return {
    provider: "metadata_estimate",
    baixo: blank(),
    medio: blank(),
    alto: blank(),
    blocked: blank()
  };
}

function updateInventoryReclaimable(reclaimable, node) {
  const mode = metadataCleanupMode(node);
  if (!mode) {
    reclaimable.blocked.files += 1;
    reclaimable.blocked.bytes += node.size || 0;
    return;
  }

  const start = CLEANUP_MODE_ORDER.indexOf(mode);
  for (let index = start; index < CLEANUP_MODE_ORDER.length; index += 1) {
    const bucket = reclaimable[CLEANUP_MODE_ORDER[index]];
    bucket.files += 1;
    bucket.bytes += node.size || 0;
  }
}

function metadataCleanupMode(node) {
  if (node.protectedReasons?.length || node.fileKnowledge?.isSystemEssential) {
    return null;
  }

  const relativePath = String(node.relativePath || "").replace(/\\/g, "/").toLowerCase();
  const extension = String(node.extension || "").toLowerCase();
  const name = String(node.name || "").toLowerCase();
  const size = node.size || 0;
  const age = Number(node.daysSinceAccess ?? 0);
  const knowledge = node.fileKnowledge || {};
  const generatedPath = /(^|\/)(cache|caches|tmp|temp|logs?|\.cache|crashdumps|dumps|shadercache|webcache)(\/|$)/.test(relativePath);
  const generatedFile = knowledge.isLowValueGenerated || /\.(tmp|temp|log|bak|old|dmp|chk|crdownload|part)$/i.test(name);
  const downloadsPath = /(^|\/)(downloads?|download)(\/|$)/.test(relativePath);
  const archivePath = /(^|\/)(backup|backups|archive|archives)(\/|$)/.test(relativePath);
  const knownUserPayload = knowledge.isUserContent || knowledge.isKnownUserFolder || knowledge.isCloudUserContent;
  const applicationState = knowledge.isApplicationState && !generatedPath && !generatedFile;
  const archiveOrInstaller = knowledge.isArchive
    || [".zip", ".7z", ".rar", ".iso", ".msi", ".exe"].includes(extension)
    || /\b(setup|installer|install|driver)\b/.test(name);
  const mediaOrUserPayload = knownUserPayload
    || [".mp4", ".mov", ".mkv", ".avi", ".wav", ".flac", ".mp3", ".psd", ".ai", ".raw"].includes(extension);
  const appPayload = knowledge.isInstalledApplication
    && (/(^|\/)(steamapps|common|downloads|cache|shadercache|epic games|games|mods)(\/|$)/.test(relativePath) || size >= 256 * 1024 * 1024);

  if (applicationState) {
    return age >= 45 && size >= 1024 * 1024 * 1024 ? "alto" : null;
  }
  if ((generatedPath || generatedFile) && age >= 7) {
    return "baixo";
  }
  if (generatedPath || generatedFile) {
    return "medio";
  }
  if ((archiveOrInstaller || archivePath) && age >= 21) {
    return "medio";
  }
  if (downloadsPath && archiveOrInstaller && age >= 21) {
    return "medio";
  }
  if ((downloadsPath || knowledge.isCloudUserContent) && knownUserPayload && (age >= 30 || size >= 1024 * 1024 * 1024)) {
    return "alto";
  }
  if (appPayload || archiveOrInstaller || mediaOrUserPayload || size >= 1024 * 1024 * 1024) {
    return "alto";
  }

  return null;
}

function finalizeInventoryReclaimable(reclaimable) {
  const finalized = {
    provider: reclaimable.provider || "metadata_estimate"
  };
  for (const key of [...CLEANUP_MODE_ORDER, "blocked"]) {
    const bucket = reclaimable[key] || { files: 0, bytes: 0 };
    finalized[key] = {
      files: bucket.files || 0,
      bytes: bucket.bytes || 0,
      human: formatBytes(bucket.bytes || 0)
    };
  }
  return finalized;
}

function selectBalancedInventoryNodes(candidates, limit) {
  if (!Number.isFinite(limit)) {
    return candidates;
  }
  if (candidates.length <= limit) {
    return candidates
      .slice()
      .sort((a, b) => inventoryNodeScore(b) - inventoryNodeScore(a) || a.relativePath.localeCompare(b.relativePath));
  }

  const groups = new Map();
  for (const node of candidates) {
    const key = node.dependencyGroup || node.fileKnowledge?.dependencyGroup || "dpn:incerto";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(node);
  }

  const orderedGroups = Array.from(groups.values())
    .map((items) => items.sort((a, b) => inventoryNodeScore(b) - inventoryNodeScore(a) || a.relativePath.localeCompare(b.relativePath)))
    .sort((a, b) => inventoryNodeScore(b[0]) - inventoryNodeScore(a[0]) || a[0].relativePath.localeCompare(b[0].relativePath));
  const selected = [];
  const selectedIds = new Set();

  while (selected.length < limit) {
    let added = false;
    for (const group of orderedGroups) {
      const node = group.shift();
      if (!node || selectedIds.has(node.id)) {
        continue;
      }
      selected.push(node);
      selectedIds.add(node.id);
      added = true;
      if (selected.length >= limit) {
        break;
      }
    }
    if (!added) {
      break;
    }
  }

  return selected.sort((a, b) => inventoryNodeScore(b) - inventoryNodeScore(a) || a.relativePath.localeCompare(b.relativePath));
}

function buildAuxiliaryInventory(folderDatabase, dependencyGroupDatabase, options = {}) {
  const heavyFolders = Array.from(folderDatabase.values())
    .filter((folder) => isHeavyFolder(folder, options))
    .sort((a, b) => heavyFolderScore(b) - heavyFolderScore(a) || a.path.localeCompare(b.path))
    .slice(0, 100)
    .map((folder) => ({
      ...folder,
      bytesHuman: formatBytes(folder.bytes),
      reason: heavyFolderReason(folder, options),
      topDependencyGroups: topEntries(folder.dependencyGroups, 6),
      topCategories: topEntries(folder.categories, 6)
    }));

  const dependencyGroups = Array.from(dependencyGroupDatabase.values())
    .sort((a, b) => b.files - a.files || b.bytes - a.bytes || a.key.localeCompare(b.key))
    .slice(0, 200)
    .map((group) => ({
      ...group,
      bytesHuman: formatBytes(group.bytes)
    }));

  return {
    heavyFolders,
    dependencyGroups,
    auxiliaryDatabase: {
      provider: "robocopy",
      model: "ntfs_metadata_auxiliary",
      filesIndexed: Array.from(dependencyGroupDatabase.values()).reduce((sum, group) => sum + group.files, 0),
      foldersIndexed: folderDatabase.size,
      groupsIndexed: dependencyGroupDatabase.size,
      heavyFoldersIndexed: heavyFolders.length
    }
  };
}

function applyInventoryScanStrategy(fileNodes, heavyFolders, options = {}) {
  const orderedFolders = (heavyFolders || [])
    .slice()
    .sort((a, b) => String(b.path || ".").length - String(a.path || ".").length);

  for (const node of fileNodes) {
    const folder = orderedFolders.find((candidate) => pathContainsFile(candidate.path || ".", node.relativePath));
    node.heavyFolder = folder ? {
      path: folder.path,
      files: folder.files,
      bytes: folder.bytes,
      bytesHuman: folder.bytesHuman || formatBytes(folder.bytes),
      riskScore: folder.riskScore,
      reason: folder.reason || heavyFolderReason(folder, options)
    } : null;
    node.scanStrategy = {
      ...(node.scanStrategy || {}),
      discovery: "balanced_search_ntfs",
      inventoryProvider: "robocopy",
      dependencyGroup: node.dependencyGroup || node.fileKnowledge?.dependencyGroup || "dpn:incerto",
      heavyFolderPath: node.heavyFolder?.path || null
    };
    node.dependencyProbe = dependencyProbeFor(node, options);
  }
}

function dependencyProbeFor(node, options = {}) {
  if (options.targetedDfsProbe === false || !node.heavyFolder) {
    return { enabled: false, reason: node.heavyFolder ? "disabled" : "fora_de_hf", status: "not_needed" };
  }

  const lowerName = String(node.name || "").toLowerCase();
  const textCandidate = isTextCandidate(lowerName, node.extension);
  const knowledge = node.fileKnowledge || {};
  const riskyDependency =
    node.protectedReasons?.length > 0
    || knowledge.isSystemEssential
    || knowledge.isProjectDependency
    || knowledge.isSourceCode
    || knowledge.riskCategory === "dependencia"
    || knowledge.riskCategory === "sistema";
  const riskyHeavyFolder = (node.heavyFolder.riskScore || 0) >= heavyFolderRiskThreshold(options);

  if (!textCandidate) {
    return {
      enabled: false,
      reason: riskyDependency || riskyHeavyFolder ? "hf_risco_nao_texto" : "nao_texto",
      status: "skipped_non_text"
    };
  }
  if (!riskyDependency && !riskyHeavyFolder) {
    return { enabled: false, reason: "hf_sem_dpn_de_risco", status: "not_needed" };
  }

  return {
    enabled: true,
    reason: riskyDependency ? "dpn_de_risco_em_hf" : "hf_risco_agregado",
    status: "queued",
    maxBytes: options.maxDependencyReadBytes || 512 * 1024,
    maxMs: options.maxDependencyReadMs || 80
  };
}

function createFolderRecord(folderPath) {
  return {
    path: folderPath || ".",
    files: 0,
    bytes: 0,
    riskScore: 0,
    categories: {},
    dependencyGroups: {},
    samples: []
  };
}

function folderCandidatesFor(relativePath) {
  const normalized = normalizeRelative(relativePath);
  const directory = normalizeRelative(path.posix.dirname(normalized));
  const top = topDirectory(normalized);
  return Array.from(new Set([
    directory && directory !== "." ? directory : ".",
    top || ".",
    "."
  ]));
}

function pathContainsFile(folderPath, relativePath) {
  const folder = normalizeRelative(folderPath || ".");
  const file = normalizeRelative(relativePath || ".");
  return folder === "." || file === folder || file.startsWith(`${folder}/`);
}

function isHeavyFolder(folder, options = {}) {
  return (folder.files || 0) >= heavyFolderFileThreshold(options)
    || (folder.bytes || 0) >= heavyFolderBytesThreshold(options)
    || (folder.riskScore || 0) >= heavyFolderRiskThreshold(options);
}

function heavyFolderScore(folder) {
  return ((folder.files || 0) * 1000) + Math.min(folder.bytes || 0, 1024 * 1024 * 1024 * 1024) + ((folder.riskScore || 0) * 100000);
}

function heavyFolderReason(folder, options = {}) {
  const reasons = [];
  if ((folder.files || 0) >= heavyFolderFileThreshold(options)) {
    reasons.push("muitos_arquivos");
  }
  if ((folder.bytes || 0) >= heavyFolderBytesThreshold(options)) {
    reasons.push("muitos_bytes");
  }
  if ((folder.riskScore || 0) >= heavyFolderRiskThreshold(options)) {
    reasons.push("dpn_de_risco");
  }
  return reasons.join("+") || "amostragem_hf";
}

function fileRiskWeight(node) {
  const knowledge = node.fileKnowledge || {};
  let score = 0;
  if (node.protectedReasons?.length) {
    score += 8;
  }
  if (knowledge.isSystemEssential) {
    score += 10;
  }
  if (knowledge.isProjectDependency || knowledge.isSourceCode) {
    score += 6;
  }
  if (knowledge.isApplicationState) {
    score += 5;
  }
  if (knowledge.isArchive || knowledge.riskCategory === "arquivo_pesado") {
    score += 4;
  }
  if (knowledge.isLowValueGenerated) {
    score += 2;
  }
  if ((node.size || 0) >= 1024 * 1024 * 1024) {
    score += 4;
  }
  return score;
}

function topEntries(record, limit) {
  return Object.entries(record || {})
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function topDirectory(relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized || normalized === "." || !normalized.includes("/")) {
    return ".";
  }
  return normalized.split("/")[0];
}

function createFocusedCandidateState({ root, mode, targetBytes, maxCandidates, options, request }) {
  return {
    root,
    mode,
    targetBytes,
    maxCandidates,
    options,
    request,
    scannedFiles: 0,
    eligibleFiles: 0,
    selectedBytes: 0,
    selected: [],
    skippedOversized: [],
    warnings: [],
    complete: false
  };
}

function rememberFocusedCandidate(state, node) {
  state.scannedFiles += 1;
  const cleanupMode = metadataCleanupMode(node);
  if (
    !cleanupMode
    || !cleanupModeIncludedIn(state.mode, cleanupMode)
    || focusedCandidateBlocked(node, state.request)
  ) {
    return;
  }

  state.eligibleFiles += 1;
  const candidate = inventoryNodeToRelocationCandidate(node, state.mode, cleanupMode, state.request);
  const bytes = candidate.packageBytes || candidate.sizeBytes || 0;
  if (!bytes) {
    return;
  }

  const hasTarget = state.targetBytes > 0;
  const remaining = state.targetBytes - state.selectedBytes;
  if (
    hasTarget
    && remaining > 0
    && bytes > remaining
    && state.selectedBytes > 0
  ) {
    state.skippedOversized.push(candidate);
    if (state.skippedOversized.length > 5000) {
      state.skippedOversized.sort((a, b) => candidateBytesValue(a) - candidateBytesValue(b));
      state.skippedOversized.length = 5000;
    }
    return;
  }

  state.selected.push(candidate);
  state.selectedBytes += bytes;

  if (state.selected.length >= state.maxCandidates) {
    state.complete = true;
    state.warnings.push(`Expansao da limpeza parou em ${state.maxCandidates} candidato(s).`);
  } else if (hasTarget && state.selectedBytes >= state.targetBytes) {
    state.complete = true;
  }
}

function finalizeFocusedCandidateState(state, metadata) {
  if (state.targetBytes > 0 && state.selectedBytes < state.targetBytes && state.skippedOversized.length) {
    const best = state.skippedOversized
      .slice()
      .sort((a, b) => {
        const aDelta = Math.abs(state.targetBytes - (state.selectedBytes + candidateBytesValue(a)));
        const bDelta = Math.abs(state.targetBytes - (state.selectedBytes + candidateBytesValue(b)));
        return aDelta - bDelta || candidateBytesValue(a) - candidateBytesValue(b);
      })[0];
    if (best && state.selected.length < state.maxCandidates) {
      state.selected.push(best);
      state.selectedBytes += candidateBytesValue(best);
    }
  }

  state.selected.sort((a, b) => candidateBytesValue(b) - candidateBytesValue(a) || String(a.path).localeCompare(String(b.path)));

  return {
    provider: metadata.provider,
    mode: state.mode,
    targetBytes: state.targetBytes,
    targetHuman: formatBytes(state.targetBytes),
    bytes: state.selectedBytes,
    human: formatBytes(state.selectedBytes),
    files: state.selected.length,
    scannedFiles: state.scannedFiles,
    eligibleFiles: state.eligibleFiles,
    complete: state.targetBytes <= 0 || state.selectedBytes >= state.targetBytes,
    elapsedMs: metadata.elapsedMs || 0,
    stopReason: metadata.stopReason || null,
    warnings: state.warnings,
    candidates: state.selected
  };
}

function inventoryNodeToRelocationCandidate(node, selectedMode, cleanupMode, request = {}) {
  const bytes = node.size || 0;
  const decision = deletionDecisionForCleanupMode(cleanupMode, node);
  const risk = riskForCleanupMode(cleanupMode, node);
  const relativePath = normalizeRelative(node.relativePath);
  const userDecision = focusedPreferenceDecision(relativePath, request);

  return {
    mode: selectedMode,
    cleanupMode,
    source: "focused_inventory",
    path: relativePath,
    sizeBytes: bytes,
    sizeHuman: formatBytes(bytes),
    packageBytes: bytes,
    packageHuman: formatBytes(bytes),
    packagePaths: [relativePath],
    packageFileCount: 1,
    targetDirectory: decision === "pode_apagar" ? "/lixeira_segura" : "/revisar/baixo_uso",
    classification: node.classification || "isolado",
    risk,
    structuralRisk: risk,
    deletionDecision: decision,
    relocationDecision: "pode_mexer",
    lastAccessedAt: node.lastAccessedAt,
    lastModifiedAt: node.modifiedAt,
    daysSinceAccess: node.daysSinceAccess,
    incoming: 0,
    outgoing: 0,
    dependencyImpact: node.impact?.dependencies || "metadata",
    userImpact: node.fileKnowledge?.isUserContent || node.fileKnowledge?.isKnownUserFolder ? "medio" : "baixo",
    systemImpact: "nao_afeta_sistema",
    spatialCategories: node.fileKnowledge?.categories || [],
    justification: justificationForCleanupMode(cleanupMode, node),
    requiresConfirmation: true,
    userDecision: userDecision === "relocate" ? { action: "relocate" } : null
  };
}

function deletionDecisionForCleanupMode(cleanupMode, node) {
  if (cleanupMode === "baixo") {
    return "pode_apagar";
  }
  if (cleanupMode === "medio") {
    return node.fileKnowledge?.isLowValueGenerated ? "pode_apagar" : "inutil_provavel";
  }
  return "averiguar";
}

function riskForCleanupMode(cleanupMode, node) {
  const knowledge = node.fileKnowledge || {};
  if (cleanupMode === "baixo") {
    return "baixo";
  }
  if (knowledge.isApplicationState || knowledge.isProjectDependency || knowledge.isSourceCode) {
    return "alto";
  }
  return cleanupMode === "medio" ? "medio" : "medio";
}

function justificationForCleanupMode(cleanupMode, node) {
  const knowledge = node.fileKnowledge || {};
  if (cleanupMode === "baixo") {
    return "inventario de limpeza: cache, temporario ou log de baixo uso";
  }
  if (cleanupMode === "medio") {
    return "inventario de limpeza: arquivo gerado, pacote ou instalador de baixo uso";
  }
  if (knowledge.isUserContent || knowledge.isKnownUserFolder || knowledge.isCloudUserContent) {
    return "inventario de limpeza: conteudo grande ou antigo para revisao";
  }
  if (knowledge.isInstalledApplication) {
    return "inventario de limpeza: payload pesado de aplicativo/jogo";
  }
  return "inventario de limpeza: arquivo grande ou pouco usado para revisao";
}

function cleanupModeIncludedIn(selectedMode, cleanupMode) {
  return CLEANUP_MODE_ORDER.indexOf(cleanupMode) <= CLEANUP_MODE_ORDER.indexOf(selectedMode);
}

function normalizeCleanupMode(mode) {
  return CLEANUP_MODE_ORDER.includes(mode) ? mode : "alto";
}

function focusedCandidateBlocked(node, request = {}) {
  const relative = normalizePreferencePath(node.relativePath);
  if (focusedPathBlocked(relative, request)) {
    return true;
  }
  return focusedPreferenceDecision(relative, request) === "ignore";
}

function focusedPathBlocked(relativePath, request = {}) {
  const relative = normalizePreferencePath(relativePath);
  if (!relative) {
    return false;
  }
  const exemptDirectories = Object.keys(request.preferences?.exemptDirectories || request.exemptDirectories || {});
  return exemptDirectories
    .map(normalizePreferencePath)
    .some((directory) => directory && (relative === directory || relative.startsWith(`${directory}/`)));
}

function focusedPreferenceDecision(relativePath, request = {}) {
  const relative = normalizePreferencePath(relativePath);
  const decisions = request.preferences?.fileDecisions || request.fileDecisions || {};
  return decisions[relative]?.decision || null;
}

function normalizePreferencePath(value) {
  return normalizeRelative(value).replace(/^\/+/, "").toLowerCase();
}

function candidateBytesValue(candidate) {
  return Number(candidate?.packageBytes || candidate?.sizeBytes || candidate?.bytes || 0);
}

function isTextCandidate(lowerName, extension) {
  return TEXT_EXTENSIONS.has(extension) || SPECIAL_TEXT_FILES.has(lowerName);
}

function heavyFolderFileThreshold(options) {
  return clampNumber(options.heavyFolderFileThreshold, 1, 1000000, 2500);
}

function heavyFolderBytesThreshold(options) {
  return clampNumber(options.heavyFolderBytesThreshold, 0, 1024 * 1024 * 1024 * 1024, DEFAULT_HEAVY_FOLDER_BYTES);
}

function heavyFolderRiskThreshold(options) {
  return clampNumber(options.heavyFolderRiskThreshold, 0, 100000, 8);
}

function emptyStats(provider) {
  return {
    provider,
    files: 0,
    directories: 0,
    totalBytes: 0,
    totalHuman: "0 B",
    storedFiles: 0,
    storedDirectories: 0,
    truncated: false,
    elapsedMs: 0,
    dependencyGroups: [],
    heavyFolders: [],
    auxiliaryDatabase: null,
    inventoryReclaimable: finalizeInventoryReclaimable(createInventoryReclaimable())
  };
}

function normalizeRelative(value) {
  const normalized = String(value || ".").replace(/\\/g, "/");
  return path.posix.normalize(normalized).replace(/^\.$/, ".");
}

function filesystemDepth(relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized || normalized === ".") {
    return 0;
  }
  return normalized.split("/").filter(Boolean).length - 1;
}

function daysBetween(date, now) {
  const diff = now.getTime() - date.getTime();
  if (!Number.isFinite(diff) || diff < 0) {
    return 0;
  }
  return Math.floor(diff / 86400000);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes) || 0;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 10 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

module.exports = {
  scanFastInventory,
  scanRelocationCandidates
};
