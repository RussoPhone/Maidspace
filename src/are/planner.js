const path = require("node:path");

const CODE_EXTENSIONS = new Set([
  ".astro", ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java",
  ".js", ".jsx", ".kt", ".mjs", ".php", ".py", ".rs", ".svelte",
  ".ts", ".tsx", ".vue"
]);

const ASSET_EXTENSIONS = new Set([
  ".ai", ".css", ".gif", ".ico", ".jpeg", ".jpg", ".less", ".mp3",
  ".mp4", ".png", ".scss", ".svg", ".wav", ".webp"
]);

const DOC_EXTENSIONS = new Set([
  ".csv", ".doc", ".docx", ".md", ".pdf", ".ppt", ".pptx", ".rtf",
  ".txt", ".xls", ".xlsx"
]);

const INSTALLER_EXTENSIONS = new Set([".exe", ".msi", ".iso", ".dmg", ".pkg", ".deb", ".rpm"]);
const ARCHIVE_EXTENSIONS = new Set([".zip", ".7z", ".rar", ".tar", ".gz", ".xz"]);
const MEDIA_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".mp3", ".wav", ".flac", ".mp4", ".mov", ".mkv"]);

const MODE_ORDER = ["baixo", "medio", "alto"];
const RISK_WEIGHT = {
  baixo: 1,
  medio: 2,
  alto: 3,
  critico: 4
};

const MODE_RULES = {
  baixo: {
    label: "baixo",
    description: "Conservador: realoca apenas arquivos claramente inuteis, antigos, isolados e sem acesso/modificacao recente.",
    maxRisk: 1,
    minAccessDays: 30,
    minModifiedDays: 30,
    requireSafeProfile: true,
    packageMode: "arquivo"
  },
  medio: {
    label: "medio",
    description: "Equilibrado: realoca arquivos ou blocos antigos que nao afetem sistema, projetos recentes ou dependencias importantes.",
    maxRisk: 2,
    minAccessDays: 21,
    minModifiedDays: 7,
    requireSafeProfile: false,
    packageMode: "componente"
  },
  alto: {
    label: "alto",
    description: "Agressivo assistido: busca o maior ganho possivel sem tocar sistema, estruturas protegidas ou ciclos.",
    maxRisk: 3,
    minAccessDays: 0,
    minModifiedDays: 0,
    requireSafeProfile: false,
    packageMode: "componente"
  }
};

