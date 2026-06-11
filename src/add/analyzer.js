const fs = require("node:fs/promises");
const path = require("node:path");
const { classifyFileKnowledge, loadFileKnowledge } = require("./fileKnowledge");
const { scanFastInventory } = require("../scan/fastInventory");

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

const MAX_SCAN_FILES = 50_000_000;
const MAX_SCAN_DEPTH = 1024;
const DEFAULT_FAST_DETAIL_FILES = 120_000;
const DEFAULT_FAST_DETAIL_DIRECTORIES = 120_000;
const DEFAULT_PROGRESSIVE_FILE_BUDGET = MAX_SCAN_FILES;
const DEFAULT_HEAVY_FOLDER_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_SYSTEM_SKIP_DIRECTORIES = [
  "$WinREAgent",
  "$WINDOWS.~BT",
  "$WINDOWS.~WS",
  "Recovery",
  "System Volume Information",
  "System32",
  "SysWOW64",
  "WindowsApps",
  "WinSxS"
];

const DEFAULT_OPTIONS = {
  adaptive: true,
  scanEngine: "turbo",
  dependencyMode: "metadata",
  fastScanMs: 10 * 60 * 1000,
  fastStoredFiles: DEFAULT_FAST_DETAIL_FILES,
  fastStoredDirectories: DEFAULT_FAST_DETAIL_DIRECTORIES,
  maxFiles: MAX_SCAN_FILES,
  maxDepth: MAX_SCAN_DEPTH,
  maxFileSizeBytes: 512 * 1024,
  unusedDaysThreshold: loadFileKnowledge().recentUse?.unusedWindowDays || 30,
  frequentUseDaysThreshold: loadFileKnowledge().recentUse?.frequentWindowDays || 7,
  includeHidden: true,
  includeProgramFiles: true,
  sortEntries: false,
  greedyScan: true,
  skipReparsePoints: true,
  maxScanMs: 0,
  progressiveStepMaxMs: 10000,
  maxDependencyReadBytes: 512 * 1024,
  maxDependencyReadMs: 80,
  targetedDfsProbe: true,
  targetedDfsMaxFiles: 2000,
  heavyFolderFileThreshold: 2500,
  heavyFolderBytesThreshold: DEFAULT_HEAVY_FOLDER_BYTES,
  heavyFolderRiskThreshold: 8,
  skipDirectories: DEFAULT_SYSTEM_SKIP_DIRECTORIES
};

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