function generateRelocationPlan(addReport, options = {}) {
  const compact = options.compact === true;
  const candidateLimit = compact ? clampInteger(options.candidateLimit, 20, 1000, 160) : Infinity;
  const packageLimit = compact ? clampInteger(options.packageLimit, 20, 500, 80) : Infinity;
  const blockedLimit = compact ? clampInteger(options.blockedLimit, 20, 2000, 240) : Infinity;
  const operationLimit = compact ? clampInteger(options.operationLimit, 20, 2000, 240) : Infinity;
  const files = (addReport.nodes || []).filter((node) => node.kind === "file");
  const cycles = addReport.cycles || [];
  const context = {
    nodeByPath: new Map(files.map((node) => [node.relativePath, node])),
    componentMap: buildComponentMap(files)
  };
  const spatialEntries = files.map((node) => analyzeSpaceCandidate(node, context));
  const operationStats = summarizeOperations(spatialEntries);
  const operations = selectTopSpatialEntries(spatialEntries, operationLimit).map((entry) => planFile(entry.node, entry));
  const proposedStructure = buildProposedStructure(operations, cycles);
  const groups = groupOperations(operations);
  const inventoryEstimate = normalizeInventoryReclaimable(addReport.summary?.inventoryReclaimable);
  const spaceModes = buildSpaceModes(spatialEntries, context.nodeByPath, { candidateLimit, packageLimit, inventoryEstimate });
  const targetFreeBytes = normalizeTargetFreeBytes(options.targetFreeBytes);
  const targetPlan = buildTargetCleanupPlan(spaceModes, targetFreeBytes);
  const blockedEntries = spatialEntries.filter((entry) => entry.modes.length === 0);
  const blockedFiles = selectTopSpatialEntries(blockedEntries, blockedLimit)
    .map(toBlockedFile);
  const safetyReport = buildSafetyReport(spaceModes, blockedFiles, cycles);
  const storedBytes = files.reduce((sum, node) => sum + (node.size || 0), 0);
  const totalBytes = Number(addReport.summary?.totalBytes) || storedBytes;
  const totalFiles = Number(addReport.summary?.files) || files.length;
  const blockedBytes = blockedEntries.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
  const relocationSimulation = buildRelocationSimulation(spaceModes, totalBytes, blockedFiles);
  const depthRelocation = buildDepthRelocationBreakdown(spatialEntries);

  return {
    schemaVersion: 4,
    algorithm: "A.R.E",
    safeMode: true,
    generatedAt: new Date().toISOString(),
    rootPath: addReport.rootPath,
    objective: "calcular quanto espaco pode ser realocado com seguranca usando o relatorio do A.D.D",
    question: "Quanto pode ser realocado?",
    summary: {
      totalFiles,
      analyzedFiles: files.length,
      storedFiles: files.length,
      totalBytes,
      totalHuman: formatBytes(totalBytes),
      analyzedBytes: storedBytes,
      analyzedHuman: formatBytes(storedBytes),
      inventoryProvider: addReport.summary?.inventoryProvider || "node",
      inventoryTruncated: Boolean(addReport.summary?.inventoryTruncated),
      suggestions: operationStats.suggestions,
      keepInPlace: operationStats.keepInPlace,
      moveCandidates: operationStats.moveCandidates,
      reviewCandidates: operationStats.reviewCandidates,
      safeTrashCandidates: operationStats.safeTrashCandidates,
      blockedFiles: blockedEntries.length,
      blockedBytes,
      blockedHuman: formatBytes(blockedBytes),
      reallocatable: {
        baixo: spaceModes.baixo.reallocatableBytes,
        medio: spaceModes.medio.reallocatableBytes,
        alto: spaceModes.alto.reallocatableBytes
      },
      detailedReallocatable: {
        baixo: spaceModes.baixo.detailedReallocatableBytes,
        medio: spaceModes.medio.detailedReallocatableBytes,
        alto: spaceModes.alto.detailedReallocatableBytes
      },
      inventoryEstimatedReclaimable: {
        baixo: spaceModes.baixo.inventoryEstimatedBytes,
        medio: spaceModes.medio.inventoryEstimatedBytes,
        alto: spaceModes.alto.inventoryEstimatedBytes
      },
      reallocatableHuman: {
        baixo: spaceModes.baixo.reallocatableHuman,
        medio: spaceModes.medio.reallocatableHuman,
        alto: spaceModes.alto.reallocatableHuman
      },
      detailedReallocatableHuman: {
        baixo: spaceModes.baixo.detailedReallocatableHuman,
        medio: spaceModes.medio.detailedReallocatableHuman,
        alto: spaceModes.alto.detailedReallocatableHuman
      },
      inventoryEstimatedReclaimableHuman: {
        baixo: spaceModes.baixo.inventoryEstimatedHuman,
        medio: spaceModes.medio.inventoryEstimatedHuman,
        alto: spaceModes.alto.inventoryEstimatedHuman
      },
      targetFreeBytes,
      targetFreeHuman: formatBytes(targetFreeBytes),
      targetPlan,
      depthRelocation,
      compactedLists: compact,
      cycleBlocks: cycles.length
    },
    relocationSimulation,
    depthRelocation,
    spaceModes,
    candidatesByMode: {
      baixo: spaceModes.baixo.candidates,
      medio: spaceModes.medio.candidates,
      alto: spaceModes.alto.candidates
    },
    blockedFiles,
    safetyReport,
    proposedStructure,
    groups,
    operations,
    targetPlan,
    cycleBlocks: cycles.map((cycle) => ({
      id: cycle.id,
      type: cycle.type,
      nodeCount: cycle.nodeCount,
      files: cycle.nodeIds
        .map((id) => files.find((node) => node.id === id)?.relativePath)
        .filter(Boolean),
      suggestion: "manter junto; nao separar sem revisao manual"
    })),
    rules: [
      "Nao move, apaga ou altera arquivos automaticamente.",
      "Modo baixo aceita apenas arquivo isolado, antigo, risco baixo e perfil espacial seguro.",
      "Modo medio aceita pacotes antigos quando o componente inteiro pode ser realocado junto.",
      "Modo alto e agressivo, mas bloqueia sistema, estruturas protegidas, ciclos e dependencias essenciais.",
      "Em inventarios grandes, os totais podem vir da estimativa completa por metadados enquanto as listas exibem os principais candidatos detalhados.",
      "O A.R.E calcula ganho espacial; a execucao real depende de confirmacao do usuario."
    ],
    note: "Simulacao espacial: bytes realocados representam o que sairia do diretorio principal se o usuario confirmasse a realocacao indicada."
  };
}

function buildDepthRelocationBreakdown(spatialEntries) {
  const groups = new Map();

  for (const entry of spatialEntries) {
    const depth = Number.isFinite(Number(entry.node.scanDepth)) ? Number(entry.node.scanDepth) : filesystemDepth(entry.path);
    if (!groups.has(depth)) {
      groups.set(depth, {
        depth,
        files: 0,
        totalBytes: 0,
        totalHuman: "0 B",
        blockedBytes: 0,
        blockedHuman: "0 B",
        reallocatable: {
          baixo: 0,
          medio: 0,
          alto: 0
        },
        reallocatableHuman: {
          baixo: "0 B",
          medio: "0 B",
          alto: "0 B"
        }
      });
    }

    const group = groups.get(depth);
    const size = entry.sizeBytes || 0;
    group.files += 1;
    group.totalBytes += size;
    if (!entry.modes.length) {
      group.blockedBytes += size;
    }
    for (const mode of MODE_ORDER) {
      if (entry.modes.includes(mode)) {
        group.reallocatable[mode] += size;
      }
    }
  }

  return Array.from(groups.values())
    .sort((a, b) => a.depth - b.depth)
    .map((group) => ({
      ...group,
      totalHuman: formatBytes(group.totalBytes),
      blockedHuman: formatBytes(group.blockedBytes),
      reallocatableHuman: {
        baixo: formatBytes(group.reallocatable.baixo),
        medio: formatBytes(group.reallocatable.medio),
        alto: formatBytes(group.reallocatable.alto)
      }
    }));
}

function summarizeOperations(spatialEntries) {
  const summary = {
    suggestions: spatialEntries.length,
    keepInPlace: 0,
    moveCandidates: 0,
    reviewCandidates: 0,
    safeTrashCandidates: 0
  };

  for (const entry of spatialEntries) {
    if (!entry.modes.length) {
      summary.keepInPlace += 1;
    } else if (entry.node.deletionDecision === "pode_apagar") {
      summary.safeTrashCandidates += 1;
    } else if (entry.node.deletionDecision === "inutil_provavel") {
      summary.reviewCandidates += 1;
    } else {
      summary.moveCandidates += 1;
    }
  }

  return summary;
}

function selectTopSpatialEntries(entries, limit) {
  const safeLimit = Number.isFinite(limit) ? limit : entries.length;
  return entries
    .slice()
    .sort((a, b) => spatialEntryScore(b) - spatialEntryScore(a) || a.path.localeCompare(b.path))
    .slice(0, safeLimit);
}

function spatialEntryScore(entry) {
  const modeBonus = entry.modes.includes("alto") ? 400000 : entry.modes.includes("medio") ? 250000 : entry.modes.includes("baixo") ? 120000 : 0;
  return (entry.packageBytes || entry.sizeBytes || 0) + modeBonus + ((entry.node.impactCount || 0) * 1000);
}

function analyzeSpaceCandidate(node, context) {
  const profile = analyzeSpatialProfile(node);
  const absoluteBlockReasons = absoluteBlockReasonsFor(node);
  const packageNodesByMode = {};
  const packagePathsByMode = {};
  const packageBytesByMode = {};
  const modes = [];
  const modeReasons = {};

  for (const mode of MODE_ORDER) {
    const packageNodes = packageForMode(node, mode, context);
    packageNodesByMode[mode] = packageNodes;
    packagePathsByMode[mode] = packageNodes.map((item) => item.relativePath);
    packageBytesByMode[mode] = packageNodes.reduce((sum, item) => sum + (item.size || 0), 0);

    const result = modeEligibilityReason(mode, node, packageNodes, profile, absoluteBlockReasons);
    modeReasons[mode] = result.reason;
    if (result.allowed) {
      modes.push(mode);
    }
  }

  return {
    node,
    path: node.relativePath,
    sizeBytes: node.size || 0,
    packageBytes: packageBytesByMode.alto || node.size || 0,
    packagePaths: packagePathsByMode.alto || [node.relativePath],
    packagePathsByMode,
    packageBytesByMode,
    absoluteBlockReasons,
    modes,
    modeReasons,
    spatialProfile: profile,
    targetDirectory: targetByType(node),
    justification: justificationFor(node, modes, absoluteBlockReasons, modeReasons, profile)
  };
}

function modeEligibilityReason(mode, node, packageNodes, profile, absoluteBlockReasons) {
  const rule = MODE_RULES[mode];
  const riskWeight = RISK_WEIGHT[node.risk] || 2;
  const accessAge = effectiveAccessAge(packageNodes);
  const modifiedAge = minAge(packageNodes, "modifiedAt");
  const packageBlockReasons = packageBlockReasonsFor(packageNodes, mode);

  if (absoluteBlockReasons.length > 0) {
    return { allowed: false, reason: absoluteBlockReasons[0] };
  }
  if (packageBlockReasons.length > 0) {
    return { allowed: false, reason: packageBlockReasons[0] };
  }
  if (riskWeight > rule.maxRisk) {
    return { allowed: false, reason: `risco estrutural ${node.risk} acima do modo ${mode}` };
  }
  if (accessAge < rule.minAccessDays) {
    return { allowed: false, reason: `acesso recente no pacote (${accessAge} dia(s)); exige ${rule.minAccessDays}+` };
  }
  if (rule.minModifiedDays > 0 && modifiedAge < rule.minModifiedDays) {
    return { allowed: false, reason: `modificacao recente no pacote (${modifiedAge} dia(s)); exige ${rule.minModifiedDays}+` };
  }
  if (mode !== "alto" && packageNodes.some((item) => (item.unresolvedDependencies || 0) > 0)) {
    return { allowed: false, reason: "dependencias incertas exigem modo alto" };
  }
  if (mode === "baixo") {
    if (node.classification !== "isolado") {
      return { allowed: false, reason: "modo baixo exige classificacao isolado pelo A.D.D" };
    }
    if ((node.incoming || 0) > 0 || (node.outgoing || 0) > 0 || (node.impactCount || 0) > 0) {
      return { allowed: false, reason: "modo baixo exige impacto zero em dependencias" };
    }
    if (node.risk !== "baixo") {
      return { allowed: false, reason: "modo baixo exige risco estrutural baixo" };
    }
    if (rule.requireSafeProfile && !profile.safeLow) {
      return { allowed: false, reason: "modo baixo exige local ou tipo seguro para limpeza" };
    }
  }
  if (mode === "medio" && packageNodes.some((item) => item.risk === "alto")) {
    return { allowed: false, reason: "modo medio nao aceita risco alto no pacote" };
  }

  return { allowed: true, reason: `elegivel no modo ${mode}` };
}