const JS_EXTENSIONS = [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".css", ".scss", ".vue", ".svelte"];
const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less"];
const HTML_EXTENSIONS = [".html", ".htm", ".css", ".js", ".mjs", ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"];
const PY_EXTENSIONS = [".py", "/__init__.py"];
const C_EXTENSIONS = [".h", ".hpp", ".c", ".cc", ".cpp"];
const RUST_EXTENSIONS = [".rs", "/mod.rs"];

async function analyzeDirectory(rootPath, rawOptions = {}) {
  const root = path.resolve(rootPath || process.cwd());
  const startedAt = Date.now();
  const warnings = [];
  const skipped = [];
  const nodes = [];
  const fileNodes = [];
  const fileByKey = new Map();
  const rootsSeen = new Set();
  const directoryFingerprints = new Set();
  let stopReason = null;
  let lastProgressAt = 0;

  let rootStat;
  try {
    rootStat = await fs.stat(root);
  } catch (error) {
    throw new Error(`Diretorio nao encontrado: ${root}`);
  }

  if (!rootStat.isDirectory()) {
    throw new Error(`O caminho informado nao e um diretorio: ${root}`);
  }

  const wantsTurbo = shouldUseTurboScan(rawOptions);
  const scaleEstimate = wantsTurbo
    ? { scale: "massivo", sampledFiles: 0, sampledDirectories: 0, sampledEntries: 0, sampledDepth: 0, provider: "turbo" }
    : await estimateDirectoryScale(root);
  const options = normalizeOptions(rawOptions, scaleEstimate);

  if (options.scanEngine === "turbo") {
    const inventory = await scanFastInventory(root, options, rawOptions.onScanProgress);
    return buildAddReportFromCollectedNodes({
      root,
      rawOptions: {
        ...rawOptions,
        dependencyMode: "metadata",
        skipGraphViews: rawOptions.skipGraphViews ?? true,
        skipSimulation: rawOptions.skipSimulation ?? true
      },
      options,
      scaleEstimate,
      nodes: inventory.nodes,
      fileNodes: inventory.fileNodes,
      skipped: inventory.skipped,
      warnings: inventory.warnings,
      startedAt,
      stopReason: inventory.stopReason,
      inventoryStats: inventory.stats
    });
  }

  await walkDirectory(root, "", 0);
  if (stopReason) {
    warnings.push(stopReason);
  }

  return buildAddReportFromCollectedNodes({
    root,
    rawOptions,
    options,
    scaleEstimate,
    nodes,
    fileNodes,
    skipped,
    warnings,
    startedAt,
    stopReason
  });

  async function walkDirectory(absoluteDirectory, relativeDirectory, depth) {
    const queue = [{ absoluteDirectory, relativeDirectory, depth }];
    let queueIndex = 0;

    while (queueIndex < queue.length) {
      if (shouldStopScanning()) {
        return;
      }

      const current = queue[queueIndex];
      queueIndex += 1;

      if (current.depth > options.maxDepth) {
        skipped.push({
          path: current.relativeDirectory || ".",
          reason: `profundidade maior que ${options.maxDepth}`
        });
        continue;
      }

      const directoryKey = normalizeKey(current.relativeDirectory || ".");
      if (rootsSeen.has(directoryKey)) {
        continue;
      }
      rootsSeen.add(directoryKey);

      let directoryStat;
      try {
        directoryStat = await fs.lstat(current.absoluteDirectory);
      } catch (error) {
        skipped.push({
          path: current.relativeDirectory || ".",
          reason: `sem metadados do diretorio: ${error.code || error.message}`
        });
        continue;
      }

      if (current.depth > 0 && options.skipReparsePoints && directoryStat.isSymbolicLink()) {
        skipped.push({ path: current.relativeDirectory || ".", reason: "junction/link de diretorio ignorado" });
        continue;
      }

      const fingerprint = directoryStat.dev || directoryStat.ino
        ? `${directoryStat.dev}:${directoryStat.ino}`
        : normalizeKey(current.absoluteDirectory);
      if (directoryFingerprints.has(fingerprint)) {
        skipped.push({ path: current.relativeDirectory || ".", reason: "diretorio ja visitado por outro caminho" });
        continue;
      }
      directoryFingerprints.add(fingerprint);
      emitScanProgress(current.relativeDirectory || ".", current.depth);

      let entries;
      try {
        entries = await fs.readdir(current.absoluteDirectory, { withFileTypes: true });
      } catch (error) {
        skipped.push({
          path: current.relativeDirectory || ".",
          reason: `sem permissao de leitura: ${error.code || error.message}`
        });
        continue;
      }

      if (options.sortEntries) {
        entries.sort((a, b) => a.name.localeCompare(b.name));
      } else if (options.greedyScan) {
        entries.sort((a, b) => entryScanPriority(a) - entryScanPriority(b));
      }

      for (const entry of entries) {
        if (shouldStopScanning()) {
          return;
        }

        if (fileNodes.length >= options.maxFiles) {
          stopReason = `Limite de ${options.maxFiles} arquivos atingido; o restante foi ignorado.`;
          return;
        }

        if (!options.includeHidden && entry.name.startsWith(".")) {
          skipped.push({ path: normalizeRelative(path.join(current.relativeDirectory, entry.name)), reason: "oculto" });
          continue;
        }

        const absolutePath = path.join(current.absoluteDirectory, entry.name);
        const relativePath = normalizeRelative(path.join(current.relativeDirectory, entry.name));
        const protectedReasons = getProtectedReasons(absolutePath, relativePath, entry.name, options);

        if (entry.isSymbolicLink()) {
          skipped.push({ path: relativePath, reason: "link simbolico ignorado" });
          continue;
        }

        if (entry.isDirectory()) {
          nodes.push({
            id: `dir:${relativePath}`,
            kind: "directory",
            name: entry.name,
            relativePath,
            absolutePath,
            scanDepth: current.depth + 1,
            size: 0,
            extension: "",
            protectedReasons,
            classification: protectedReasons.length ? "critico_protegido" : "diretorio",
            risk: protectedReasons.length ? "alto" : "baixo"
          });

          if (shouldSkipDirectory(entry.name, protectedReasons, options)) {
            skipped.push({ path: relativePath, reason: protectedReasons[0] || "diretorio pesado ou gerado" });
            continue;
          }

          queue.push({ absoluteDirectory: absolutePath, relativeDirectory: relativePath, depth: current.depth + 1 });
          continue;
        }

        if (!entry.isFile()) {
          skipped.push({ path: relativePath, reason: "tipo de entrada nao suportado" });
          continue;
        }

        let stat;
        try {
          stat = await fs.stat(absolutePath);
        } catch (error) {
          skipped.push({ path: relativePath, reason: `sem metadados: ${error.code || error.message}` });
          continue;
        }

        const extension = path.extname(entry.name).toLowerCase();
        const lowerName = entry.name.toLowerCase();
        const fileKnowledge = classifyFileKnowledge(relativePath, entry.name, extension, {
          size: stat.size,
          modifiedAt: stat.mtime,
          lastAccessedAt: stat.atime,
          createdAt: stat.birthtime
        });
        const canReadContent = isTextCandidate(lowerName, extension) && stat.size <= options.maxFileSizeBytes;
        const node = {
          id: `file:${relativePath}`,
          kind: "file",
          name: entry.name,
          relativePath,
          absolutePath,
          extension,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          lastAccessedAt: stat.atime.toISOString(),
          createdAt: stat.birthtime.toISOString(),
          daysSinceAccess: daysBetween(stat.atime, new Date()),
          protectedReasons,
          fileKnowledge,
          dependencyGroup: fileKnowledge.dependencyGroup,
          scanStrategy: {
            discovery: "balanced_search_node",
            inventoryProvider: "node",
            dependencyGroup: fileKnowledge.dependencyGroup
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
          scanDepth: current.depth,
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
          canReadContent,
          readError: null,
          detectedDependencies: [],
          initialUnresolvedDependencies: 0,
          initialUnresolvedSpecifiers: [],
          unresolvedDependencies: 0,
          unresolvedSpecifiers: [],
          externalDependencies: 0
        };

        if (!canReadContent && isTextCandidate(lowerName, extension)) {
          node.initialUnresolvedDependencies += 1;
          node.initialUnresolvedSpecifiers.push({
            specifier: "<arquivo grande>",
            type: "conteudo_nao_lido",
            line: null
          });
          node.unresolvedDependencies = node.initialUnresolvedDependencies;
          node.unresolvedSpecifiers = [...node.initialUnresolvedSpecifiers];
        }

        nodes.push(node);
        fileNodes.push(node);
        fileByKey.set(normalizeKey(relativePath), node);
        emitScanProgress(relativePath, current.depth);
      }
    }
  }

  function shouldStopScanning() {
    if (stopReason) {
      return true;
    }
    if (options.maxScanMs > 0 && Date.now() - startedAt >= options.maxScanMs) {
      stopReason = `Orcamento de tempo da etapa atingido (${options.maxScanMs} ms); resultado parcial gerado.`;
      return true;
    }
    return false;
  }

  function emitScanProgress(currentPath, depth) {
    if (typeof rawOptions.onScanProgress !== "function") {
      return;
    }
    const now = Date.now();
    if (now - lastProgressAt < 1000 && fileNodes.length % 1000 !== 0) {
      return;
    }
    lastProgressAt = now;
    rawOptions.onScanProgress({
      currentPath,
      depth,
      files: fileNodes.length,
      directories: nodes.filter((node) => node.kind === "directory").length,
      totalBytes: fileNodes.reduce((sum, node) => sum + (node.size || 0), 0),
      elapsedMs: now - startedAt,
      stoppedEarly: Boolean(stopReason)
    });
  }
}

async function buildAddReportFromCollectedNodes({
  root,
  rawOptions,
  options,
  scaleEstimate,
  nodes,
  fileNodes,
  skipped,
  warnings,
  startedAt,
  stopReason = null,
  inventoryStats = null
}) {
  const scanGrouping = prepareScanGrouping(fileNodes, inventoryStats, options);
  resetAnalysisFields(fileNodes);
  const indexes = buildIndexes(fileNodes);
  const edges = [];
  const edgeKeys = new Set();
  const dependencyTypes = {};
  const shouldParseDependencies = rawOptions.skipDependencyParsing !== true
    && rawOptions.dependencyMode !== "metadata"
    && options.dependencyMode !== "metadata";
  const targetedProbeBudget = {
    remaining: options.targetedDfsProbe ? options.targetedDfsMaxFiles : 0,
    scheduled: 0,
    skipped: 0
  };

  for (const node of fileNodes) {
    const targetedProbe = shouldUseTargetedDfsProbe(node, options, targetedProbeBudget);
    if ((!shouldParseDependencies && !targetedProbe) || (!node.canReadContent && !targetedProbe)) {
      continue;
    }

    const dependencies = await readOrReuseDependencies(node, rawOptions._dependencyCache, options, {
      targetedProbe
    });
    node.detectedDependencies = dependencies;

    for (const dependency of dependencies) {
      const resolved = resolveDependency(node.relativePath, dependency, indexes);
      if (resolved) {
        const key = `${node.id}->${resolved.id}:${dependency.type}`;
        if (!edgeKeys.has(key)) {
          edgeKeys.add(key);
          const edge = {
            id: key,
            source: node.id,
            target: resolved.id,
            sourcePath: node.relativePath,
            targetPath: resolved.relativePath,
            type: dependency.type,
            specifier: dependency.specifier,
            line: dependency.line,
            confidence: dependency.confidence
          };
          edges.push(edge);
          node.outgoing += 1;
          resolved.incoming += 1;
          resolved.incomingFrom.push(node.id);
          node.outgoingTo.push(resolved.id);
          dependencyTypes[dependency.type] = (dependencyTypes[dependency.type] || 0) + 1;
        }
      } else if (dependency.localIntent) {
        node.unresolvedDependencies += 1;
        node.unresolvedSpecifiers.push({
          specifier: dependency.specifier,
          type: dependency.type,
          line: dependency.line
        });
      } else {
        node.externalDependencies += 1;
      }
    }
  }

  const cycles = detectCyclesDfs(fileNodes, edges);
  applyCycleMetadata(fileNodes, cycles);
  const components = buildComponents(fileNodes, edges);
  const fileNodeById = new Map(fileNodes.map((node) => [node.id, node]));
  const depthById = computeDepths(fileNodes);
  applyComponentMetadata(fileNodes, components);
  applyImpactMetadata(fileNodes);

  for (const node of fileNodes) {
    node.depth = depthById.get(node.id) || 0;
    classifyNode(node, options);
  }
  applySimulationMetadata(fileNodes);

  for (const component of components) {
    const componentNodes = component.nodeIds.map((id) => fileNodeById.get(id)).filter(Boolean);
    component.depth = Math.max(0, ...componentNodes.map((node) => node.depth));
    component.criticalRiskNodes = componentNodes.filter((node) => node.risk === "critico").length;
    component.highRiskNodes = componentNodes.filter((node) => node.risk === "alto").length;
    component.mediumRiskNodes = componentNodes.filter((node) => node.risk === "medio").length;
    component.hasProtected = componentNodes.some((node) => node.classification === "critico_protegido");
    component.hasCycle = componentNodes.some((node) => node.inCycle);
    component.risk = component.criticalRiskNodes > 0 || component.hasCycle
      ? "critico"
      : component.hasProtected || component.highRiskNodes > 0
        ? "alto"
        : component.mediumRiskNodes > 0
          ? "medio"
          : "baixo";
  }

  scanGrouping.targetedDfs = {
    scheduled: targetedProbeBudget.scheduled,
    skipped: targetedProbeBudget.skipped,
    remainingBudget: targetedProbeBudget.remaining,
    parsed: fileNodes.filter((node) => node.dependencyProbe?.status === "parsed").length,
    partialReads: fileNodes.filter((node) => node.dependencyProbe?.partialRead).length
  };

  const summary = buildSummary(nodes, fileNodes, edges, components, cycles, skipped, warnings, startedAt, stopReason, inventoryStats, scanGrouping);
  const simulation = rawOptions.skipSimulation ? null : buildSimulation(fileNodes);
  const graphViews = rawOptions.skipGraphViews ? emptyGraphViews() : buildGraphViews(nodes, fileNodes, edges);

  return {
    schemaVersion: 1,
    algorithm: "A.D.D",
    rootPath: root,
    options,
    scaleEstimate,
    summary,
    nodes: nodes.map(stripInternalNodeFields),
    edges,
    components,
    cycles,
    graphViews,
    simulation,
    skipped,
    warnings
  };
}

function prepareScanGrouping(fileNodes, inventoryStats, options = DEFAULT_OPTIONS) {
  const heavyFolders = Array.isArray(inventoryStats?.heavyFolders) && inventoryStats.heavyFolders.length
    ? inventoryStats.heavyFolders.slice(0, 100)
    : buildHeavyFoldersFromNodes(fileNodes, options);
  applyHeavyFolderMetadata(fileNodes, heavyFolders, options);

  const dependencyGroups = Array.isArray(inventoryStats?.dependencyGroups) && inventoryStats.dependencyGroups.length
    ? inventoryStats.dependencyGroups.slice(0, 200)
    : buildDependencyGroupSummary(fileNodes).slice(0, 200);

  return {
    strategy: "balanced_search_horizontal_dpn",
    heavyFolders,
    dependencyGroups,
    auxiliaryDatabase: inventoryStats?.auxiliaryDatabase || {
      provider: inventoryStats?.provider || "node",
      filesIndexed: fileNodes.length,
      groupsIndexed: dependencyGroups.length,
      heavyFoldersIndexed: heavyFolders.length
    },
    targetedDfs: {
      scheduled: 0,
      skipped: 0,
      remainingBudget: options.targetedDfsMaxFiles,
      parsed: 0,
      partialReads: 0
    }
  };
}

function buildHeavyFoldersFromNodes(fileNodes, options = DEFAULT_OPTIONS) {
  const folders = new Map();

  for (const node of fileNodes) {
    for (const folderPath of folderCandidatesFor(node.relativePath)) {
      if (!folders.has(folderPath)) {
        folders.set(folderPath, {
          path: folderPath,
          files: 0,
          bytes: 0,
          riskScore: 0,
          categories: {},
          dependencyGroups: {},
          samples: []
        });
      }
      const folder = folders.get(folderPath);
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
  }

  return Array.from(folders.values())
    .filter((folder) => isHeavyFolder(folder, options))
    .sort((a, b) => heavyFolderScore(b) - heavyFolderScore(a) || String(a.path).localeCompare(String(b.path)))
    .slice(0, 100)
    .map((folder) => ({
      ...folder,
      bytesHuman: formatBytes(folder.bytes),
      reason: heavyFolderReason(folder, options),
      topDependencyGroups: topEntries(folder.dependencyGroups, 6),
      topCategories: topEntries(folder.categories, 6)
    }));
}

function applyHeavyFolderMetadata(fileNodes, heavyFolders, options = DEFAULT_OPTIONS) {
  const orderedFolders = (heavyFolders || [])
    .slice()
    .sort((a, b) => String(b.path || ".").length - String(a.path || ".").length);

  for (const node of fileNodes) {
    const folder = orderedFolders.find((candidate) => pathContainsFile(candidate.path || ".", node.relativePath));
    if (folder) {
      node.heavyFolder = {
        path: folder.path,
        files: folder.files,
        bytes: folder.bytes,
        bytesHuman: folder.bytesHuman || formatBytes(folder.bytes),
        riskScore: folder.riskScore,
        reason: folder.reason || heavyFolderReason(folder, options)
      };
    } else {
      node.heavyFolder = null;
    }

    node.dependencyGroup = node.dependencyGroup || node.fileKnowledge?.dependencyGroup || "dpn:incerto";
    node.scanStrategy = {
      ...(node.scanStrategy || {}),
      discovery: node.scanStrategy?.discovery || "balanced_search_node",
      dependencyGroup: node.dependencyGroup,
      heavyFolderPath: node.heavyFolder?.path || null
    };
    node.dependencyProbe = dependencyProbeFor(node, options);
  }
}

function dependencyProbeFor(node, options = DEFAULT_OPTIONS) {
  if (!options.targetedDfsProbe) {
    return { enabled: false, reason: "disabled", status: "not_needed" };
  }
  if (!node.heavyFolder) {
    return { enabled: false, reason: "fora_de_hf", status: "not_needed" };
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
  const riskyHeavyFolder = (node.heavyFolder.riskScore || 0) >= options.heavyFolderRiskThreshold;

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
    maxBytes: options.maxDependencyReadBytes,
    maxMs: options.maxDependencyReadMs
  };
}

function shouldUseTargetedDfsProbe(node, options, budget) {
  if (!node.dependencyProbe?.enabled) {
    if (node.dependencyProbe?.status === "skipped_non_text") {
      budget.skipped += 1;
    }
    return false;
  }
  if (!options.targetedDfsProbe || budget.remaining <= 0) {
    node.dependencyProbe.status = "budget_exhausted";
    budget.skipped += 1;
    return false;
  }
  budget.remaining -= 1;
  budget.scheduled += 1;
  node.dependencyProbe.status = "scheduled";
  return true;
}

function buildDependencyGroupSummary(fileNodes) {
  const groups = new Map();
  for (const node of fileNodes) {
    const key = node.dependencyGroup || node.fileKnowledge?.dependencyGroup || "dpn:incerto";
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        files: 0,
        bytes: 0,
        riskCategory: node.fileKnowledge?.riskCategory || "incerto",
        typeCategory: node.fileKnowledge?.typeCategory || "desconhecido",
        lastUseBucket: node.fileKnowledge?.lastUseBucket || "idade_desconhecida",
        createdBucket: node.fileKnowledge?.createdBucket || "idade_desconhecida",
        samples: []
      });
    }
    const group = groups.get(key);
    group.files += 1;
    group.bytes += node.size || 0;
    if (group.samples.length < 8) {
      group.samples.push(node.relativePath);
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => b.files - a.files || b.bytes - a.bytes || a.key.localeCompare(b.key))
    .map((group) => ({
      ...group,
      bytesHuman: formatBytes(group.bytes)
    }));
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

function isHeavyFolder(folder, options = DEFAULT_OPTIONS) {
  return (folder.files || 0) >= options.heavyFolderFileThreshold
    || (folder.bytes || 0) >= options.heavyFolderBytesThreshold
    || (folder.riskScore || 0) >= options.heavyFolderRiskThreshold;
}

function heavyFolderScore(folder) {
  return ((folder.files || 0) * 1000) + Math.min(folder.bytes || 0, 1024 * 1024 * 1024 * 1024) + ((folder.riskScore || 0) * 100000);
}

function heavyFolderReason(folder, options = DEFAULT_OPTIONS) {
  const reasons = [];
  if ((folder.files || 0) >= options.heavyFolderFileThreshold) {
    reasons.push("muitos_arquivos");
  }
  if ((folder.bytes || 0) >= options.heavyFolderBytesThreshold) {
    reasons.push("muitos_bytes");
  }
  if ((folder.riskScore || 0) >= options.heavyFolderRiskThreshold) {
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

function resetAnalysisFields(fileNodes) {
  for (const node of fileNodes) {
    node.incoming = 0;
    node.outgoing = 0;
    node.incomingFrom = [];
    node.outgoingTo = [];
    node.depth = 0;
    node.impactCount = 0;
    node.componentId = null;
    node.componentSize = 1;
    node.dfsColor = "branco";
    node.inCycle = false;
    node.cycleBlockId = null;
    node.cycleBlockIds = [];
    node.cycleGroupSize = 0;
    node.dependsOn = [];
    node.dependents = [];
    node.classification = "isolado";
    node.risk = "baixo";
    node.riskScore = 0;
    node.riskReasons = [];
    node.impact = {
      system: "desconhecido",
      user: "desconhecido",
      dependencies: "desconhecido"
    };
    node.utilityStatus = "desconhecido";
    node.deletionDecision = "averiguar";
    node.relocationDecision = "pode_mexer";
    node.simulationAction = "separar_como_isolado";
    node.simulation = null;
    node.detectedDependencies = [];
    node.unresolvedDependencies = node.initialUnresolvedDependencies || 0;
    node.unresolvedSpecifiers = [...(node.initialUnresolvedSpecifiers || [])];
    node.externalDependencies = 0;
  }
}

async function* analyzeDirectoryProgressive(rootPath, rawOptions = {}) {
  const root = path.resolve(rootPath || process.cwd());
  const startedAt = Date.now();
  const warnings = [];
  const skipped = [];
  const nodes = [];
  const fileNodes = [];
  const rootsSeen = new Set();
  const directoryFingerprints = new Set();
  const seenFileIds = new Set();
  const dependencyCache = new Map();
  const queue = [{ absoluteDirectory: root, relativeDirectory: "", depth: 0 }];

  let rootStat;
  try {
    rootStat = await fs.stat(root);
  } catch (error) {
    throw new Error(`Diretorio nao encontrado: ${root}`);
  }

  if (!rootStat.isDirectory()) {
    throw new Error(`O caminho informado nao e um diretorio: ${root}`);
  }

  const wantsTurbo = shouldUseTurboScan(rawOptions);
  const scaleEstimate = wantsTurbo
    ? { scale: "massivo", sampledFiles: 0, sampledDirectories: 0, sampledEntries: 0, sampledDepth: 0, provider: "turbo" }
    : await estimateDirectoryScale(root);
  const baseOptions = normalizeOptions(rawOptions, scaleEstimate);

  if (baseOptions.scanEngine === "turbo") {
    const inventory = await scanFastInventory(root, baseOptions, rawOptions.onScanProgress);
    const addReport = await buildAddReportFromCollectedNodes({
      root,
      rawOptions: {
        ...rawOptions,
        dependencyMode: "metadata",
        skipGraphViews: true,
        skipSimulation: true
      },
      options: {
        ...baseOptions,
        skipGraphViews: true,
        skipSimulation: true
      },
      scaleEstimate,
      nodes: inventory.nodes,
      fileNodes: inventory.fileNodes,
      skipped: inventory.skipped,
      warnings: inventory.warnings,
      startedAt,
      stopReason: inventory.stopReason,
      inventoryStats: inventory.stats
    });
    addReport.progressive = {
      enabled: true,
      experimental: false,
      singlePass: true,
      turbo: true,
      provider: inventory.provider,
      step: 1,
      totalSteps: 1,
      currentDepth: baseOptions.maxDepth,
      minDepth: 1,
      maxDepth: baseOptions.maxDepth,
      fileBudget: baseOptions.maxFiles,
      percent: 100,
      queueRemaining: 0,
      newNodeCount: addReport.nodes.filter((node) => node.kind === "file").length,
      newBytes: addReport.summary.totalBytes,
      newHuman: addReport.summary.totalHuman,
      cumulativeBytes: addReport.summary.totalBytes,
      cumulativeHuman: addReport.summary.totalHuman,
      depthBreakdown: addReport.summary.depthBreakdown,
      depthMemory: addReport.summary.depthBreakdown,
      newNodes: addReport.nodes.filter((node) => node.kind === "file").map((node) => node.relativePath).slice(0, 30),
      stoppedEarly: addReport.summary.stoppedEarly,
      stopReason: addReport.summary.stopReason,
      isFinal: true
    };
    yield addReport;
    return;
  }

  const minDepth = clampInteger(rawOptions.progressiveMinDepth ?? 1, 1, baseOptions.maxDepth, 1);
  const maxDepth = baseOptions.maxDepth;
  const fileBudget = clampInteger(
    rawOptions.progressiveMaxFiles ?? baseOptions.maxFiles,
    100,
    baseOptions.maxFiles,
    baseOptions.maxFiles
  );
  const sliceMs = baseOptions.progressiveStepMaxMs;
  const reportOptions = {
    ...baseOptions,
    adaptive: false,
    maxDepth,
    maxFiles: fileBudget,
    saveState: false,
    skipGraphViews: true,
    skipSimulation: true
  };
  let queueIndex = 0;
  let step = 0;
  let currentDepth = 0;
  let lastSnapshotAt = Date.now();
  let stopReason = null;

  while (queueIndex < queue.length && !stopReason) {
    const current = queue[queueIndex];
    queueIndex += 1;
    currentDepth = Math.max(currentDepth, current.depth);

    if (current.depth > maxDepth) {
      skipped.push({ path: current.relativeDirectory || ".", reason: `profundidade maior que ${maxDepth}` });
      continue;
    }

    if (current.depth >= minDepth) {
      rawOptions.onScanProgress?.({
        currentPath: current.relativeDirectory || ".",
        depth: current.depth,
        files: fileNodes.length,
        directories: nodes.filter((node) => node.kind === "directory").length,
        totalBytes: fileNodes.reduce((sum, node) => sum + (node.size || 0), 0),
        elapsedMs: Date.now() - startedAt,
        queueRemaining: Math.max(0, queue.length - queueIndex)
      });
    }

    const directoryKey = normalizeKey(current.relativeDirectory || ".");
    if (rootsSeen.has(directoryKey)) {
      continue;
    }
    rootsSeen.add(directoryKey);

    let directoryStat;
    try {
      directoryStat = await fs.lstat(current.absoluteDirectory);
    } catch (error) {
      skipped.push({
        path: current.relativeDirectory || ".",
        reason: `sem metadados do diretorio: ${error.code || error.message}`
      });
      continue;
    }

    if (current.depth > 0 && reportOptions.skipReparsePoints && directoryStat.isSymbolicLink()) {
      skipped.push({ path: current.relativeDirectory || ".", reason: "junction/link de diretorio ignorado" });
      continue;
    }

    const fingerprint = directoryStat.dev || directoryStat.ino
      ? `${directoryStat.dev}:${directoryStat.ino}`
      : normalizeKey(current.absoluteDirectory);
    if (directoryFingerprints.has(fingerprint)) {
      skipped.push({ path: current.relativeDirectory || ".", reason: "diretorio ja visitado por outro caminho" });
      continue;
    }
    directoryFingerprints.add(fingerprint);

    let entries;
    try {
      entries = await fs.readdir(current.absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      skipped.push({
        path: current.relativeDirectory || ".",
        reason: `sem permissao de leitura: ${error.code || error.message}`
      });
      continue;
    }

    if (reportOptions.sortEntries) {
      entries.sort((a, b) => a.name.localeCompare(b.name));
    } else if (reportOptions.greedyScan) {
      entries.sort((a, b) => entryScanPriority(a) - entryScanPriority(b));
    }

    for (const entry of entries) {
      if (fileNodes.length >= fileBudget) {
        stopReason = `Limite de ${fileBudget} arquivos atingido; o restante foi ignorado.`;
        break;
      }

      if (!reportOptions.includeHidden && entry.name.startsWith(".")) {
        skipped.push({ path: normalizeRelative(path.join(current.relativeDirectory, entry.name)), reason: "oculto" });
        continue;
      }

      const absolutePath = path.join(current.absoluteDirectory, entry.name);
      const relativePath = normalizeRelative(path.join(current.relativeDirectory, entry.name));
      const protectedReasons = getProtectedReasons(absolutePath, relativePath, entry.name, reportOptions);

      if (entry.isSymbolicLink()) {
        skipped.push({ path: relativePath, reason: "link simbolico ignorado" });
        continue;
      }

      if (entry.isDirectory()) {
        nodes.push({
          id: `dir:${relativePath}`,
          kind: "directory",
          name: entry.name,
          relativePath,
          absolutePath,
          scanDepth: current.depth + 1,
          size: 0,
          extension: "",
          protectedReasons,
          classification: protectedReasons.length ? "critico_protegido" : "diretorio",
          risk: protectedReasons.length ? "alto" : "baixo"
        });

        if (shouldSkipDirectory(entry.name, protectedReasons, reportOptions)) {
          skipped.push({ path: relativePath, reason: protectedReasons[0] || "diretorio pesado ou gerado" });
          continue;
        }

        queue.push({ absoluteDirectory: absolutePath, relativeDirectory: relativePath, depth: current.depth + 1 });
        continue;
      }

      if (!entry.isFile()) {
        skipped.push({ path: relativePath, reason: "tipo de entrada nao suportado" });
        continue;
      }

      let stat;
      try {
        stat = await fs.stat(absolutePath);
      } catch (error) {
        skipped.push({ path: relativePath, reason: `sem metadados: ${error.code || error.message}` });
        continue;
      }

      const extension = path.extname(entry.name).toLowerCase();
      const lowerName = entry.name.toLowerCase();
      const fileKnowledge = classifyFileKnowledge(relativePath, entry.name, extension, {
        size: stat.size,
        modifiedAt: stat.mtime,
        lastAccessedAt: stat.atime,
        createdAt: stat.birthtime
      });
      const canReadContent = isTextCandidate(lowerName, extension) && stat.size <= reportOptions.maxFileSizeBytes;
      const node = {
        id: `file:${relativePath}`,
        kind: "file",
        name: entry.name,
        relativePath,
        absolutePath,
        extension,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        lastAccessedAt: stat.atime.toISOString(),
        createdAt: stat.birthtime.toISOString(),
        daysSinceAccess: daysBetween(stat.atime, new Date()),
        protectedReasons,
        fileKnowledge,
        dependencyGroup: fileKnowledge.dependencyGroup,
        scanStrategy: {
          discovery: "balanced_search_node",
          inventoryProvider: "node",
          dependencyGroup: fileKnowledge.dependencyGroup
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
        scanDepth: current.depth,
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
        canReadContent,
        readError: null,
        detectedDependencies: [],
        initialUnresolvedDependencies: 0,
        initialUnresolvedSpecifiers: [],
        unresolvedDependencies: 0,
        unresolvedSpecifiers: [],
        externalDependencies: 0
      };

      if (!canReadContent && isTextCandidate(lowerName, extension)) {
        node.initialUnresolvedDependencies += 1;
        node.initialUnresolvedSpecifiers.push({
          specifier: "<arquivo grande>",
          type: "conteudo_nao_lido",
          line: null
        });
        node.unresolvedDependencies = node.initialUnresolvedDependencies;
        node.unresolvedSpecifiers = [...node.initialUnresolvedSpecifiers];
      }

      nodes.push(node);
      fileNodes.push(node);

      if (Date.now() - lastSnapshotAt >= sliceMs) {
        step += 1;
        lastSnapshotAt = Date.now();
        yield await buildProgressiveSnapshot(false);
      }
    }
  }

  if (stopReason) {
    warnings.push(stopReason);
  }
  step += 1;
  yield await buildProgressiveSnapshot(true);

  async function buildProgressiveSnapshot(isFinal) {
    const addReport = await buildAddReportFromCollectedNodes({
      root,
      rawOptions: {
        ...rawOptions,
        skipGraphViews: true,
        skipSimulation: true,
        _dependencyCache: dependencyCache
      },
      options: reportOptions,
      scaleEstimate,
      nodes,
      fileNodes,
      skipped,
      warnings,
      startedAt,
      stopReason
    });
    const fileIds = addReport.nodes
      .filter((node) => node.kind === "file")
      .map((node) => node.id);
    const newFileIds = fileIds.filter((id) => !seenFileIds.has(id));
    const newNodes = addReport.nodes.filter((node) => newFileIds.includes(node.id));
    for (const id of fileIds) {
      seenFileIds.add(id);
    }
    const processedDirectories = queueIndex;
    const totalKnownDirectories = Math.max(1, queue.length);

    addReport.progressive = {
      enabled: true,
      experimental: true,
      singlePass: true,
      step,
      totalSteps: null,
      currentDepth,
      minDepth,
      maxDepth,
      fileBudget,
      percent: isFinal ? 100 : Math.min(99, Math.round((processedDirectories / totalKnownDirectories) * 100)),
      queueRemaining: Math.max(0, queue.length - queueIndex),
      newNodeCount: newFileIds.length,
      newBytes: newNodes.reduce((sum, node) => sum + (node.size || 0), 0),
      newHuman: formatBytes(newNodes.reduce((sum, node) => sum + (node.size || 0), 0)),
      cumulativeBytes: addReport.summary.totalBytes,
      cumulativeHuman: formatBytes(addReport.summary.totalBytes),
      depthBreakdown: addReport.summary.depthBreakdown,
      depthMemory: addReport.summary.depthBreakdown,
      newNodes: newNodes.map((node) => node.relativePath).slice(0, 30),
      stoppedEarly: addReport.summary.stoppedEarly,
      stopReason: addReport.summary.stopReason,
      isFinal
    };

    return addReport;
  }
}

async function estimateDirectoryScale(root) {
  const queue = [{ absolutePath: root, depth: 0 }];
  const visited = new Set();
  const maxEntries = 16000;
  let sampledFiles = 0;
  let sampledDirectories = 0;
  let maxObservedDepth = 0;

  while (queue.length && sampledFiles + sampledDirectories < maxEntries) {
    const current = queue.shift();
    const key = current.absolutePath.toLowerCase();
    if (visited.has(key) || current.depth > 5) {
      continue;
    }
    visited.add(key);
    maxObservedDepth = Math.max(maxObservedDepth, current.depth);

    let entries = [];
    try {
      entries = await fs.readdir(current.absolutePath, { withFileTypes: true });
    } catch (error) {
      continue;
    }

    for (const entry of entries) {
      if (sampledFiles + sampledDirectories >= maxEntries) {
        break;
      }
      if (entry.isDirectory()) {
        sampledDirectories += 1;
        if (!DEFAULT_OPTIONS.skipDirectories.some((name) => name.toLowerCase() === entry.name.toLowerCase())) {
          queue.push({ absolutePath: path.join(current.absolutePath, entry.name), depth: current.depth + 1 });
        }
      } else if (entry.isFile()) {
        sampledFiles += 1;
      }
    }
  }

  const sampledEntries = sampledFiles + sampledDirectories;
  const density = Math.max(1, sampledEntries / Math.max(1, visited.size));
  const estimatedFiles = Math.round(sampledFiles * Math.max(1, density / 8));
  const scale = sampledEntries >= 1400 || estimatedFiles >= 12000
    ? "massivo"
    : sampledEntries >= 700 || estimatedFiles >= 5000
      ? "grande"
      : sampledEntries >= 180 || estimatedFiles >= 1200
        ? "medio"
        : "pequeno";

  return {
    scale,
    sampledFiles,
    sampledDirectories,
    sampledEntries,
    sampledDepth: maxObservedDepth
  };
}

function normalizeOptions(rawOptions, scaleEstimate = { scale: "medio" }) {
  const adaptive = rawOptions.adaptive !== false;
  const adaptiveDefaults = adaptiveProfile(scaleEstimate.scale);
  const options = {
    ...DEFAULT_OPTIONS,
    ...(adaptive ? adaptiveDefaults : {}),
    ...rawOptions
  };

  options.adaptive = adaptive;
  options.scanEngine = normalizeScanEngine(options.scanEngine);
  options.dependencyMode = options.dependencyMode === "full" ? "full" : "metadata";
  options.maxFiles = clampInteger(options.maxFiles, 100, MAX_SCAN_FILES, DEFAULT_OPTIONS.maxFiles);
  options.maxDepth = clampInteger(options.maxDepth, 1, MAX_SCAN_DEPTH, DEFAULT_OPTIONS.maxDepth);
  options.maxFileSizeBytes = clampInteger(options.maxFileSizeBytes, 16 * 1024, 5 * 1024 * 1024, DEFAULT_OPTIONS.maxFileSizeBytes);
  options.maxDependencyReadBytes = clampInteger(
    options.maxDependencyReadBytes,
    4 * 1024,
    5 * 1024 * 1024,
    Math.min(DEFAULT_OPTIONS.maxDependencyReadBytes, options.maxFileSizeBytes)
  );
  options.maxDependencyReadMs = clampInteger(options.maxDependencyReadMs, 10, 5000, DEFAULT_OPTIONS.maxDependencyReadMs);
  options.targetedDfsProbe = options.targetedDfsProbe !== false;
  options.targetedDfsMaxFiles = clampInteger(options.targetedDfsMaxFiles, 0, 50000, DEFAULT_OPTIONS.targetedDfsMaxFiles);
  options.heavyFolderFileThreshold = clampInteger(
    options.heavyFolderFileThreshold,
    1,
    MAX_SCAN_FILES,
    DEFAULT_OPTIONS.heavyFolderFileThreshold
  );
  options.heavyFolderBytesThreshold = clampInteger(
    options.heavyFolderBytesThreshold,
    0,
    1024 * 1024 * 1024 * 1024,
    DEFAULT_OPTIONS.heavyFolderBytesThreshold
  );
  options.heavyFolderRiskThreshold = clampInteger(options.heavyFolderRiskThreshold, 0, 100000, DEFAULT_OPTIONS.heavyFolderRiskThreshold);
  options.fastScanMs = clampInteger(options.fastScanMs, 1000, 10 * 60 * 1000, DEFAULT_OPTIONS.fastScanMs);
  options.fastStoredFiles = clampInteger(options.fastStoredFiles, 1000, MAX_SCAN_FILES, DEFAULT_OPTIONS.fastStoredFiles);
  options.fastStoredDirectories = clampInteger(options.fastStoredDirectories, 500, MAX_SCAN_FILES, DEFAULT_OPTIONS.fastStoredDirectories);
  options.unusedDaysThreshold = clampInteger(options.unusedDaysThreshold, 1, 3650, DEFAULT_OPTIONS.unusedDaysThreshold);
  options.frequentUseDaysThreshold = clampInteger(options.frequentUseDaysThreshold, 1, 60, DEFAULT_OPTIONS.frequentUseDaysThreshold);
  options.skipDirectories = Array.from(new Set([...(DEFAULT_OPTIONS.skipDirectories || []), ...((rawOptions && rawOptions.skipDirectories) || [])]));
  options.includeProgramFiles = Boolean(options.includeProgramFiles);
  if (options.includeProgramFiles) {
    options.skipDirectories = options.skipDirectories.filter((item) => !isProgramFilesName(item));
  }
  options.includeHidden = Boolean(options.includeHidden);
  options.sortEntries = Boolean(options.sortEntries);
  options.greedyScan = options.greedyScan !== false;
  options.skipReparsePoints = options.skipReparsePoints !== false;
  options.maxScanMs = clampInteger(options.maxScanMs, 0, 24 * 60 * 60 * 1000, DEFAULT_OPTIONS.maxScanMs);
  options.progressiveStepMaxMs = clampInteger(
    options.progressiveStepMaxMs,
    1000,
    30 * 60 * 1000,
    DEFAULT_OPTIONS.progressiveStepMaxMs
  );
  delete options._dependencyCache;
  delete options.onScanProgress;
  return options;
}

function shouldUseTurboScan(rawOptions = {}) {
  return normalizeScanEngine(rawOptions.scanEngine ?? DEFAULT_OPTIONS.scanEngine) === "turbo";
}

function normalizeScanEngine(value) {
  const engine = String(value || "turbo").toLowerCase();
  if (["node", "preciso", "deep", "full"].includes(engine)) {
    return "node";
  }
  return "turbo";
}

function adaptiveProfile(scale) {
  if (scale === "massivo") {
    return {
      maxFiles: MAX_SCAN_FILES,
      maxDepth: MAX_SCAN_DEPTH,
      maxFileSizeBytes: 128 * 1024
    };
  }
  if (scale === "grande") {
    return {
      maxFiles: MAX_SCAN_FILES,
      maxDepth: 72,
      maxFileSizeBytes: 256 * 1024
    };
  }
  if (scale === "medio") {
    return {
      maxFiles: MAX_SCAN_FILES,
      maxDepth: 88,
      maxFileSizeBytes: 512 * 1024
    };
  }
  return {
    maxFiles: MAX_SCAN_FILES,
    maxDepth: 96,
    maxFileSizeBytes: 1024 * 1024
  };
}

function buildProgressiveDepthSteps(minDepth, maxDepth) {
  const start = Math.max(1, minDepth);
  const end = Math.max(start, maxDepth);
  const steps = new Set([start, end]);

  if (end - start <= 10) {
    for (let depth = start; depth <= end; depth += 1) {
      steps.add(depth);
    }
  } else {
    for (let depth = start; depth <= Math.min(end, start + 4); depth += 1) {
      steps.add(depth);
    }
    const stride = Math.max(2, Math.ceil((end - start) / 10));
    for (let depth = start + stride; depth < end; depth += stride) {
      steps.add(depth);
    }
  }

  return Array.from(steps).sort((a, b) => a - b);
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function daysBetween(date, now) {
  const diff = now.getTime() - date.getTime();
  if (!Number.isFinite(diff) || diff < 0) {
    return 0;
  }
  return Math.floor(diff / 86400000);
}

function shouldSkipDirectory(name, protectedReasons, options) {
  const lowerName = name.toLowerCase();
  const skipNames = new Set(options.skipDirectories.map((item) => item.toLowerCase()));
  if (!options.includeProgramFiles && isProgramFilesName(lowerName)) {
    return true;
  }
  return skipNames.has(lowerName);
}

function entryScanPriority(entry) {
  const name = String(entry.name || "").toLowerCase();
  if (entry.isDirectory()) {
    if (/^(downloads|desktop|documents|videos|pictures|music)$/i.test(name)) {
      return 0;
    }
    if (/^(temp|tmp|cache|caches|logs|backups|backup|old|archive|archives)$/i.test(name)) {
      return 1;
    }
    if (/^(\.git|windows|system32|syswow64|winsxs|windowsapps|recovery|system volume information)$/i.test(name)) {
      return 20;
    }
    return 4;
  }
  if (/\.(zip|7z|rar|iso|msi|exe|mp4|mov|mkv|avi|bak|old|tmp|log)$/i.test(name)) {
    return 2;
  }
  if (/\.(dll|sys|dat|db|sqlite|lock|json|js|ts|py|css|html)$/i.test(name)) {
    return 8;
  }
  return 5;
}

function getProtectedReasons(absolutePath, relativePath, name, options = DEFAULT_OPTIONS) {
  const reasons = [];
  const lowerAbsolute = absolutePath.toLowerCase();
  const lowerRelative = normalizeRelative(relativePath).toLowerCase();
  const lowerName = name.toLowerCase();
  const extension = path.extname(lowerName);

  if (PROTECTED_FILE_NAMES.has(lowerName)) {
    reasons.push("arquivo de configuracao/lock");
  }

  if (SYSTEM_PROTECTED_EXTENSIONS.has(extension)) {
    reasons.push("arquivo essencial do sistema");
  } else if (PROTECTED_EXTENSIONS.has(extension) && isStrictSystemPath(lowerAbsolute, lowerRelative)) {
    reasons.push("binario em diretorio critico do sistema");
  }

  const knowledge = classifyFileKnowledge(relativePath, name, extension);
  if (knowledge.isSystemEssential) {
    reasons.push("tipo essencial do sistema");
  }
  if (knowledge.isProjectDependency && PROTECTED_FILE_NAMES.has(lowerName)) {
    reasons.push("dependencia/configuracao de projeto");
  }

  if (/(^|[\\/])(\.git|\.hg|\.svn)([\\/]|$)/i.test(absolutePath)) {
    reasons.push("metadados de versionamento");
  }

  if (isStrictSystemPath(lowerAbsolute, lowerRelative)) {
    reasons.push("diretorio critico do sistema operacional");
  }

  if (!options.includeProgramFiles && isProgramFilesPath(lowerAbsolute, lowerRelative)) {
    reasons.push("diretorio do sistema operacional");
  }

  if (isStrictSystemPath(lowerAbsolute, lowerRelative) && /\.(dll|exe|sys|dat)$/i.test(lowerAbsolute)) {
    reasons.push("artefato sensivel de aplicacao do usuario");
  }

  return Array.from(new Set(reasons));
}

function isProgramFilesName(name) {
  const lowerName = String(name || "").toLowerCase();
  return lowerName === "program files" || lowerName === "program files (x86)";
}

function isProgramFilesPath(absolutePath, relativePath) {
  return /(^|[\\/])program files( \(x86\))?([\\/]|$)/i.test(absolutePath)
    || /(^|\/)program files( \(x86\))?(\/|$)/i.test(relativePath);
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

function isTextCandidate(lowerName, extension) {
  return TEXT_EXTENSIONS.has(extension) || SPECIAL_TEXT_FILES.has(lowerName);
}

function buildIndexes(fileNodes) {
  const byRelative = new Map();
  const byBasename = new Map();

  for (const node of fileNodes) {
    byRelative.set(normalizeKey(node.relativePath), node);

    const base = node.name.toLowerCase();
    if (!byBasename.has(base)) {
      byBasename.set(base, []);
    }
    byBasename.get(base).push(node);
  }

  return { byRelative, byBasename };
}

async function readOrReuseDependencies(node, dependencyCache, options = DEFAULT_OPTIONS, { targetedProbe = false } = {}) {
  const maxBytes = Math.min(
    Math.max(4096, options.maxDependencyReadBytes || DEFAULT_OPTIONS.maxDependencyReadBytes),
    Math.max(4096, node.size || options.maxDependencyReadBytes || DEFAULT_OPTIONS.maxDependencyReadBytes)
  );
  const cacheKey = `${node.relativePath}|${node.size}|${node.modifiedAt}|${maxBytes}`;
  const cached = dependencyCache?.get(cacheKey);

  if (cached) {
    if (cached.readError) {
      node.readError = cached.readError;
      node.unresolvedDependencies += 1;
      return [];
    }
    applyDependencyReadMetadata(node, cached.readMeta, targetedProbe, options);
    return cached.dependencies;
  }

  let readResult;
  try {
    readResult = await readTextPrefix(node.absolutePath, maxBytes);
  } catch (error) {
    const readError = error.message;
    node.readError = readError;
    node.unresolvedDependencies += 1;
    dependencyCache?.set(cacheKey, { readError, dependencies: [] });
    return [];
  }

  const readMeta = {
    bytesRead: readResult.bytesRead,
    maxBytes,
    elapsedMs: readResult.elapsedMs,
    truncated: Boolean((node.size || 0) > readResult.bytesRead)
  };
  applyDependencyReadMetadata(node, readMeta, targetedProbe, options);
  const dependencies = extractDependencies(node.relativePath, readResult.content);
  dependencyCache?.set(cacheKey, { readError: null, dependencies, readMeta });
  return dependencies;
}

async function readTextPrefix(absolutePath, maxBytes) {
  const startedAt = Date.now();
  const handle = await fs.open(absolutePath, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return {
      content: buffer.subarray(0, bytesRead).toString("utf8"),
      bytesRead,
      elapsedMs: Date.now() - startedAt
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

function applyDependencyReadMetadata(node, readMeta, targetedProbe, options = DEFAULT_OPTIONS) {
  if (!readMeta) {
    return;
  }

  node.dependencyRead = readMeta;
  if (node.dependencyProbe) {
    node.dependencyProbe.status = "parsed";
    node.dependencyProbe.bytesRead = readMeta.bytesRead;
    node.dependencyProbe.maxBytes = readMeta.maxBytes;
    node.dependencyProbe.elapsedMs = readMeta.elapsedMs;
    node.dependencyProbe.partialRead = readMeta.truncated;
  }

  if (readMeta.truncated) {
    node.unresolvedDependencies += 1;
    node.unresolvedSpecifiers.push({
      specifier: "<conteudo_parcial>",
      type: targetedProbe ? "dfs_probe_limitado" : "conteudo_parcial",
      line: null
    });
  }
  if (readMeta.elapsedMs > options.maxDependencyReadMs) {
    if (node.dependencyProbe) {
      node.dependencyProbe.timeLimitExceeded = true;
    }
    node.unresolvedDependencies += 1;
    node.unresolvedSpecifiers.push({
      specifier: "<tempo_limite_leitura>",
      type: targetedProbe ? "dfs_probe_timeout" : "leitura_timeout",
      line: null
    });
  }
}

function extractDependencies(relativePath, content) {
  const extension = path.extname(relativePath).toLowerCase();
  const lowerName = path.basename(relativePath).toLowerCase();
  const dependencies = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const lineNumber = index + 1;

    if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".vue", ".svelte"].includes(extension)) {
      collectRegex(dependencies, line, /\bimport\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/g, "import_js", lineNumber, isLocalLikeJs);
      collectRegex(dependencies, line, /\bexport\s+[^"']*?\s+from\s+["']([^"']+)["']/g, "export_js", lineNumber, isLocalLikeJs);
      collectRegex(dependencies, line, /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g, "require_js", lineNumber, isLocalLikeJs);
      collectRegex(dependencies, line, /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g, "dynamic_import_js", lineNumber, isLocalLikeJs);
    }

    if (STYLE_EXTENSIONS.includes(extension)) {
      collectRegex(dependencies, line, /@import\s+(?:url\(\s*)?["']?([^"')\s;]+)["']?\s*\)?/g, "import_css", lineNumber, isLocalUrl);
      collectRegex(dependencies, line, /url\(\s*["']?([^"')]+)["']?\s*\)/g, "asset_css", lineNumber, isLocalUrl);
    }

    if ([".html", ".htm", ".vue", ".svelte"].includes(extension)) {
      collectRegex(dependencies, line, /\b(?:src|href)\s*=\s*["']([^"']+)["']/g, "asset_html", lineNumber, isLocalUrl);
    }

    if (extension === ".py") {
      collectPythonImport(dependencies, line, lineNumber);
    }

    if ([".c", ".cc", ".cpp", ".h", ".hpp"].includes(extension)) {
      collectCInclude(dependencies, line, lineNumber);
    }

    if ([".java", ".kt", ".cs"].includes(extension)) {
      collectRegex(dependencies, line, /^\s*import\s+([\w.]+)\s*;?/g, "import_package", lineNumber, () => true, 0.45);
      collectRegex(dependencies, line, /^\s*using\s+([\w.]+)\s*;?/g, "import_package", lineNumber, () => true, 0.45);
    }

    if (extension === ".go") {
      collectRegex(dependencies, line, /^\s*import\s+["']([^"']+)["']/g, "import_go", lineNumber, isLocalLikeJs, 0.6);
    }

    if (extension === ".rs") {
      collectRegex(dependencies, line, /^\s*mod\s+([a-zA-Z_][\w]*)\s*;/g, "mod_rust", lineNumber, () => true, 0.85);
      collectRegex(dependencies, line, /^\s*use\s+crate::([\w:]+)\s*;?/g, "use_rust", lineNumber, () => true, 0.55);
    }

    if ([".md", ".markdown"].includes(extension) || lowerName.endsWith(".md")) {
      collectRegex(dependencies, line, /!?\[[^\]]*\]\(([^)]+)\)/g, "asset_markdown", lineNumber, isLocalUrl, 0.7);
    }
  }

  return dependencies.filter((dependency, index, all) => {
    const key = `${dependency.type}:${dependency.specifier}:${dependency.line}`;
    return all.findIndex((item) => `${item.type}:${item.specifier}:${item.line}` === key) === index;
  });
}

function collectRegex(dependencies, line, regex, type, lineNumber, localIntentDetector, confidence = 0.9) {
  let match;
  while ((match = regex.exec(line)) !== null) {
    const specifier = cleanSpecifier(match[1]);
    if (!specifier) {
      continue;
    }
    dependencies.push({
      specifier,
      type,
      line: lineNumber,
      localIntent: localIntentDetector(specifier),
      confidence
    });
  }
}

function collectPythonImport(dependencies, line, lineNumber) {
  const fromMatch = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+)$/);
  if (fromMatch) {
    const moduleName = fromMatch[1].trim();
    const imported = fromMatch[2].split(",").map((item) => item.trim().split(/\s+as\s+/i)[0]).filter(Boolean);
    dependencies.push({
      specifier: moduleName,
      type: "import_python",
      line: lineNumber,
      localIntent: moduleName.startsWith(".") || !isKnownPythonStdlib(moduleName),
      confidence: moduleName.startsWith(".") ? 0.9 : 0.55
    });

    if (moduleName.startsWith(".")) {
      for (const item of imported) {
        if (/^[a-zA-Z_][\w]*$/.test(item)) {
          dependencies.push({
            specifier: `${moduleName}.${item}`,
            type: "import_python",
            line: lineNumber,
            localIntent: true,
            confidence: 0.8
          });
        }
      }
    }
    return;
  }

  const importMatch = line.match(/^\s*import\s+(.+)$/);
  if (importMatch) {
    const modules = importMatch[1].split(",").map((item) => item.trim().split(/\s+as\s+/i)[0]).filter(Boolean);
    for (const moduleName of modules) {
      dependencies.push({
        specifier: moduleName,
        type: "import_python",
        line: lineNumber,
        localIntent: !isKnownPythonStdlib(moduleName),
        confidence: 0.55
      });
    }
  }
}

function collectCInclude(dependencies, line, lineNumber) {
  const match = line.match(/^\s*#\s*include\s+(["<])([^">]+)[">]/);
  if (!match) {
    return;
  }
  dependencies.push({
    specifier: match[2].trim(),
    type: match[1] === "\"" ? "include_local" : "include_sistema",
    line: lineNumber,
    localIntent: match[1] === "\"",
    confidence: match[1] === "\"" ? 0.95 : 0.35
  });
}

function cleanSpecifier(value) {
  return String(value || "")
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/^['"]|['"]$/g, "");
}

function isLocalLikeJs(specifier) {
  return specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("~");
}

function isLocalUrl(specifier) {
  if (!specifier || specifier.startsWith("#")) {
    return false;
  }
  return !/^(?:[a-z]+:)?\/\//i.test(specifier) && !/^(?:data|mailto|tel):/i.test(specifier);
}

function resolveDependency(importerRelativePath, dependency, indexes) {
  const specifier = cleanSpecifier(dependency.specifier);
  if (!specifier || !isLocalUrl(specifier)) {
    return null;
  }

  const importerDirectory = normalizeRelative(path.dirname(importerRelativePath));
  const type = dependency.type;
  const bareImportTypes = new Set(["import_js", "export_js", "require_js", "dynamic_import_js", "import_go"]);

  if (!dependency.localIntent && bareImportTypes.has(type)) {
    return null;
  }

  if (type === "import_python") {
    return resolvePython(importerDirectory, specifier, indexes);
  }

  if (type === "mod_rust") {
    return firstExisting([
      path.posix.join(importerDirectory, `${specifier}.rs`),
      path.posix.join(importerDirectory, specifier, "mod.rs")
    ], indexes);
  }

  if (type === "use_rust") {
    const rustPath = specifier.replace(/::/g, "/");
    return firstExisting([
      path.posix.join("src", `${rustPath}.rs`),
      path.posix.join("src", rustPath, "mod.rs"),
      `${rustPath}.rs`,
      path.posix.join(rustPath, "mod.rs")
    ], indexes);
  }

  if (type === "import_package") {
    const packagePath = specifier.replace(/\./g, "/");
    return firstExisting([
      `${packagePath}.java`,
      `${packagePath}.kt`,
      `${packagePath}.cs`,
      path.posix.join("src", "main", "java", `${packagePath}.java`),
      path.posix.join("src", "main", "kotlin", `${packagePath}.kt`)
    ], indexes);
  }

  let base;
  if (specifier.startsWith("/")) {
    base = specifier.slice(1);
  } else if (specifier.startsWith("~")) {
    base = specifier.slice(1);
  } else {
    base = path.posix.join(importerDirectory, specifier);
  }

  const extensionSet = extensionGuessesFor(type);
  const candidates = candidatePaths(base, extensionSet);
  return firstExisting(candidates, indexes);
}

function resolvePython(importerDirectory, specifier, indexes) {
  if (specifier.startsWith(".")) {
    const dots = specifier.match(/^\.+/)[0].length;
    const moduleName = specifier.slice(dots).replace(/^\./, "");
    let base = importerDirectory === "." ? "" : importerDirectory;
    for (let index = 1; index < dots; index += 1) {
      base = normalizeRelative(path.posix.dirname(base || "."));
      if (base === ".") {
        base = "";
      }
    }
    const modulePath = moduleName.replace(/\./g, "/");
    const combined = modulePath ? path.posix.join(base, modulePath) : base;
    return firstExisting(candidatePaths(combined, PY_EXTENSIONS), indexes);
  }

  const modulePath = specifier.replace(/\./g, "/");
  return firstExisting(candidatePaths(modulePath, PY_EXTENSIONS), indexes);
}

function extensionGuessesFor(type) {
  if (type.includes("js")) {
    return JS_EXTENSIONS;
  }
  if (type.includes("css")) {
    return STYLE_EXTENSIONS;
  }
  if (type.includes("html") || type.includes("markdown")) {
    return HTML_EXTENSIONS;
  }
  if (type.includes("include")) {
    return C_EXTENSIONS;
  }
  if (type.includes("go")) {
    return [".go"];
  }
  return [...JS_EXTENSIONS, ...HTML_EXTENSIONS, ...PY_EXTENSIONS, ...C_EXTENSIONS, ...RUST_EXTENSIONS];
}

function candidatePaths(base, extensions) {
  const normalizedBase = normalizeRelative(base).replace(/^\.\//, "");
  const candidates = [normalizedBase];
  const currentExtension = path.posix.extname(normalizedBase);

  if (!currentExtension) {
    for (const extension of extensions) {
      if (extension.startsWith("/")) {
        candidates.push(`${normalizedBase}${extension}`);
      } else {
        candidates.push(`${normalizedBase}${extension}`);
      }
    }

    for (const indexExtension of extensions.filter((extension) => !extension.startsWith("/"))) {
      candidates.push(path.posix.join(normalizedBase, `index${indexExtension}`));
    }
  }

  return Array.from(new Set(candidates.filter(Boolean)));
}

function firstExisting(candidates, indexes) {
  for (const candidate of candidates) {
    const key = normalizeKey(candidate);
    if (indexes.byRelative.has(key)) {
      return indexes.byRelative.get(key);
    }
  }
  return null;
}

function buildComponents(fileNodes, edges) {
  const adjacency = new Map(fileNodes.map((node) => [node.id, new Set()]));
  for (const edge of edges) {
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }

  const visited = new Set();
  const components = [];

  for (const node of fileNodes) {
    if (visited.has(node.id)) {
      continue;
    }
    const stack = [node.id];
    const nodeIds = [];
    visited.add(node.id);

    while (stack.length) {
      const current = stack.pop();
      nodeIds.push(current);
      for (const next of adjacency.get(current) || []) {
        if (!visited.has(next)) {
          visited.add(next);
          stack.push(next);
        }
      }
    }

    components.push({
      id: `component:${components.length + 1}`,
      nodeIds,
      nodeCount: nodeIds.length,
      edgeCount: 0,
      depth: 0,
      risk: "baixo",
      hasProtected: false,
      hasCycle: false,
      criticalRiskNodes: 0,
      highRiskNodes: 0,
      mediumRiskNodes: 0
    });
  }

  if (edges.length) {
    const componentByNodeId = new Map();
    for (const component of components) {
      for (const nodeId of component.nodeIds) {
        componentByNodeId.set(nodeId, component);
      }
    }
    for (const edge of edges) {
      const sourceComponent = componentByNodeId.get(edge.source);
      if (sourceComponent && sourceComponent === componentByNodeId.get(edge.target)) {
        sourceComponent.edgeCount += 1;
      }
    }
  }

  return components.sort((a, b) => b.nodeCount - a.nodeCount);
}

function detectCyclesDfs(fileNodes, edges) {
  if (!edges.length) {
    for (const node of fileNodes) {
      node.dfsColor = "preto";
    }
    return [];
  }

  const adjacency = new Map(fileNodes.map((node) => [node.id, []]));
  const color = new Map(fileNodes.map((node) => [node.id, "branco"]));
  const stack = [];
  const cycles = [];
  const seenCycles = new Set();

  for (const edge of edges) {
    adjacency.get(edge.source)?.push(edge.target);
  }

  function visit(nodeId) {
    color.set(nodeId, "cinza");
    stack.push(nodeId);

    for (const nextId of adjacency.get(nodeId) || []) {
      const nextColor = color.get(nextId) || "branco";
      if (nextColor === "branco") {
        visit(nextId);
      } else if (nextColor === "cinza") {
        const cycleStart = stack.indexOf(nextId);
        if (cycleStart !== -1) {
          const orderedNodeIds = stack.slice(cycleStart);
          const key = canonicalCycleKey(orderedNodeIds);
          if (!seenCycles.has(key)) {
            seenCycles.add(key);
            cycles.push({
              id: `cycle:${cycles.length + 1}`,
              type: "bloco_interdependente",
              nodeIds: orderedNodeIds,
              nodeCount: orderedNodeIds.length,
              closingEdge: `${nodeId}->${nextId}`,
              risk: "critico",
              suggestion: "manter arquivos juntos e revisar manualmente antes de mover ou apagar"
            });
          }
        }
      }
    }

    stack.pop();
    color.set(nodeId, "preto");
  }

  for (const node of fileNodes) {
    if ((color.get(node.id) || "branco") === "branco") {
      visit(node.id);
    }
  }

  for (const node of fileNodes) {
    node.dfsColor = color.get(node.id) || "preto";
  }

  return cycles;
}

function canonicalCycleKey(nodeIds) {
  const uniqueIds = Array.from(new Set(nodeIds));
  return uniqueIds.slice().sort().join("|");
}

function applyCycleMetadata(fileNodes, cycles) {
  const byId = new Map(fileNodes.map((node) => [node.id, node]));

  for (const cycle of cycles) {
    for (const nodeId of cycle.nodeIds) {
      const node = byId.get(nodeId);
      if (!node) {
        continue;
      }
      node.inCycle = true;
      node.cycleBlockId = node.cycleBlockId || cycle.id;
      node.cycleBlockIds.push(cycle.id);
      node.cycleGroupSize = Math.max(node.cycleGroupSize || 0, cycle.nodeCount);
    }
  }
}

function applyComponentMetadata(fileNodes, components) {
  const byId = new Map(fileNodes.map((node) => [node.id, node]));
  for (const component of components) {
    for (const nodeId of component.nodeIds) {
      const node = byId.get(nodeId);
      if (node) {
        node.componentId = component.id;
        node.componentSize = component.nodeCount;
      }
    }
  }
}

function applyImpactMetadata(fileNodes) {
  if (!fileNodes.some((node) => node.incomingFrom?.length)) {
    for (const node of fileNodes) {
      node.impactCount = 0;
    }
    return;
  }

  const byId = new Map(fileNodes.map((node) => [node.id, node]));

  for (const node of fileNodes) {
    const impacted = new Set();
    const queue = [...node.incomingFrom];

    while (queue.length) {
      const currentId = queue.shift();
      if (impacted.has(currentId)) {
        continue;
      }
      impacted.add(currentId);
      const current = byId.get(currentId);
      if (current) {
        queue.push(...current.incomingFrom);
      }
    }

    node.impactCount = impacted.size;
  }
}

function applySimulationMetadata(fileNodes) {
  const byId = new Map(fileNodes.map((node) => [node.id, node]));
  const cycleMembersById = new Map();
  for (const node of fileNodes) {
    for (const cycleId of node.cycleBlockIds || []) {
      if (!cycleMembersById.has(cycleId)) {
        cycleMembersById.set(cycleId, []);
      }
      cycleMembersById.get(cycleId).push(node);
    }
  }

  for (const node of fileNodes) {
    const dependsOnNodes = node.outgoingTo.map((id) => byId.get(id)).filter(Boolean);
    const dependentNodes = node.incomingFrom.map((id) => byId.get(id)).filter(Boolean);
    const cycleMembers = node.inCycle
      ? Array.from(new Set((node.cycleBlockIds || []).flatMap((id) => cycleMembersById.get(id) || [])))
      : [];
    const moveWith = new Map();

    for (const dependency of dependsOnNodes) {
      moveWith.set(dependency.id, dependency);
    }
    for (const cycleMember of cycleMembers) {
      if (cycleMember.id !== node.id) {
        moveWith.set(cycleMember.id, cycleMember);
      }
    }

    node.dependsOn = dependsOnNodes.map((item) => item.relativePath).sort();
    node.dependents = dependentNodes.map((item) => item.relativePath).sort();
    node.simulation = {
      dependsOn: node.dependsOn,
      dependents: node.dependents,
      wouldBreakDependents: dependentNodes.length > 0,
      wouldBreakCount: dependentNodes.length,
      transitiveBreakCount: node.impactCount,
      moveRequires: Array.from(moveWith.values()).map((item) => item.relativePath).sort(),
      belongsToCycle: node.inCycle,
      cycleBlockId: node.cycleBlockId,
      cycleBlockIds: node.cycleBlockIds,
      cycleGroupSize: node.cycleGroupSize,
      safeToDelete: node.deletionDecision === "pode_apagar",
      safeToMove: node.relocationDecision === "pode_mexer",
      recommendation: simulationReason(node)
    };
  }
}

function computeDepths(fileNodes) {
  if (!fileNodes.some((node) => node.outgoingTo?.length)) {
    return new Map(fileNodes.map((node) => [node.id, 0]));
  }

  const byId = new Map(fileNodes.map((node) => [node.id, node]));
  const memo = new Map();
  const visiting = new Set();

  function depthFor(nodeId) {
    if (memo.has(nodeId)) {
      return memo.get(nodeId);
    }
    if (visiting.has(nodeId)) {
      return 0;
    }
    visiting.add(nodeId);
    const node = byId.get(nodeId);
    let depth = 0;
    for (const nextId of node?.outgoingTo || []) {
      depth = Math.max(depth, 1 + depthFor(nextId));
    }
    visiting.delete(nodeId);
    memo.set(nodeId, depth);
    return depth;
  }

  for (const node of fileNodes) {
    depthFor(node.id);
  }

  return memo;
}

function classifyNode(node, options = DEFAULT_OPTIONS) {
  const reasons = [...node.protectedReasons];
  let riskScore = 0;
  const knowledge = node.fileKnowledge || {};
  const isSystemProtected = node.protectedReasons.some((reason) => reason.includes("sistema") || reason.includes("executavel") || reason.includes("biblioteca"));
  const isConfigProtected = node.protectedReasons.length > 0;
  const dependencyLoad = node.incoming + node.outgoing + node.impactCount;
  const isUnused = node.daysSinceAccess >= options.unusedDaysThreshold;
  const isFrequentlyUsed = node.daysSinceAccess <= options.frequentUseDaysThreshold;
  const isLowValueGenerated = Boolean(knowledge.isLowValueGenerated);
  const isUserContent = Boolean(knowledge.isUserContent);
  const isKnownUserContent = Boolean(knowledge.isKnownUserFolder || knowledge.isCloudUserContent);
  const isCloudUserContent = Boolean(knowledge.isCloudUserContent);
  const isApplicationState = Boolean(knowledge.isApplicationState);
  const isInCycle = Boolean(node.inCycle);
  const isCentralDependency = node.incoming >= 8 || node.impactCount >= 16 || node.componentSize >= 25;
  const dependencyImpact = dependencyImpactFor(node);

  if (reasons.length) {
    riskScore += 80;
  }
  if (isInCycle) {
    riskScore += 100;
    reasons.push(`bloco interdependente por DFS (${node.cycleGroupSize || 2} arquivos)`);
  }
  if (isCentralDependency) {
    riskScore += 60;
    reasons.push("dependencia central no grafo");
  }
  riskScore += node.incoming * 12;
  riskScore += node.outgoing * 4;
  riskScore += node.depth * 6;
  riskScore += Math.min(80, node.impactCount * 10);
  riskScore += Math.min(30, Math.max(0, node.componentSize - 1) * 3);
  riskScore += node.unresolvedDependencies * 15;
  if (node.daysSinceAccess <= 1) {
    riskScore += 24;
    reasons.push("uso muito recente");
  } else if (node.daysSinceAccess <= 4) {
    riskScore += 14;
    reasons.push("uso recente");
  } else if (node.daysSinceAccess <= 10) {
    riskScore += 7;
    reasons.push("uso na ultima semana");
  } else if (node.daysSinceAccess >= 60 && node.incoming === 0) {
    riskScore -= 5;
    reasons.push("sem uso recente detectado");
  }
  if (node.size > 1024 * 1024) {
    riskScore += 10;
    reasons.push("arquivo grande");
  }
  if (node.incoming > 0) {
    reasons.push(`${node.incoming} dependencia(s) apontam para este arquivo`);
  }
  if (node.outgoing > 0) {
    reasons.push(`${node.outgoing} dependencia(s) usadas por este arquivo`);
  }
  if (node.impactCount > 0) {
    reasons.push(`${node.impactCount} arquivo(s) seriam afetados transitivamente`);
  }
  if (node.unresolvedDependencies > 0) {
    reasons.push("dependencias nao resolvidas");
  }
  if (isLowValueGenerated) {
    reasons.push("tipo gerado/cache de baixo valor");
    riskScore -= 14;
  }
  if (isApplicationState && !isLowValueGenerated) {
    reasons.push("estado de aplicativo em AppData/ProgramData");
    riskScore += 42;
  }
  if (isKnownUserContent && !isLowValueGenerated) {
    reasons.push(isCloudUserContent ? "conteudo de usuario em pasta sincronizada" : "conteudo em pasta conhecida do usuario");
    riskScore += isCloudUserContent ? 40 : 35;
  }
  if (isUserContent && isFrequentlyUsed) {
    reasons.push("conteudo do usuario usado nos ultimos 7 dias");
  }

  if (node.protectedReasons.length) {
    node.classification = "critico_protegido";
    node.risk = isSystemProtected || isCentralDependency ? "critico" : "alto";
    node.simulationAction = "proteger_nao_mover";
    node.relocationDecision = "nao_mover";
  } else if (isInCycle) {
    node.classification = "misto";
    node.risk = "critico";
    node.simulationAction = "manter_bloco_interdependente";
    node.relocationDecision = "manter_junto";
  } else if (node.incoming === 0 && node.outgoing === 0 && node.unresolvedDependencies === 0) {
    node.classification = "isolado";
    node.risk = riskScore >= 30 ? "medio" : "baixo";
    node.simulationAction = node.risk === "baixo" ? "candidato_para_realocacao" : "revisar_uso_recente";
    node.relocationDecision = node.risk === "baixo" ? "pode_mexer" : "averiguar";
  } else if (node.incoming > 0 && node.outgoing > 0) {
    node.classification = "misto";
    node.risk = isCentralDependency ? "critico" : riskScore >= 65 || node.impactCount >= 6 ? "alto" : "medio";
    node.simulationAction = "revisar_dependencias";
    node.relocationDecision = node.risk === "alto" || node.risk === "critico" ? "nao_mover" : "averiguar";
  } else if (node.incoming > 0) {
    node.classification = "docente";
    node.risk = isCentralDependency ? "critico" : node.incoming >= 4 || node.impactCount >= 8 || riskScore >= 60 ? "alto" : "medio";
    node.simulationAction = node.risk === "alto" || node.risk === "critico" ? "nao_mover" : "revisar_antes_de_mover";
    node.relocationDecision = node.risk === "alto" || node.risk === "critico" ? "nao_mover" : "averiguar";
  } else if (node.outgoing > 0) {
    node.classification = "dicente";
    node.risk = node.unresolvedDependencies > 0 || riskScore >= 45 ? "medio" : "baixo";
    node.simulationAction = node.risk === "baixo" ? "mover_com_dependencias" : "revisar_antes_de_mover";
    node.relocationDecision = node.risk === "baixo" ? "pode_mexer" : "averiguar";
  } else {
    node.classification = "dicente";
    node.risk = "medio";
    node.simulationAction = "revisar_dependencias_nao_resolvidas";
    node.relocationDecision = "averiguar";
  }

  if (node.unresolvedDependencies > 0 && node.risk === "baixo") {
    node.risk = "medio";
    node.relocationDecision = "averiguar";
  }
  if ((isApplicationState || isKnownUserContent) && !isLowValueGenerated && node.risk === "baixo") {
    node.risk = "medio";
    node.simulationAction = isApplicationState ? "revisar_estado_de_aplicativo" : "revisar_conteudo_do_usuario";
    node.relocationDecision = "averiguar";
  }

  node.impact = {
    system: isSystemProtected ? "afeta_sistema" : isConfigProtected ? "protegido" : "nao_afeta_sistema",
    user: userImpactFor(node, { isFrequentlyUsed, isUnused, isApplicationState, isKnownUserContent, isCloudUserContent, isLowValueGenerated }),
    dependencies: dependencyImpact
  };
  node.utilityStatus = utilityStatusFor(node, {
    isSystemProtected,
    isConfigProtected,
    isUnused,
    isFrequentlyUsed,
    isLowValueGenerated,
    isUserContent,
    isKnownUserContent,
    isCloudUserContent,
    isApplicationState,
    isInCycle,
    dependencyImpact
  });
  node.deletionDecision = deletionDecisionFor(node, {
    isSystemProtected,
    isConfigProtected,
    isUnused,
    isFrequentlyUsed,
    isLowValueGenerated,
    isUserContent,
    isKnownUserContent,
    isCloudUserContent,
    isApplicationState,
    isInCycle,
    dependencyImpact,
    dependencyLoad
  });

  if (node.deletionDecision === "pode_apagar" || node.deletionDecision === "inutil_provavel") {
    node.relocationDecision = "pode_mexer";
  } else if (node.deletionDecision === "nao_apagar") {
    node.relocationDecision = "nao_mover";
  } else {
    node.relocationDecision = "averiguar";
  }

  node.riskScore = riskScore;
  node.riskReasons = Array.from(new Set(reasons)).slice(0, 8);
}

function dependencyImpactFor(node) {
  if (node.inCycle) {
    return "critico";
  }
  if (node.unresolvedDependencies > 0) {
    return "incerto";
  }
  if (node.impactCount >= 16 || node.incoming >= 8 || node.componentSize >= 25) {
    return "critico";
  }
  if (node.fileKnowledge?.isLowValueGenerated && node.incoming === 0 && node.impactCount === 0) {
    return node.outgoing > 0 ? "baixo" : "nenhum";
  }
  if (node.impactCount >= 8 || node.incoming >= 4 || node.componentSize >= 12) {
    return "alto";
  }
  if (node.impactCount >= 2 || node.incoming >= 2 || node.componentSize >= 5) {
    return "medio";
  }
  if (node.incoming > 0 || node.outgoing > 0 || node.impactCount > 0) {
    return "baixo";
  }
  return "nenhum";
}

function userImpactFor(node, { isFrequentlyUsed, isUnused, isApplicationState, isKnownUserContent, isCloudUserContent, isLowValueGenerated }) {
  if (node.protectedReasons.length > 0) {
    return "alto";
  }
  if (node.inCycle) {
    return "medio";
  }
  if (isApplicationState && !isLowValueGenerated) {
    return isFrequentlyUsed ? "alto" : "medio";
  }
  if ((isKnownUserContent || isCloudUserContent) && !isLowValueGenerated) {
    return isFrequentlyUsed ? "alto" : "medio";
  }
  if (isFrequentlyUsed && node.fileKnowledge?.isUserContent) {
    return "alto";
  }
  if (isFrequentlyUsed && !node.fileKnowledge?.isLowValueGenerated) {
    return "medio";
  }
  if (node.daysSinceAccess <= 10 || node.incoming >= 2 || node.impactCount >= 2) {
    return "medio";
  }
  if (isUnused && node.incoming === 0 && node.impactCount === 0) {
    return "baixo";
  }
  return "baixo";
}

function utilityStatusFor(node, context) {
  if (context.isSystemProtected) {
    return "sistema";
  }
  if (context.isConfigProtected) {
    return "protegido";
  }
  if (context.isInCycle) {
    return "bloco_interdependente";
  }
  if (context.isLowValueGenerated && node.incoming === 0 && node.impactCount === 0 && node.unresolvedDependencies === 0) {
    return context.isUnused ? "inutil_provavel" : "baixo_uso";
  }
  if (context.isApplicationState && !context.isLowValueGenerated) {
    return context.isFrequentlyUsed ? "usado_pelo_usuario" : "dependencia_relevante";
  }
  if (context.isFrequentlyUsed && context.isUserContent) {
    return "usado_pelo_usuario";
  }
  if (context.isUserContent && !context.isLowValueGenerated) {
    return context.isUnused ? "baixo_uso" : "utilidade_incerta";
  }
  if (context.dependencyImpact === "critico" || context.dependencyImpact === "alto" || context.dependencyImpact === "medio") {
    return "dependencia_relevante";
  }
  if (context.isUnused && node.incoming === 0 && node.outgoing === 0 && node.impactCount === 0 && node.unresolvedDependencies === 0) {
    return "inutil_provavel";
  }
  if (context.isUnused && node.impactCount === 0 && node.unresolvedDependencies === 0) {
    return "baixo_uso";
  }
  return "utilidade_incerta";
}

function deletionDecisionFor(node, context) {
  if (context.isSystemProtected || context.isConfigProtected || context.isInCycle) {
    return "nao_apagar";
  }
  if (context.isLowValueGenerated && node.incoming === 0 && node.impactCount === 0 && node.unresolvedDependencies === 0) {
    return context.isUnused ? "pode_apagar" : "inutil_provavel";
  }
  if (context.isApplicationState && !context.isLowValueGenerated) {
    return context.isFrequentlyUsed ? "nao_apagar" : "averiguar";
  }
  if (context.isFrequentlyUsed && context.isUserContent) {
    return "nao_apagar";
  }
  if (context.isUserContent && !context.isLowValueGenerated) {
    return context.isUnused ? "inutil_provavel" : "averiguar";
  }
  if (context.dependencyImpact === "critico" || context.dependencyImpact === "alto") {
    return "nao_apagar";
  }
  if (node.unresolvedDependencies > 0 || context.dependencyImpact === "incerto") {
    return "averiguar";
  }
  if (context.dependencyImpact === "medio") {
    return "averiguar";
  }
  if (context.isUnused && node.incoming === 0 && node.outgoing === 0 && node.impactCount === 0) {
    return "pode_apagar";
  }
  if (context.isUnused && node.impactCount === 0 && context.dependencyLoad <= 2) {
    return "inutil_provavel";
  }
  return "averiguar";
}

function buildSummary(nodes, fileNodes, edges, components, cycles, skipped, warnings, startedAt, stopReason = null, inventoryStats = null, scanGrouping = null) {
  const byClassification = countBy(fileNodes, "classification");
  const byRisk = countBy(fileNodes, "risk");
  const byDeletionDecision = countBy(fileNodes, "deletionDecision");
  const byUtilityStatus = countBy(fileNodes, "utilityStatus");
  const storedDirectories = nodes.filter((node) => node.kind === "directory").length;
  const directories = inventoryStats?.directories ?? storedDirectories;
  const storedBytes = fileNodes.reduce((sum, node) => sum + (node.size || 0), 0);
  const totalBytes = inventoryStats?.totalBytes ?? storedBytes;
  const totalFiles = inventoryStats?.files ?? fileNodes.length;
  const depthBreakdown = buildDepthBreakdown(fileNodes);
  return {
    scannedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    directories,
    storedDirectories,
    files: totalFiles,
    analyzedFiles: fileNodes.length,
    storedFiles: fileNodes.length,
    totalBytes,
    totalHuman: formatBytes(totalBytes),
    storedBytes,
    storedHuman: formatBytes(storedBytes),
    inventoryProvider: inventoryStats?.provider || "node",
    inventoryTruncated: Boolean(inventoryStats?.truncated),
    inventoryReclaimable: inventoryStats?.inventoryReclaimable || null,
    scanStrategy: scanGrouping?.strategy || "balanced_search_horizontal_dpn",
    auxiliaryDatabase: scanGrouping?.auxiliaryDatabase || null,
    heavyFolders: scanGrouping?.heavyFolders || [],
    dependencyGroups: scanGrouping?.dependencyGroups || [],
    dependencyGroupCount: scanGrouping?.dependencyGroups?.length || 0,
    targetedDfsProbes: scanGrouping?.targetedDfs || {
      scheduled: 0,
      skipped: 0,
      remainingBudget: 0,
      parsed: 0,
      partialReads: 0
    },
    depthBreakdown,
    entries: directories + totalFiles,
    edges: edges.length,
    components: components.length,
    cycles: cycles.length,
    cycleNodes: fileNodes.filter((node) => node.inCycle).length,
    skipped: skipped.length,
    warnings: warnings.length,
    stoppedEarly: Boolean(stopReason),
    stopReason,
    byClassification,
    byRisk,
    byDeletionDecision,
    byUtilityStatus,
    byKnowledge: {
      systemEssential: fileNodes.filter((node) => node.fileKnowledge?.isSystemEssential).length,
      projectDependency: fileNodes.filter((node) => node.fileKnowledge?.isProjectDependency).length,
      userContent: fileNodes.filter((node) => node.fileKnowledge?.isUserContent).length,
      lowValueGenerated: fileNodes.filter((node) => node.fileKnowledge?.isLowValueGenerated).length,
      usedLast7Days: fileNodes.filter((node) => node.daysSinceAccess <= 7).length
    },
    candidateLowRisk: fileNodes.filter((node) => node.risk === "baixo" && node.classification === "isolado").length,
    canDelete: fileNodes.filter((node) => node.deletionDecision === "pode_apagar").length,
    probablyUseless: fileNodes.filter((node) => node.utilityStatus === "inutil_provavel" || node.deletionDecision === "inutil_provavel").length,
    mustKeep: fileNodes.filter((node) => node.deletionDecision === "nao_apagar").length,
    criticalRisk: fileNodes.filter((node) => node.risk === "critico").length,
    protected: fileNodes.filter((node) => node.classification === "critico_protegido").length,
    unresolvedDependencies: fileNodes.reduce((sum, node) => sum + node.unresolvedDependencies, 0),
    recentlyAccessed: fileNodes.filter((node) => node.daysSinceAccess <= 4).length,
    staleCandidates: fileNodes.filter((node) => node.daysSinceAccess >= 30 && node.incoming === 0 && node.risk === "baixo").length,
    highImpactProviders: fileNodes.filter((node) => node.impactCount >= 6 || node.incoming >= 4).length,
    totalTransitiveImpact: fileNodes.reduce((sum, node) => sum + node.impactCount, 0)
  };
}

function buildDepthBreakdown(fileNodes) {
  const groups = new Map();

  for (const node of fileNodes) {
    const depth = Number.isFinite(Number(node.scanDepth)) ? Number(node.scanDepth) : filesystemDepth(node.relativePath);
    if (!groups.has(depth)) {
      groups.set(depth, {
        depth,
        files: 0,
        bytes: 0,
        human: "0 B",
        canDelete: 0,
        probablyUseless: 0,
        blocked: 0,
        risk: {
          baixo: 0,
          medio: 0,
          alto: 0,
          critico: 0
        }
      });
    }

    const group = groups.get(depth);
    group.files += 1;
    group.bytes += node.size || 0;
    group.canDelete += node.deletionDecision === "pode_apagar" ? 1 : 0;
    group.probablyUseless += node.utilityStatus === "inutil_provavel" || node.deletionDecision === "inutil_provavel" ? 1 : 0;
    group.blocked += node.deletionDecision === "nao_apagar" ? 1 : 0;
    group.risk[node.risk] = (group.risk[node.risk] || 0) + 1;
  }

  return Array.from(groups.values())
    .sort((a, b) => a.depth - b.depth)
    .map((group) => ({
      ...group,
      human: formatBytes(group.bytes)
    }));
}

function buildSimulation(fileNodes) {
  const buckets = {
    isolados: [],
    dicentes: [],
    docentes: [],
    mistos: [],
    protegidos: [],
    blocosInterdependentes: [],
    revisar: []
  };

  for (const node of fileNodes) {
    const item = {
      id: node.id,
      path: node.relativePath,
      risk: node.risk,
      incoming: node.incoming,
      outgoing: node.outgoing,
      depth: node.depth,
      action: node.simulationAction
    };

    if (node.classification === "isolado") {
      buckets.isolados.push(item);
    } else if (node.classification === "dicente") {
      buckets.dicentes.push(item);
    } else if (node.classification === "docente") {
      buckets.docentes.push(item);
    } else if (node.classification === "misto") {
      buckets.mistos.push(item);
    } else if (node.classification === "critico_protegido") {
      buckets.protegidos.push(item);
    } else {
      buckets.revisar.push(item);
    }

    if (node.inCycle) {
      buckets.blocosInterdependentes.push(item);
    }
  }

  const decisionGroups = {
    pode_apagar: fileNodes
      .filter((node) => node.deletionDecision === "pode_apagar")
      .map(toSimulationDecision),
    inutil_provavel: fileNodes
      .filter((node) => node.deletionDecision === "inutil_provavel")
      .map(toSimulationDecision),
    averiguar: fileNodes
      .filter((node) => node.deletionDecision === "averiguar")
      .map(toSimulationDecision),
    nao_apagar: fileNodes
      .filter((node) => node.deletionDecision === "nao_apagar")
      .map(toSimulationDecision)
  };

  return {
    buckets,
    decisionGroups,
    recommendation: {
      pode_apagar: "Nao afeta sistema, nao afeta dependencias relevantes e parece fora de uso.",
      inutil_provavel: "Baixo uso e baixo impacto; bom candidato para A.R.E, mas ainda merece confirmacao.",
      averiguar: "Ha uso, dependencia ou incerteza suficiente para pedir revisao.",
      nao_apagar: "Afeta sistema, usuario recente ou dependencia relevante; tratar como protegido."
    }
  };
}

function toSimulationDecision(node) {
  return {
    id: node.id,
    path: node.relativePath,
    risk: node.risk,
    utilityStatus: node.utilityStatus,
    deletionDecision: node.deletionDecision,
    impact: node.impact,
    knowledgeCategories: node.fileKnowledge?.categories || [],
    action: node.simulationAction,
    reason: simulationReason(node),
    incoming: node.incoming,
    outgoing: node.outgoing,
    impactCount: node.impactCount,
    riskScore: node.riskScore,
    riskReasons: node.riskReasons,
    daysSinceAccess: node.daysSinceAccess,
    dependsOn: node.dependsOn,
    dependents: node.dependents,
    simulation: node.simulation,
    inCycle: node.inCycle,
    cycleBlockId: node.cycleBlockId
  };
}

function simulationReason(node) {
  if (node.protectedReasons.length) {
    return node.protectedReasons.join(", ");
  }
  if (node.inCycle) {
    return "faz parte de um bloco interdependente detectado por DFS";
  }
  if (node.deletionDecision === "pode_apagar") {
    return "sem uso recente, sem dependencia e fora de area protegida";
  }
  if (node.deletionDecision === "inutil_provavel") {
    return "baixo uso e impacto pequeno no grafo";
  }
  if (node.incoming >= 4) {
    return "muitas dependencias apontam para este arquivo";
  }
  if (node.impactCount >= 6) {
    return "impacto transitivo alto no grafo";
  }
  if (node.daysSinceAccess <= 4) {
    return "uso recente detectado";
  }
  if (node.unresolvedDependencies > 0) {
    return "ha dependencias nao resolvidas";
  }
  if (node.incoming === 0 && node.outgoing === 0) {
    return "isolado no grafo local";
  }
  return "impacto limitado, mas conectado ao grafo";
}

function buildGraphViews(nodes, fileNodes, edges) {
  return {
    far: buildDirectoryGraph(nodes, fileNodes, edges),
    medium: buildGroupedGraph(fileNodes, edges),
    close: {
      mode: "proximo",
      description: "arquivos individuais",
      nodes: fileNodes.map(toCloseGraphNode),
      edges: edges.map((edge) => ({
        ...edge,
        weight: 1,
        label: edge.type
      }))
    }
  };
}

function emptyGraphViews() {
  const emptyView = {
    mode: "compactacao_servidor",
    description: "grafo omitido nesta etapa para reduzir memoria; a API progressiva reconstrói uma visao compacta",
    nodes: [],
    edges: []
  };
  return {
    far: emptyView,
    medium: emptyView,
    close: emptyView
  };
}

function buildDirectoryGraph(nodes, fileNodes, edges) {
  const directoryNodes = nodes.filter((node) => node.kind === "directory");
  const directoryCounts = countDirectoriesByTopLevel(directoryNodes);
  const groups = new Map();

  for (const file of fileNodes) {
    const directory = topDirectory(file.relativePath);
    if (!groups.has(directory)) {
      groups.set(directory, []);
    }
    groups.get(directory).push(file);
  }

  const viewNodes = Array.from(groups.entries()).map(([directory, files]) => {
    const incoming = files.reduce((sum, file) => sum + file.incoming, 0);
    const outgoing = files.reduce((sum, file) => sum + file.outgoing, 0);
    return {
      id: `far:${directory}`,
      kind: "directory_group",
      label: directory,
      relativePath: directory,
      risk: maxRisk(files),
      classification: "diretorio",
      fileCount: files.length,
      directoryCount: directoryCounts.get(directory) || 0,
      incoming,
      outgoing,
      impactCount: files.reduce((sum, file) => sum + file.impactCount, 0),
      deletionDecision: aggregateDeletionDecision(files),
      utilityStatus: aggregateUtilityStatus(files),
      depth: Math.max(0, ...files.map((file) => file.depth)),
      size: files.reduce((sum, file) => sum + file.size, 0),
      children: files.map((file) => file.id),
      groupReason: "diretorio agregado por dependencias"
    };
  });

  const nodeForFile = new Map();
  for (const file of fileNodes) {
    nodeForFile.set(file.id, `far:${topDirectory(file.relativePath)}`);
  }

  return {
    mode: "distante",
    description: "diretorios agregados",
    nodes: viewNodes,
    edges: aggregateGraphEdges(edges, nodeForFile)
  };
}

function buildGroupedGraph(fileNodes, edges) {
  const edgeTargetsBySource = new Map(fileNodes.map((node) => [node.id, []]));
  for (const edge of edges) {
    edgeTargetsBySource.get(edge.source)?.push(edge.target);
  }

  const groups = new Map();
  for (const file of fileNodes) {
    const key = mediumGroupKey(file, edgeTargetsBySource);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(file);
  }

  const nodeForFile = new Map();
  const viewNodes = [];
  let groupIndex = 0;

  for (const [key, files] of groups.entries()) {
    const forceIndividual = files.length === 1;
    if (forceIndividual) {
      const node = toCloseGraphNode(files[0]);
      node.id = `medium:file:${files[0].relativePath}`;
      node.kind = "important_file";
      node.groupReason = "arquivo principal";
      nodeForFile.set(files[0].id, node.id);
      viewNodes.push(node);
      continue;
    }

    groupIndex += 1;
    const first = files[0];
    const extension = first.extension || "sem_ext";
    const groupReason = key.startsWith("shared:")
      ? "arquivos com dependencias em comum"
      : key.startsWith("dpn:")
        ? "arquivos agrupados por DPN, uso e categoria"
      : "arquivos agrupados por pasta, tipo e risco";
    const label = key.startsWith("shared:")
      ? `${files.length} arquivos dependentes`
      : key.startsWith("dpn:")
        ? `${files.length} ${first.fileKnowledge?.riskCategory || "dpn"} em ${topDirectory(first.relativePath)}`
      : `${files.length} ${extension} em ${topDirectory(first.relativePath)}`;
    const id = `medium:group:${groupIndex}`;
    for (const file of files) {
      nodeForFile.set(file.id, id);
    }
    viewNodes.push({
      id,
      kind: "dependency_group",
      label,
      relativePath: topDirectory(first.relativePath),
      risk: maxRisk(files),
      classification: commonClassification(files),
      fileCount: files.length,
      directoryCount: new Set(files.map((file) => topDirectory(file.relativePath))).size,
      incoming: files.reduce((sum, file) => sum + file.incoming, 0),
      outgoing: files.reduce((sum, file) => sum + file.outgoing, 0),
      impactCount: files.reduce((sum, file) => sum + file.impactCount, 0),
      deletionDecision: aggregateDeletionDecision(files),
      utilityStatus: aggregateUtilityStatus(files),
      depth: Math.max(0, ...files.map((file) => file.depth)),
      size: files.reduce((sum, file) => sum + file.size, 0),
      children: files.map((file) => file.id),
      groupReason
    });
  }

  return {
    mode: "medio",
    description: "arquivos principais e grupos de dependencia",
    nodes: viewNodes,
    edges: aggregateGraphEdges(edges, nodeForFile)
  };
}

function toCloseGraphNode(node) {
  return {
    id: node.id,
    kind: "file",
    label: node.name,
    name: node.name,
    relativePath: node.relativePath,
    extension: node.extension,
    risk: node.risk,
    classification: node.classification,
    fileCount: 1,
    directoryCount: 0,
    incoming: node.incoming,
    outgoing: node.outgoing,
    impactCount: node.impactCount,
    depth: node.depth,
    size: node.size,
    daysSinceAccess: node.daysSinceAccess,
    action: node.simulationAction,
    deletionDecision: node.deletionDecision,
    utilityStatus: node.utilityStatus,
    impact: node.impact,
    knowledgeCategories: node.fileKnowledge?.categories || [],
    relocationDecision: node.relocationDecision,
    riskScore: node.riskScore,
    riskReasons: node.riskReasons,
    children: [node.id],
    groupReason: "arquivo individual"
  };
}

function aggregateGraphEdges(edges, nodeForFile) {
  const aggregate = new Map();

  for (const edge of edges) {
    const source = nodeForFile.get(edge.source);
    const target = nodeForFile.get(edge.target);
    if (!source || !target || source === target) {
      continue;
    }
    const key = `${source}->${target}`;
    if (!aggregate.has(key)) {
      aggregate.set(key, {
        id: key,
        source,
        target,
        weight: 0,
        types: {},
        samples: []
      });
    }
    const item = aggregate.get(key);
    item.weight += 1;
    item.types[edge.type] = (item.types[edge.type] || 0) + 1;
    if (item.samples.length < 4) {
      item.samples.push({
        sourcePath: edge.sourcePath,
        targetPath: edge.targetPath,
        type: edge.type
      });
    }
  }

  return Array.from(aggregate.values()).map((edge) => ({
    ...edge,
    label: Object.entries(edge.types)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type}:${count}`)
      .join(", ")
  }));
}

function mediumGroupKey(file, edgeTargetsBySource) {
  const degree = file.incoming + file.outgoing;
  if (file.risk === "critico" || file.risk === "alto" || file.classification === "critico_protegido" || file.inCycle || degree >= 4) {
    return `single:${file.id}`;
  }

  const targets = (edgeTargetsBySource.get(file.id) || []).slice().sort();
  if (targets.length) {
    return `shared:${targets.slice(0, 5).join("|")}`;
  }

  if (file.dependencyGroup) {
    return `dpn:${topDirectory(file.relativePath)}:${file.dependencyGroup}:${file.risk}:${file.classification}`;
  }

  return `kind:${topDirectory(file.relativePath)}:${file.extension || "sem_ext"}:${file.risk}:${file.classification}`;
}

function countDirectoriesByTopLevel(directoryNodes) {
  const counts = new Map();
  for (const node of directoryNodes) {
    const top = topDirectory(node.relativePath);
    counts.set(top, (counts.get(top) || 0) + 1);
  }
  return counts;
}

function topDirectory(relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized || normalized === "." || !normalized.includes("/")) {
    return ".";
  }
  return normalized.split("/")[0];
}

function maxRisk(files) {
  if (files.some((file) => file.risk === "critico")) {
    return "critico";
  }
  if (files.some((file) => file.risk === "alto")) {
    return "alto";
  }
  if (files.some((file) => file.risk === "medio")) {
    return "medio";
  }
  return "baixo";
}

function commonClassification(files) {
  const classifications = new Set(files.map((file) => file.classification));
  if (classifications.size === 1) {
    return files[0].classification;
  }
  if (classifications.has("critico_protegido")) {
    return "critico_protegido";
  }
  return "misto";
}

function aggregateDeletionDecision(files) {
  if (files.some((file) => file.deletionDecision === "nao_apagar")) {
    return "nao_apagar";
  }
  if (files.some((file) => file.deletionDecision === "averiguar")) {
    return "averiguar";
  }
  if (files.some((file) => file.deletionDecision === "inutil_provavel")) {
    return "inutil_provavel";
  }
  return "pode_apagar";
}

function aggregateUtilityStatus(files) {
  const statuses = new Set(files.map((file) => file.utilityStatus));
  if (statuses.has("sistema")) {
    return "sistema";
  }
  if (statuses.has("protegido")) {
    return "protegido";
  }
  if (statuses.has("dependencia_relevante")) {
    return "dependencia_relevante";
  }
  if (statuses.has("bloco_interdependente")) {
    return "bloco_interdependente";
  }
  if (statuses.has("usado_pelo_usuario")) {
    return "usado_pelo_usuario";
  }
  if (statuses.has("utilidade_incerta")) {
    return "utilidade_incerta";
  }
  if (statuses.has("baixo_uso")) {
    return "baixo_uso";
  }
  return "inutil_provavel";
}

function countBy(items, field) {
  return items.reduce((accumulator, item) => {
    const key = item[field] || "desconhecido";
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
}

function stripInternalNodeFields(node) {
  const {
    absolutePath,
    incomingFrom,
    outgoingTo,
    detectedDependencies,
    canReadContent,
    initialUnresolvedDependencies,
    initialUnresolvedSpecifiers,
    readError,
    ...publicNode
  } = node;

  return {
    ...publicNode,
    readError: readError || null,
    dependencySamples: (detectedDependencies || []).slice(0, 12)
  };
}

function normalizeRelative(value) {
  const normalized = String(value || ".").replace(/\\/g, "/");
  return path.posix.normalize(normalized).replace(/^\.$/, ".");
}

function normalizeKey(value) {
  return normalizeRelative(value).toLowerCase();
}

function filesystemDepth(relativePath) {
  const normalized = normalizeRelative(relativePath);
  if (!normalized || normalized === ".") {
    return 0;
  }
  return normalized.split("/").filter(Boolean).length - 1;
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

function isKnownPythonStdlib(moduleName) {
  const root = moduleName.split(".")[0];
  return PYTHON_STDLIB.has(root);
}

const PYTHON_STDLIB = new Set([
  "abc",
  "argparse",
  "asyncio",
  "base64",
  "collections",
  "contextlib",
  "csv",
  "dataclasses",
  "datetime",
  "functools",
  "hashlib",
  "http",
  "io",
  "itertools",
  "json",
  "logging",
  "math",
  "os",
  "pathlib",
  "random",
  "re",
  "shutil",
  "sqlite3",
  "statistics",
  "subprocess",
  "sys",
  "tempfile",
  "time",
  "typing",
  "unittest",
  "urllib",
  "uuid"
]);

module.exports = {
  analyzeDirectory,
  analyzeDirectoryProgressive,
  escanear_diretorio: analyzeDirectory,
  escanear_diretorio_progressivo: analyzeDirectoryProgressive,
  extractDependencies,
  detectar_dependencias: extractDependencies,
  resolveDependency,
  detectar_ciclos: detectCyclesDfs,
  construir_grafo: buildGraphViews,
  classificar_arquivo: classifyNode,
  simular_riscos: buildSimulation,
  construir_passos_progressivos: buildProgressiveDepthSteps,
  DEFAULT_OPTIONS,
  MAX_SCAN_FILES,
  MAX_SCAN_DEPTH,
  DEFAULT_PROGRESSIVE_FILE_BUDGET
};