function absoluteBlockReasonsFor(node) {
  const reasons = [];
  const impactSystem = node.impact?.system;

  if (node.inCycle) {
    reasons.push("faz parte de bloco interdependente");
  }
  if (node.risk === "critico") {
    reasons.push("risco estrutural critico");
  }
  if (node.protectedReasons?.length) {
    reasons.push(node.protectedReasons.join(", "));
  }
  if (impactSystem === "afeta_sistema" || impactSystem === "protegido") {
    reasons.push("arquivo de sistema ou protegido");
  }
  return Array.from(new Set(reasons));
}

function packageBlockReasonsFor(packageNodes, mode) {
  const reasons = [];
  const rule = MODE_RULES[mode];

  for (const item of packageNodes) {
    const systemImpact = item.impact?.system;
    if (item.inCycle) {
      reasons.push(`pacote contem ciclo: ${item.relativePath}`);
    }
    if (item.risk === "critico") {
      reasons.push(`pacote contem risco critico: ${item.relativePath}`);
    }
    if ((RISK_WEIGHT[item.risk] || 2) > rule.maxRisk) {
      reasons.push(`pacote contem risco ${item.risk}: ${item.relativePath}`);
    }
    if (item.protectedReasons?.length || systemImpact === "afeta_sistema" || systemImpact === "protegido") {
      reasons.push(`pacote contem arquivo protegido: ${item.relativePath}`);
    }
    if (mode !== "alto" && (item.unresolvedDependencies || 0) > 0) {
      reasons.push(`pacote contem dependencia incerta: ${item.relativePath}`);
    }
  }

  return Array.from(new Set(reasons));
}

function buildSpaceModes(spatialEntries, nodeByPath, options = {}) {
  const result = {};

  for (const mode of MODE_ORDER) {
    const entries = spatialEntries.filter((entry) => entry.modes.includes(mode));
    const packages = buildModePackages(entries, nodeByPath, mode, { limit: options.packageLimit });
    const candidates = entries
      .map((entry) => toModeCandidate(entry, mode))
      .sort((a, b) => b.packageBytes - a.packageBytes || a.path.localeCompare(b.path))
      .slice(0, Number.isFinite(options.candidateLimit) ? options.candidateLimit : undefined);
    const detailedReallocatableBytes = sumUniqueBytes(entries, nodeByPath, mode);
    const inventoryEstimatedBytes = options.inventoryEstimate?.[mode]?.bytes || 0;
    const inventoryEstimatedFiles = options.inventoryEstimate?.[mode]?.files || 0;
    const reallocatableBytes = Math.max(detailedReallocatableBytes, inventoryEstimatedBytes);
    const detailedFileCount = entries.length;
    const previewCandidateCount = candidates.length;
    const executableFileCount = Math.max(detailedFileCount, inventoryEstimatedFiles, previewCandidateCount);

    result[mode] = {
      mode,
      label: MODE_RULES[mode].label,
      description: MODE_RULES[mode].description,
      criteria: criteriaForMode(mode),
      reallocatableBytes,
      reallocatableHuman: formatBytes(reallocatableBytes),
      detailedReallocatableBytes,
      detailedReallocatableHuman: formatBytes(detailedReallocatableBytes),
      inventoryEstimatedBytes,
      inventoryEstimatedHuman: formatBytes(inventoryEstimatedBytes),
      inventoryEstimatedFiles,
      inventoryEstimateUsed: inventoryEstimatedBytes > detailedReallocatableBytes,
      detailedFileCount,
      previewCandidateCount,
      executableFileCount,
      fileCount: candidates.length,
      packageCount: packages.length,
      packageFileCount: packages.reduce((sum, item) => sum + item.fileCount, 0),
      packages,
      candidates
    };
  }

  return result;
}

function normalizeInventoryReclaimable(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  const result = {};
  for (const mode of MODE_ORDER) {
    const bucket = value[mode] || {};
    result[mode] = {
      bytes: Number(bucket.bytes || 0),
      files: Number(bucket.files || 0)
    };
  }
  return result;
}

function normalizeTargetFreeBytes(value) {
  const parsed = Number(value || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.round(parsed);
}

function buildTargetCleanupPlan(spaceModes, targetFreeBytes) {
  if (!targetFreeBytes) {
    return null;
  }

  for (const mode of MODE_ORDER) {
    const modeData = spaceModes[mode];
    if ((modeData.reallocatableBytes || 0) < targetFreeBytes) {
      continue;
    }

    const selected = selectApproximateCandidates(modeData.candidates || [], targetFreeBytes);
    const total = selected.reduce((sum, item) => sum + (item.packageBytes || item.sizeBytes || 0), 0);

    const enoughFromDetailedList = total >= targetFreeBytes;
    const hasApproximation = total > 0;
    return {
      targetBytes: targetFreeBytes,
      targetHuman: formatBytes(targetFreeBytes),
      selectedMode: mode,
      plannedBytes: hasApproximation ? total : modeData.reallocatableBytes,
      plannedHuman: formatBytes(hasApproximation ? total : modeData.reallocatableBytes),
      selectedFiles: selected.length,
      candidates: selected,
      status: enoughFromDetailedList ? "atingivel" : hasApproximation ? "aproximado" : "estimativa_exige_mais_detalhe",
      statusText: enoughFromDetailedList
        ? `usar modo ${mode} libera aproximadamente ${formatBytes(total)} com ${selected.length} arquivo(s).`
        : hasApproximation
          ? `modo ${mode} chega perto da meta: ${formatBytes(total)} com ${selected.length} arquivo(s).`
        : `modo ${mode} parece suficiente pela estimativa total (${modeData.reallocatableHuman}), mas a lista detalhada foi compactada.`
    };
  }

  const highest = spaceModes.alto;
  return {
    targetBytes: targetFreeBytes,
    targetHuman: formatBytes(targetFreeBytes),
    selectedMode: "insuficiente",
    plannedBytes: highest.reallocatableBytes || 0,
    plannedHuman: highest.reallocatableHuman || "0 B",
    selectedFiles: highest.candidates?.length || 0,
    candidates: highest.candidates || [],
    status: "insuficiente",
    statusText: `o inventario encontrou ${highest.reallocatableHuman || "0 B"}, abaixo da meta ${formatBytes(targetFreeBytes)}.`
  };
}

function selectApproximateCandidates(candidates, targetBytes) {
  const ordered = (candidates || [])
    .slice()
    .sort((a, b) => (b.packageBytes || b.sizeBytes || 0) - (a.packageBytes || a.sizeBytes || 0));
  const selected = [];
  const skipped = [];
  let total = 0;

  for (const item of ordered) {
    const bytes = item.packageBytes || item.sizeBytes || 0;
    if (!bytes || total >= targetBytes) {
      continue;
    }
    const underBy = targetBytes - total;
    if (bytes <= underBy) {
      selected.push(item);
      total += bytes;
    } else {
      skipped.push(item);
    }
  }

  if (total >= targetBytes || !skipped.length) {
    return selected;
  }

  let best = null;
  let bestDelta = Math.abs(targetBytes - total);
  for (const item of skipped) {
    const bytes = item.packageBytes || item.sizeBytes || 0;
    const delta = Math.abs(targetBytes - (total + bytes));
    if (delta < bestDelta) {
      best = item;
      bestDelta = delta;
    }
  }
  if (best) {
    selected.push(best);
  }
  return selected;
}

function buildModePackages(entries, nodeByPath, mode, options = {}) {
  const packages = new Map();
  const limit = Number.isFinite(options.limit) ? options.limit : Infinity;
  const orderedEntries = entries
    .slice()
    .sort((a, b) => (b.packageBytesByMode?.[mode] || b.sizeBytes || 0) - (a.packageBytesByMode?.[mode] || a.sizeBytes || 0));

  for (const entry of orderedEntries) {
    if (packages.size >= limit) {
      break;
    }
    const packagePaths = (entry.packagePathsByMode?.[mode] || [entry.path]).slice().sort();
    const key = packagePaths.join("|");
    if (!packages.has(key)) {
      const files = packagePaths
        .map((relativePath) => nodeByPath.get(relativePath))
        .filter(Boolean);
      const bytes = files.reduce((sum, node) => sum + (node.size || 0), 0);
      packages.set(key, {
        id: `are:${mode}:${packages.size + 1}`,
        mode,
        bytes,
        human: formatBytes(bytes),
        fileCount: files.length,
        files: packagePaths,
        candidateRoots: [],
        maxRisk: maxRisk(files),
        classifications: Array.from(new Set(files.map((node) => node.classification))).sort(),
        targetDirectory: targetByType(entry.node),
        justification: entry.justification
      });
    }
    packages.get(key).candidateRoots.push(entry.path);
  }

  return Array.from(packages.values()).sort((a, b) => b.bytes - a.bytes || a.files[0].localeCompare(b.files[0]));
}

function buildRelocationSimulation(spaceModes, totalBytes, blockedFiles) {
  const simulation = {};

  for (const mode of MODE_ORDER) {
    const spaceMode = spaceModes[mode];
    const relocatedBytes = spaceMode.reallocatableBytes;
    const remainingBytes = Math.max(0, totalBytes - relocatedBytes);
    const relocatedPercent = totalBytes > 0 ? Math.round((relocatedBytes / totalBytes) * 1000) / 10 : 0;

    simulation[mode] = {
      mode,
      beforeBytes: totalBytes,
      beforeHuman: formatBytes(totalBytes),
      relocatedBytes,
      relocatedHuman: formatBytes(relocatedBytes),
      remainingBytes,
      remainingHuman: formatBytes(remainingBytes),
      relocatedPercent,
      remainingPercent: Math.max(0, Math.round((100 - relocatedPercent) * 10) / 10),
      packageCount: spaceMode.packageCount || 0,
      candidateFiles: spaceMode.fileCount || 0,
      blockedFiles: blockedFiles.length,
      simulatedMoves: (spaceMode.packages || []).map((item) => ({
        action: "simular_realocacao_de_pacote",
        packageId: item.id,
        from: "diretorio_analisado",
        to: simulatedTargetFor(mode, item),
        bytes: item.bytes,
        human: item.human,
        fileCount: item.fileCount,
        files: item.files,
        candidateRoots: item.candidateRoots,
        justification: item.justification
      })),
      explanation: relocatedBytes > 0
        ? `Simulacao: ${formatBytes(relocatedBytes)} sairiam do diretorio principal no modo ${mode}.`
        : `Simulacao: nenhum pacote passou nos criterios do modo ${mode}; o ganho estimado e 0 B.`
    };
  }

  return simulation;
}

function toModeCandidate(entry, mode) {
  return {
    mode,
    path: entry.path,
    sizeBytes: entry.sizeBytes,
    sizeHuman: formatBytes(entry.sizeBytes),
    packageBytes: entry.packageBytesByMode[mode],
    packageHuman: formatBytes(entry.packageBytesByMode[mode]),
    packagePaths: entry.packagePathsByMode[mode],
    packageFileCount: entry.packagePathsByMode[mode].length,
    targetDirectory: entry.targetDirectory,
    classification: entry.node.classification,
    risk: entry.node.risk,
    structuralRisk: entry.node.risk,
    deletionDecision: entry.node.deletionDecision,
    relocationDecision: entry.node.relocationDecision,
    lastAccessedAt: entry.node.lastAccessedAt,
    lastModifiedAt: entry.node.modifiedAt,
    daysSinceAccess: entry.node.daysSinceAccess,
    daysSinceModified: daysSince(entry.node.modifiedAt),
    incoming: entry.node.incoming || 0,
    outgoing: entry.node.outgoing || 0,
    dependencyImpact: entry.node.impact?.dependencies || "desconhecido",
    userImpact: entry.node.impact?.user || "desconhecido",
    systemImpact: entry.node.impact?.system || "desconhecido",
    spatialCategories: entry.spatialProfile.categories,
    justification: entry.justification,
    requiresConfirmation: true
  };
}

function toBlockedFile(entry) {
  const reasons = Array.from(new Set([
    ...entry.absoluteBlockReasons,
    entry.modeReasons.alto,
    "nao atingiu os criterios do modo alto"
  ])).filter(Boolean);

  return {
    path: entry.path,
    sizeBytes: entry.sizeBytes,
    sizeHuman: formatBytes(entry.sizeBytes),
    classification: entry.node.classification,
    risk: entry.node.risk,
    structuralRisk: entry.node.risk,
    deletionDecision: entry.node.deletionDecision,
    lastAccessedAt: entry.node.lastAccessedAt,
    lastModifiedAt: entry.node.modifiedAt,
    daysSinceAccess: entry.node.daysSinceAccess,
    daysSinceModified: daysSince(entry.node.modifiedAt),
    incoming: entry.node.incoming || 0,
    outgoing: entry.node.outgoing || 0,
    spatialCategories: entry.spatialProfile.categories,
    reason: reasons[0] || "nao elegivel para realocacao segura",
    blockingReasons: reasons
  };
}

function justificationFor(node, modes, absoluteBlockReasons, modeReasons, profile) {
  if (!modes.length) {
    return absoluteBlockReasons[0] || modeReasons.alto || "nao passou nos criterios espaciais do A.R.E";
  }
  if (modes.includes("baixo")) {
    return `isolado, antigo e com perfil seguro (${profile.categories.join(", ") || "baixo risco"})`;
  }
  if (modes.includes("medio")) {
    return "pacote antigo pode ser realocado junto sem tocar sistema ou uso recente";
  }
  if (modes.includes("alto")) {
    return "candidato agressivo assistido; pacote completo nao toca sistema nem estruturas protegidas";
  }
  return "elegivel com confirmacao";
}

function buildComponentMap(files) {
  const map = new Map();
  for (const node of files) {
    const key = node.componentId || node.id;
    if (!map.has(key)) {
      map.set(key, []);
    }
    map.get(key).push(node);
  }
  return map;
}

function packageForMode(node, mode, context) {
  if (MODE_RULES[mode].packageMode === "arquivo") {
    return [node];
  }
  const componentNodes = context.componentMap.get(node.componentId || node.id) || [node];
  return componentNodes.slice().sort((a, b) => a.relativePath.localeCompare(b.relativePath));
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

function simulatedTargetFor(mode, packageItem) {
  if (mode === "baixo") {
    return packageItem.targetDirectory === "/lixeira_segura" ? "/lixeira_segura" : "/arquivo_morto/baixo_risco";
  }
  if (mode === "medio") {
    return "/armazenamento_secundario/pacotes_antigos";
  }
  return "/armazenamento_secundario/realocacao_agressiva";
}

function analyzeSpatialProfile(node) {
  const relativePath = String(node.relativePath || "").replace(/\\/g, "/").toLowerCase();
  const name = String(node.name || path.posix.basename(relativePath)).toLowerCase();
  const extension = String(node.extension || path.posix.extname(name)).toLowerCase();
  const categories = [];

  if (node.fileKnowledge?.isLowValueGenerated || /(^|\/)(cache|tmp|temp|logs?|\.cache)(\/|$)/.test(relativePath)) {
    categories.push("cache_temporario_log");
  }
  if (/(^|\/)(downloads|download)(\/|$)/.test(relativePath)) {
    categories.push("downloads_antigos");
  }
  if (/(^|\/)(build|dist|out|target|coverage|\.next\/cache|__pycache__)(\/|$)/.test(relativePath)) {
    categories.push("build_ou_artefato_antigo");
  }
  if (INSTALLER_EXTENSIONS.has(extension) || /\b(setup|installer|install|driver)\b/.test(name)) {
    categories.push("instalador_antigo");
  }
  if (ARCHIVE_EXTENSIONS.has(extension) || /\.(bak|old|backup|tmp|temp|log)$/i.test(name)) {
    categories.push("backup_pacote_ou_log_antigo");
  }
  if (/\b(copy|copia|cópia|duplicado|duplicate)\b|\(\d+\)/i.test(name)) {
    categories.push("duplicata_possivel");
  }
  if (MEDIA_EXTENSIONS.has(extension) && (node.incoming || 0) === 0 && (node.outgoing || 0) === 0) {
    categories.push("midia_solta_sem_vinculo");
  }

  return {
    categories: Array.from(new Set(categories)),
    safeLow: categories.length > 0
  };
}

function criteriaForMode(mode) {
  if (mode === "baixo") {
    return [
      "nao afeta nenhum outro arquivo",
      "ninguem depende dele",
      "nao depende de arquivos importantes",
      "nao faz parte de ciclo",
      "nao e arquivo do sistema",
      "nao foi acessado ou modificado recentemente",
      "classificacao isolado e risco estrutural baixo",
      "perfil seguro: downloads antigos, cache, temporario, duplicata, log, instalador antigo ou midia solta"
    ];
  }
  if (mode === "medio") {
    return [
      "nao afeta o sistema operacional",
      "nao e dependencia de arquivos usados recentemente",
      "nao foi acessado ha bastante tempo",
      "pode ser movido como pacote completo",
      "nao quebra projetos recentes",
      "nao esta em area critica do sistema"
    ];
  }
  return [
    "nao e essencial ao sistema operacional",
    "nao esta em diretorio critico",
    "nao possui protecao estrutural absoluta",
    "pode conter dependencias incertas, mas somente como revisao agressiva assistida",
    "pode ser movido para armazenamento secundario, lixeira segura ou arquivo morto",
    "mesmo com dependencias, o grupo completo pode ser realocado"
  ];
}

function sumUniqueBytes(entries, nodeByPath, mode) {
  let total = 0;
  for (const relativePath of uniquePackagePaths(entries, mode)) {
    total += nodeByPath.get(relativePath)?.size || 0;
  }
  return total;
}

function uniquePackagePaths(entries, mode) {
  const paths = new Set();
  for (const entry of entries) {
    for (const packagePath of entry.packagePathsByMode?.[mode] || [entry.path]) {
      paths.add(packagePath);
    }
  }
  return paths;
}

function buildSafetyReport(spaceModes, blockedFiles, cycles) {
  const highest = spaceModes.alto.reallocatableBytes;
  const blockedBytes = blockedFiles.reduce((sum, item) => sum + item.sizeBytes, 0);
  const riskLevel = cycles.length > 0 || blockedFiles.some((item) => item.risk === "critico")
    ? "critico"
    : blockedFiles.some((item) => item.risk === "alto")
      ? "alto"
      : "medio";

  return {
    riskLevel,
    blockedBytes,
    blockedHuman: formatBytes(blockedBytes),
    bestCaseReallocatableBytes: highest,
    bestCaseReallocatableHuman: formatBytes(highest),
    text: [
      `Modo baixo pode realocar ${spaceModes.baixo.reallocatableHuman}.`,
      `Modo medio pode realocar ${spaceModes.medio.reallocatableHuman}.`,
      `Modo alto pode realocar ${spaceModes.alto.reallocatableHuman}.`,
      `${blockedFiles.length} arquivo(s) foram bloqueados por risco, uso recente, sistema, ciclo ou dependencia compartilhada.`,
      "Nenhuma acao e executada automaticamente; o A.R.E so calcula ganho espacial e prepara a decisao do usuario."
    ].join(" ")
  };
}

function planFile(node, spatialEntry) {
  const base = {
    source: node.relativePath,
    currentDirectory: directoryOf(node.relativePath),
    classification: node.classification,
    risk: node.risk,
    deletionDecision: node.deletionDecision,
    relocationDecision: node.relocationDecision,
    sizeBytes: node.size || 0,
    sizeHuman: formatBytes(node.size || 0),
    packageBytes: spatialEntry.packageBytes,
    packageHuman: formatBytes(spatialEntry.packageBytes),
    eligibleModes: spatialEntry.modes,
    requiresConfirmation: true,
    dependenciesToMoveWith: spatialEntry.packagePathsByMode.alto.filter((item) => item !== node.relativePath),
    dependentsToProtect: node.dependents || [],
    cycleBlockId: node.cycleBlockId || null
  };

  if (!spatialEntry.modes.length) {
    return {
      ...base,
      action: "manter",
      targetDirectory: base.currentDirectory,
      reason: spatialEntry.justification,
      priority: node.risk === "critico" ? "critica" : "alta"
    };
  }

  if (node.deletionDecision === "pode_apagar") {
    return {
      ...base,
      action: "sugerir_lixeira_segura",
      targetDirectory: "/lixeira_segura",
      reason: spatialEntry.justification,
      priority: "baixa"
    };
  }

  if (node.deletionDecision === "inutil_provavel") {
    return {
      ...base,
      action: "revisar",
      targetDirectory: "/revisar/baixo_uso",
      reason: spatialEntry.justification,
      priority: "baixa"
    };
  }

  return {
    ...base,
    action: "sugerir_mover",
    targetDirectory: spatialEntry.targetDirectory,
    reason: spatialEntry.justification,
    priority: spatialEntry.modes.includes("baixo") ? "baixa" : spatialEntry.modes.includes("medio") ? "media" : "alta"
  };
}

function buildProposedStructure(operations, cycles) {
  const directories = new Map([
    ["/src", "codigo e arquivos de projeto"],
    ["/assets", "imagens, estilos, audio, video e midia"],
    ["/docs", "documentos e notas"],
    ["/tests", "testes detectados por nome ou caminho"],
    ["/isolados", "arquivos sem dependencias locais"],
    ["/revisar", "arquivos que exigem decisao humana"],
    ["/revisar/baixo_uso", "candidatos pouco usados"],
    ["/revisar/mistos", "arquivos dependentes e provedores"],
    ["/revisar/blocos_interdependentes", "ciclos detectados por DFS"],
    ["/lixeira_segura", "candidatos a descarte com confirmacao"]
  ]);

  return Array.from(directories.entries()).map(([directory, purpose]) => ({
    directory,
    purpose,
    plannedItems: operations.filter((item) => item.targetDirectory === directory).length,
    plannedBytes: operations
      .filter((item) => item.targetDirectory === directory)
      .reduce((sum, item) => sum + (item.sizeBytes || 0), 0),
    cycleBlocks: directory === "/revisar/blocos_interdependentes" ? cycles.length : 0
  }));
}

function groupOperations(operations) {
  return operations.reduce((groups, operation) => {
    const key = operation.action;
    if (!groups[key]) {
      groups[key] = [];
    }
    groups[key].push(operation);
    return groups;
  }, {});
}

function targetByType(node) {
  const lowerPath = String(node.relativePath || "").toLowerCase();
  const extension = String(node.extension || "").toLowerCase();

  if (/(^|\/)(test|tests|spec|__tests__)(\/|$)/.test(lowerPath) || /\.(test|spec)\.[a-z0-9]+$/.test(lowerPath)) {
    return "/tests";
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return "/src";
  }
  if (ASSET_EXTENSIONS.has(extension)) {
    return "/assets";
  }
  if (DOC_EXTENSIONS.has(extension)) {
    return "/docs";
  }
  return "/revisar";
}

function directoryOf(relativePath) {
  const directory = path.posix.dirname(String(relativePath || ".").replace(/\\/g, "/"));
  return directory === "." ? "/" : `/${directory}`;
}

function filesystemDepth(relativePath) {
  const normalized = String(relativePath || ".").replace(/\\/g, "/");
  if (!normalized || normalized === ".") {
    return 0;
  }
  return normalized.split("/").filter(Boolean).length - 1;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function minAge(nodes, dateField, fallbackAgeField = null) {
  return Math.min(...nodes.map((node) => {
    if (fallbackAgeField && Number.isFinite(Number(node[fallbackAgeField]))) {
      return Number(node[fallbackAgeField]);
    }
    return daysSince(node[dateField]);
  }));
}

function effectiveAccessAge(nodes) {
  const accessAge = minAge(nodes, "lastAccessedAt", "daysSinceAccess");
  const modifiedAge = minAge(nodes, "modifiedAt");
  const scannerLikelyTouchedAccess = nodes.length > 0 && nodes.every((node) => Number(node.daysSinceAccess ?? 0) <= 1);

  if (scannerLikelyTouchedAccess && modifiedAge > accessAge) {
    return modifiedAge;
  }

  return accessAge;
}

function daysSince(value) {
  const timestamp = Date.parse(value || "");
  if (!Number.isFinite(timestamp)) {
    return 0;
  }
  const diff = Date.now() - timestamp;
  if (diff < 0) {
    return 0;
  }
  return Math.floor(diff / 86400000);
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B";
  }
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = unitIndex === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

module.exports = {
  generateRelocationPlan,
  gerar_plano_relocacao: generateRelocationPlan
};
