const state = {
  result: null,
  activeTab: "graph",
  graphLayout: new Map(),
  currentGraphNodes: [],
  currentGraphEdges: [],
  selectedNodeId: null,
  hoveredNodeId: null,
  expandedGroups: new Set(),
  zoom: 1,
  graphPan: { x: 0, y: 0 },
  graphTransform: null,
  isPanningGraph: false,
  lastPanPoint: null,
  graphMode: "medium",
  graphViewCache: new Map(),
  graphViewCacheResult: null,
  graphRenderFrame: 0,
  scanProgressTimer: null,
  scanProgressStartedAt: 0,
  scanProgressPercent: 0,
  lastAlcReport: null,
  alcFilters: {
    areMode: "target",
    risks: ["baixo", "medio", "alto", "critico"]
  },
  alcDraft: {
    targetKind: "directory",
    targetDirectory: ""
  }
};

const labels = {
  isolado: "isolado",
  dicente: "dicente",
  docente: "docente",
  misto: "misto",
  dependente: "dicente",
  provedor: "docente",
  dependente_provedor: "misto",
  critico_protegido: "crítico/protegido",
  diretorio: "diretório"
  ,
  critico_protegido: "critico/protegido",
  diretorio: "diretorio",
  bloco_interdependente: "bloco interdependente"
};

const riskColors = {
  baixo: "#2f8f57",
  medio: "#d7a02c",
  alto: "#c84444",
  critico: "#7f1d1d"
};

const riskWeight = {
  critico: 4,
  alto: 3,
  medio: 2,
  baixo: 1
};

const graphModes = {
  far: {
    key: "far",
    label: "mapa",
    view: "far",
    limit: 220,
    edgeLimit: 0,
    nodeScale: 1.28,
    labels: true
  },
  medium: {
    key: "medium",
    label: "grupos",
    view: "medium",
    limit: 720,
    edgeLimit: 220,
    nodeScale: 0.98,
    labels: true
  },
  close: {
    key: "close",
    label: "arquivos",
    view: "close",
    limit: 1800,
    edgeLimit: 520,
    nodeScale: 0.72,
    labels: true
  }
};

const elements = {
  serverStatus: document.querySelector("#serverStatus"),
  rootPath: document.querySelector("#rootPath"),
  chooseRootButton: document.querySelector("#chooseRootButton"),
  targetFreeGb: document.querySelector("#targetFreeGb"),
  scanButton: document.querySelector("#scanButton"),
  scanProgress: document.querySelector("#scanProgress"),
  progressLabel: document.querySelector("#progressLabel"),
  progressElapsed: document.querySelector("#progressElapsed"),
  progressBar: document.querySelector("#progressBar"),
  systemLogList: document.querySelector("#systemLogList"),
  exportButton: document.querySelector("#exportButton"),
  metrics: document.querySelector("#metrics"),
  graphCanvas: document.querySelector("#graphCanvas"),
  graphHint: document.querySelector("#graphHint"),
  graphFilter: document.querySelector("#graphFilter"),
  depthFilter: document.querySelector("#depthFilter"),
  zoomLabel: document.querySelector("#zoomLabel"),
  modeFar: document.querySelector("#modeFar"),
  modeMedium: document.querySelector("#modeMedium"),
  modeClose: document.querySelector("#modeClose"),
  nodeDetails: document.querySelector("#nodeDetails"),
  fileSearch: document.querySelector("#fileSearch"),
  filesTable: document.querySelector("#filesTable"),
  simulationGrid: document.querySelector("#simulationGrid"),
  areSummary: document.querySelector("#areSummary"),
  openAreModal: document.querySelector("#openAreModal"),
  closeAreModal: document.querySelector("#closeAreModal"),
  areModal: document.querySelector("#areModal"),
  areModalBody: document.querySelector("#areModalBody"),
  openAlcModal: document.querySelector("#openAlcModal"),
  closeAlcModal: document.querySelector("#closeAlcModal"),
  alcModal: document.querySelector("#alcModal"),
  alcModalBody: document.querySelector("#alcModalBody"),
  continuousState: document.querySelector("#continuousState"),
  depthTimeline: document.querySelector("#depthTimeline"),
  dependenciesTable: document.querySelector("#dependenciesTable"),
  cyclesList: document.querySelector("#cyclesList"),
  textReport: document.querySelector("#textReport"),
  warningsList: document.querySelector("#warningsList"),
  fileDependencyPopover: document.querySelector("#fileDependencyPopover")
};

init();

async function init() {
  bindEvents();
  renderEmpty();

  try {
    const health = await fetchJson("/api/health");
    elements.rootPath.value = health.defaultRootPath || health.cwd || "";
    if (elements.targetFreeGb) {
      elements.targetFreeGb.value = bytesToWholeGb(health.defaultOptions.targetFreeBytes || 0);
    }
    setStatus(isNativeMaidSpace() ? "local" : "fallback local", "ok");
  } catch (error) {
    setStatus("servidor indisponível", "error");
  }
}

function bindEvents() {
  elements.scanButton.addEventListener("click", runScan);
  elements.chooseRootButton?.addEventListener("click", chooseRootDirectory);
  elements.exportButton.addEventListener("click", exportJson);
  elements.graphFilter.addEventListener("change", renderGraph);
  elements.depthFilter?.addEventListener("change", () => {
    renderGraph();
    renderFiles();
  });
  elements.fileSearch.addEventListener("input", () => {
    renderFiles();
    renderGraph();
  });
  elements.graphCanvas.addEventListener("click", selectCanvasNode);
  elements.graphCanvas.addEventListener("contextmenu", (event) => event.preventDefault());
  elements.graphCanvas.addEventListener("mousedown", startGraphPan);
  elements.graphCanvas.addEventListener("mousemove", hoverCanvasNode);
  elements.graphCanvas.addEventListener("wheel", zoomGraphWithWheel, { passive: false });
  window.addEventListener("mouseup", stopGraphPan);
  elements.graphCanvas.addEventListener("mouseleave", () => {
    if (state.isPanningGraph) {
      return;
    }
    if (state.hoveredNodeId) {
      state.hoveredNodeId = null;
      renderGraph();
    }
  });
  document.addEventListener("click", clearNodeSelectionOnOutsideClick);
  elements.modeFar?.addEventListener("click", () => setGraphMode("far"));
  elements.modeMedium?.addEventListener("click", () => setGraphMode("medium"));
  elements.modeClose?.addEventListener("click", () => setGraphMode("close"));
  elements.openAreModal?.addEventListener("click", openAreModal);
  elements.closeAreModal?.addEventListener("click", closeAreModal);
  elements.areModal?.querySelector("[data-close-modal='are']")?.addEventListener("click", closeAreModal);
  elements.openAlcModal?.addEventListener("click", openAlcModal);
  elements.closeAlcModal?.addEventListener("click", closeAlcModal);
  elements.alcModal?.querySelector("[data-close-modal='alc']")?.addEventListener("click", closeAlcModal);
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (elements.alcModal && !elements.alcModal.classList.contains("is-hidden")) {
      closeAlcModal();
      return;
    }
    if (elements.areModal && !elements.areModal.classList.contains("is-hidden")) {
      closeAreModal();
    }
  });

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab;
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("is-active", tab === button));
      document.querySelectorAll(".tab-panel").forEach((panel) => {
        panel.classList.toggle("is-active", panel.id === `tab-${state.activeTab}`);
      });
      if (state.activeTab === "graph") {
        renderGraph();
      }
    });
  });

  window.addEventListener("resize", () => {
    if (state.activeTab === "graph") {
      scheduleGraphRender();
    }
  });
}

function setGraphMode(modeKey) {
  if (!graphModes[modeKey]) {
    return;
  }
  state.graphMode = modeKey;
  state.zoom = 1;
  state.graphPan = { x: 0, y: 0 };
  state.expandedGroups.clear();
  scheduleGraphRender();
}

async function runScan() {
  const rootPath = elements.rootPath.value.trim();
  if (!rootPath) {
    setStatus("informe um diretório", "error");
    elements.rootPath.focus();
    return;
  }

  const options = buildDefaultScanOptions();

  elements.scanButton.disabled = true;
  elements.exportButton.disabled = true;
  setStatus("escaneando", "busy");
  startScanProgress();
  resetSystemLog();
  appendSystemLog(isNativeMaidSpace() ? "MaidSpace local iniciado." : "MaidSpace fallback iniciado.");

  try {
    state.result = await fetchJson("/api/scan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rootPath, options })
    });
    resetGraphCache();
    state.selectedNodeId = null;
    state.hoveredNodeId = null;
    state.graphPan = { x: 0, y: 0 };
    elements.exportButton.disabled = false;
    syncOptionsFromResult();
    setStatus(`ok - ${state.result.summary.elapsedMs} ms`, "ok");
    finishScanProgress("ok", state.result);
    appendSystemLog(`Varredura concluida: ${formatNumber(state.result.summary.files || 0)} arquivos e ${formatBytes(state.result.summary.totalBytes || 0)} lidos.`);
    renderAll();
  } catch (error) {
    const message = errorMessage(error);
    setStatus("erro na varredura", "error");
    finishScanProgress("error");
    appendSystemLog(`Erro: ${message}`);
    renderError(message);
  } finally {
    elements.scanButton.disabled = false;
  }
}

function buildDefaultScanOptions() {
  return {
    adaptive: true,
    saveState: false,
    includeProgramFiles: true,
    targetFreeBytes: targetFreeBytesFromInput()
  };
}

function syncOptionsFromResult() {
  if (!state.result?.options) {
    return;
  }
  if (elements.targetFreeGb) {
    elements.targetFreeGb.value = bytesToWholeGb(state.result.options.targetFreeBytes || 0);
  }
}

async function chooseRootDirectory() {
  try {
    const directory = await pickDirectory("Cole o caminho da pasta raiz para varrer:");
    if (directory) {
      elements.rootPath.value = directory;
      appendSystemLog(`Diretorio raiz definido: ${directory}`);
    }
  } catch (error) {
    appendSystemLog(`Falha ao escolher diretorio: ${errorMessage(error)}`);
  }
}

async function pickDirectory(fallbackMessage = "Cole o caminho da pasta:") {
  if (isNativeMaidSpace()) {
    return await fetchNative("/api/pick-directory", { method: "POST" });
  }

  return window.prompt(fallbackMessage, "") || null;
}

async function fetchJson(url, options) {
  if (isNativeMaidSpace()) {
    return fetchNative(url, options);
  }

  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Falha HTTP ${response.status}`);
  }
  return payload;
}

function isNativeMaidSpace() {
  return Boolean(window.__TAURI__?.core?.invoke);
}

async function fetchNative(url, options = {}) {
  const invoke = window.__TAURI__.core.invoke;
  try {
    if (url === "/api/health") {
      return await invoke("maidspace_health");
    }
    if (url === "/api/pick-directory") {
      return await invoke("pick_directory");
    }
    if (url === "/api/scan") {
      const body = JSON.parse(options.body || "{}");
      const targetFreeBytes = body.options?.targetFreeBytes || 0;
      const scan = await invoke("analyze_maidspace", {
        rootPath: body.rootPath,
        targetFreeBytes
      });
      return nativeReportToResult(scan, body.rootPath, body.options || {});
    }
    if (url === "/api/alc/relocate") {
      const body = JSON.parse(options.body || "{}");
      return await invoke("execute_alc_relocation", {
        request: body.request
      });
    }
  } catch (error) {
    throw asError(error);
  }
  throw new Error(`Rota local nao suportada: ${url}`);
}

function asError(error) {
  return error instanceof Error ? error : new Error(errorMessage(error));
}

function errorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  if (error && typeof error === "object") {
    if (typeof error.message === "string" && error.message.trim()) {
      return error.message;
    }
    if (typeof error.error === "string" && error.error.trim()) {
      return error.error;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return "Erro desconhecido no MaidSpace local.";
}

function targetFreeBytesFromInput() {
  const gb = Number(elements.targetFreeGb?.value || 0);
  if (!Number.isFinite(gb) || gb <= 0) {
    return 0;
  }
  return Math.round(gb * 1024 * 1024 * 1024);
}

function bytesToWholeGb(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.round(value / 1024 / 1024 / 1024);
}

function nativeReportToResult(scan, rootPath, options = {}) {
  const report = scan.report || scan;
  const files = report.files || [];
  const nodes = files.map((file, index) => nativeFileToNode(file, index));
  const totalBytes = Number(report.summary?.total_bytes ?? files.reduce((sum, file) => sum + Number(file.size || 0), 0));
  const summary = {
    scannedAt: new Date().toISOString(),
    elapsedMs: 0,
    directories: report.summary?.directories || 0,
    storedDirectories: 0,
    files: report.summary?.files || nodes.length,
    analyzedFiles: report.summary?.analyzed_files || nodes.length,
    storedFiles: nodes.length,
    totalBytes,
    totalHuman: formatBytes(totalBytes),
    storedBytes: report.summary?.analyzed_bytes || nodes.reduce((sum, node) => sum + (node.size || 0), 0),
    storedHuman: formatBytes(report.summary?.analyzed_bytes || nodes.reduce((sum, node) => sum + (node.size || 0), 0)),
    inventoryProvider: "rust_local",
    inventoryTruncated: (report.summary?.files || nodes.length) > nodes.length,
    inventoryReclaimable: normalizeNativeInventoryReclaimable(report.summary?.inventory_reclaimable || report.summary?.inventoryReclaimable),
    scanStrategy: "local_rust_metadata_target",
    auxiliaryDatabase: null,
    heavyFolders: [],
    dependencyGroups: [],
    dependencyGroupCount: 0,
    targetedDfsProbes: { scheduled: 0, skipped: 0, remainingBudget: 0, parsed: 0, partialReads: 0 },
    depthBreakdown: buildNativeDepthBreakdown(nodes),
    entries: (report.summary?.directories || 0) + (report.summary?.files || nodes.length),
    edges: 0,
    components: nodes.length,
    cycles: 0,
    cycleNodes: 0,
    skipped: 0,
    warnings: 0,
    stoppedEarly: false,
    stopReason: null,
    byClassification: countByField(nodes, "classification"),
    byRisk: countByField(nodes, "risk"),
    byDeletionDecision: countByField(nodes, "deletionDecision"),
    byUtilityStatus: countByField(nodes, "utilityStatus"),
    byKnowledge: {
      systemEssential: nodes.filter((node) => node.fileKnowledge?.isSystemEssential).length,
      projectDependency: nodes.filter((node) => node.fileKnowledge?.isProjectDependency).length,
      userContent: nodes.filter((node) => node.fileKnowledge?.isUserContent).length,
      lowValueGenerated: nodes.filter((node) => node.fileKnowledge?.isLowValueGenerated).length,
      usedLast7Days: nodes.filter((node) => node.daysSinceAccess <= 7).length
    },
    candidateLowRisk: nodes.filter((node) => node.risk === "baixo" && node.classification === "isolado").length,
    canDelete: nodes.filter((node) => node.deletionDecision === "pode_apagar").length,
    probablyUseless: nodes.filter((node) => node.deletionDecision === "inutil_provavel").length,
    mustKeep: nodes.filter((node) => node.deletionDecision === "nao_apagar").length,
    criticalRisk: nodes.filter((node) => node.risk === "critico").length,
    protected: nodes.filter((node) => node.classification === "critico_protegido").length,
    unresolvedDependencies: 0,
    recentlyAccessed: nodes.filter((node) => node.daysSinceAccess <= 4).length,
    staleCandidates: nodes.filter((node) => node.daysSinceAccess >= 30 && node.risk === "baixo").length,
    highImpactProviders: 0,
    totalTransitiveImpact: 0
  };
  const targetFreeBytes = Number(scan.targetFreeBytes || options.targetFreeBytes || 0);
  const relocationPlan = buildNativeRelocationPlan(nodes, summary, targetFreeBytes, report.root_path || rootPath);

  return {
    schemaVersion: 1,
    algorithm: "MaidSpace.Local",
    rootPath: report.root_path || rootPath,
    options: {
      adaptive: true,
      scanEngine: "rust_local",
      dependencyMode: "metadata",
      maxFiles: report.summary?.analyzed_files || nodes.length,
      maxDepth: 1024,
      targetFreeBytes,
      includeProgramFiles: true
    },
    scaleEstimate: { scale: "massivo", provider: "rust_local" },
    summary,
    nodes,
    edges: [],
    components: nodes.map((node, index) => ({
      id: `component:${index + 1}`,
      nodeIds: [node.id],
      nodeCount: 1,
      edgeCount: 0,
      depth: 0,
      risk: node.risk,
      hasProtected: node.protectedReasons.length > 0,
      hasCycle: false,
      criticalRiskNodes: node.risk === "critico" ? 1 : 0,
      highRiskNodes: node.risk === "alto" ? 1 : 0,
      mediumRiskNodes: node.risk === "medio" ? 1 : 0
    })),
    cycles: [],
    graphViews: nativeEmptyGraphViews(),
    simulation: buildNativeSimulation(nodes),
    skipped: [],
    warnings: summary.inventoryTruncated
      ? [`MaidSpace local exibiu ${nodes.length}/${summary.files} arquivos detalhados; os totais foram calculados no inventario local.`]
      : [],
    system: "MaidSpace",
    modules: {
      add: { algorithm: "A.D.D", status: "concluido", summary },
      are: { algorithm: "A.R.E", status: "plano_gerado", summary: relocationPlan.summary },
      alc: { algorithm: "A.L.C", status: "local_sem_estado", summary: { reanalysisNeeded: false }, statePath: null }
    },
    relocationPlan,
    continuousState: { mode: "local_tauri", summary: { reanalysisNeeded: false }, changes: [] },
    report: {
      text: `# MaidSpace\n\nInventario local Rust: ${formatNumber(summary.files)} arquivo(s), ${summary.totalHuman}. Meta: ${formatBytes(targetFreeBytes)}.`
    }
  };
}

function nativeFileToNode(file, index) {
  const relativePath = String(file.path || `file-${index}`);
  const decision = nativeDecision(file.deletion_decision);
  const utility = nativeUtility(file.utility_status);
  const dependencyHint = String(file.dependency_hint || "none");
  const protectedReasons = file.protected_reasons || [];
  const risk = protectedReasons.length
    ? "critico"
    : dependencyHint === "high"
      ? "alto"
      : dependencyHint === "medium" || decision === "averiguar"
        ? "medio"
        : "baixo";
  const extension = normalizeExtension(file.extension);
  return {
    id: `file:${relativePath}`,
    kind: "file",
    name: relativePath.split("/").pop() || relativePath,
    relativePath,
    extension,
    size: Number(file.size || 0),
    modifiedAt: null,
    lastAccessedAt: null,
    createdAt: null,
    daysSinceAccess: Number(file.days_since_access || 0),
    protectedReasons,
    fileKnowledge: {
      categories: [],
      isSystemEssential: utility === "sistema",
      isProjectDependency: dependencyHint === "high" || dependencyHint === "medium",
      isUserContent: false,
      isLowValueGenerated: decision === "pode_apagar" || decision === "inutil_provavel",
      dependencyGroup: `dpn:rust:${dependencyHint}:${extension || "sem_ext"}`
    },
    dependencyGroup: `dpn:rust:${dependencyHint}:${extension || "sem_ext"}`,
    incoming: 0,
    outgoing: 0,
    depth: 0,
    scanDepth: filesystemDepthClient(relativePath),
    impactCount: 0,
    componentId: `component:${index + 1}`,
    componentSize: 1,
    inCycle: false,
    cycleBlockId: null,
    cycleBlockIds: [],
    cycleGroupSize: 0,
    dependsOn: [],
    dependents: [],
    classification: protectedReasons.length ? "critico_protegido" : "isolado",
    risk,
    riskScore: risk === "critico" ? 100 : risk === "alto" ? 70 : risk === "medio" ? 35 : 10,
    riskReasons: protectedReasons,
    impact: {
      system: protectedReasons.length ? "protegido" : "nao_afeta_sistema",
      user: utility === "usado_pelo_usuario" ? "alto" : "baixo",
      dependencies: dependencyHint
    },
    utilityStatus: utility,
    deletionDecision: decision,
    relocationDecision: decision === "nao_apagar" ? "nao_mover" : "pode_mexer",
    simulationAction: decision === "pode_apagar" ? "sugerir_lixeira_segura" : decision === "nao_apagar" ? "proteger_nao_mover" : "revisar",
    simulation: null,
    dependencyProbe: { enabled: false, reason: "rust_local", status: "not_needed" },
    readError: null,
    dependencySamples: []
  };
}

function normalizeNativeInventoryReclaimable(value) {
  const result = {};
  for (const mode of ["baixo", "medio", "alto"]) {
    const bucket = value?.[mode] || {};
    result[mode] = {
      bytes: Number(bucket.bytes || 0),
      files: Number(bucket.files || 0)
    };
  }
  return result;
}

function buildNativeRelocationPlan(nodes, summary, targetFreeBytes, rootPath = "") {
  const inventoryEstimate = summary.inventoryReclaimable || normalizeNativeInventoryReclaimable(null);
  const modes = {
    baixo: nodes.filter((node) => node.deletionDecision === "pode_apagar"),
    medio: nodes.filter((node) => node.deletionDecision === "pode_apagar" || node.deletionDecision === "inutil_provavel"),
    alto: nodes.filter((node) => node.deletionDecision !== "nao_apagar")
  };
  const spaceModes = Object.fromEntries(["baixo", "medio", "alto"].map((mode) => {
    const candidates = modes[mode]
      .slice()
      .sort((a, b) => b.size - a.size)
      .map((node) => nativeModeCandidate(node, mode));
    const detailedBytes = sumNodeBytes(modes[mode]);
    const estimatedBytes = Number(inventoryEstimate[mode]?.bytes || 0);
    const estimatedFiles = Number(inventoryEstimate[mode]?.files || 0);
    const bytes = Math.max(detailedBytes, estimatedBytes);
    return [mode, {
      mode,
      label: mode,
      description: mode === "alto" ? "Agressivo assistido local." : mode === "medio" ? "Equilibrado local." : "Conservador local.",
      criteria: [],
      reallocatableBytes: bytes,
      reallocatableHuman: formatBytes(bytes),
      detailedReallocatableBytes: detailedBytes,
      detailedReallocatableHuman: formatBytes(detailedBytes),
      inventoryEstimatedBytes: estimatedBytes,
      inventoryEstimatedHuman: formatBytes(estimatedBytes),
      inventoryEstimatedFiles: estimatedFiles,
      inventoryEstimateUsed: estimatedBytes > detailedBytes,
      fileCount: Math.max(candidates.length, estimatedFiles),
      packageCount: Math.max(candidates.length, estimatedFiles),
      packageFileCount: Math.max(candidates.length, estimatedFiles),
      packages: candidates.slice(0, 80).map((item, index) => ({
        id: `native:${mode}:${index + 1}`,
        mode,
        bytes: item.sizeBytes,
        human: item.sizeHuman,
        fileCount: 1,
        files: [item.path],
        candidateRoots: [item.path],
        maxRisk: item.risk,
        classifications: [item.classification],
        targetDirectory: item.targetDirectory,
        justification: item.justification
      })),
      candidates: candidates.slice(0, 160)
    }];
  }));
  const blockedFiles = nodes
    .filter((node) => node.deletionDecision === "nao_apagar")
    .sort((a, b) => b.size - a.size)
    .slice(0, 240)
    .map((node) => ({
      path: node.relativePath,
      sizeBytes: node.size,
      sizeHuman: formatBytes(node.size),
      classification: node.classification,
      risk: node.risk,
      deletionDecision: node.deletionDecision,
      daysSinceAccess: node.daysSinceAccess,
      spatialCategories: [],
      reason: node.protectedReasons[0] || "uso recente, sistema ou dependencia",
      blockingReasons: node.protectedReasons
    }));
  const targetPlan = buildNativeTargetPlan(spaceModes, targetFreeBytes);
  return {
    schemaVersion: 4,
    algorithm: "A.R.E",
    safeMode: true,
    generatedAt: new Date().toISOString(),
    rootPath,
    objective: "manter espaco livre localmente sem tocar sistema ou uso constante",
    question: "Quanto precisa liberar?",
    summary: {
      totalFiles: summary.files,
      analyzedFiles: summary.analyzedFiles,
      storedFiles: summary.storedFiles,
      totalBytes: summary.totalBytes,
      totalHuman: summary.totalHuman,
      analyzedBytes: summary.storedBytes,
      analyzedHuman: summary.storedHuman,
      inventoryProvider: "rust_local",
      inventoryTruncated: summary.inventoryTruncated,
      suggestions: nodes.length,
      keepInPlace: blockedFiles.length,
      moveCandidates: spaceModes.alto.fileCount,
      reviewCandidates: spaceModes.alto.fileCount,
      safeTrashCandidates: spaceModes.baixo.fileCount,
      blockedFiles: blockedFiles.length,
      blockedBytes: sumNodeBytes(nodes.filter((node) => node.deletionDecision === "nao_apagar")),
      blockedHuman: formatBytes(sumNodeBytes(nodes.filter((node) => node.deletionDecision === "nao_apagar"))),
      reallocatable: {
        baixo: spaceModes.baixo.reallocatableBytes,
        medio: spaceModes.medio.reallocatableBytes,
        alto: spaceModes.alto.reallocatableBytes
      },
      reallocatableHuman: {
        baixo: spaceModes.baixo.reallocatableHuman,
        medio: spaceModes.medio.reallocatableHuman,
        alto: spaceModes.alto.reallocatableHuman
      },
      targetFreeBytes,
      targetFreeHuman: formatBytes(targetFreeBytes),
      targetPlan,
      compactedLists: true,
      cycleBlocks: 0
    },
    relocationSimulation: buildNativeRelocationSimulation(spaceModes, summary.totalBytes, blockedFiles),
    depthRelocation: buildNativeDepthRelocation(nodes, spaceModes),
    spaceModes,
    candidatesByMode: {
      baixo: spaceModes.baixo.candidates,
      medio: spaceModes.medio.candidates,
      alto: spaceModes.alto.candidates
    },
    blockedFiles,
    safetyReport: {
      riskLevel: "medio",
      blockedBytes: sumNodeBytes(nodes.filter((node) => node.deletionDecision === "nao_apagar")),
      blockedHuman: formatBytes(sumNodeBytes(nodes.filter((node) => node.deletionDecision === "nao_apagar"))),
      bestCaseReallocatableBytes: spaceModes.alto.reallocatableBytes,
      bestCaseReallocatableHuman: spaceModes.alto.reallocatableHuman,
      text: targetPlan
        ? `Meta ${formatBytes(targetFreeBytes)}: ${targetPlan.statusText}`
        : `Modo alto pode realocar ${spaceModes.alto.reallocatableHuman}.`
    },
    proposedStructure: [],
    groups: {},
    operations: [],
    cycleBlocks: [],
    targetPlan
  };
}

function nativeModeCandidate(node, mode) {
  return {
    mode,
    path: node.relativePath,
    sizeBytes: node.size,
    sizeHuman: formatBytes(node.size),
    packageBytes: node.size,
    packageHuman: formatBytes(node.size),
    packagePaths: [node.relativePath],
    packageFileCount: 1,
    targetDirectory: node.deletionDecision === "pode_apagar" ? "/lixeira_segura" : "/revisar/baixo_uso",
    classification: node.classification,
    risk: node.risk,
    structuralRisk: node.risk,
    deletionDecision: node.deletionDecision,
    relocationDecision: node.relocationDecision,
    daysSinceAccess: node.daysSinceAccess,
    incoming: 0,
    outgoing: 0,
    dependencyImpact: node.impact.dependencies,
    userImpact: node.impact.user,
    systemImpact: node.impact.system,
    spatialCategories: [],
    justification: mode === "alto" ? "candidato local assistido para cumprir meta" : "candidato local de baixo uso",
    requiresConfirmation: true
  };
}

function buildNativeTargetPlan(spaceModes, targetFreeBytes) {
  if (!targetFreeBytes) {
    return null;
  }
  for (const mode of ["baixo", "medio", "alto"]) {
    const modeData = spaceModes[mode];
    if (modeData.reallocatableBytes < targetFreeBytes) {
      continue;
    }
    let total = 0;
    const selected = [];
    for (const item of modeData.candidates) {
      if (total >= targetFreeBytes) {
        break;
      }
      selected.push(item);
      total += item.packageBytes || item.sizeBytes || 0;
    }
    const enoughFromDetailedList = total >= targetFreeBytes;
    const plannedBytes = enoughFromDetailedList ? total : modeData.reallocatableBytes;
    return {
      targetBytes: targetFreeBytes,
      targetHuman: formatBytes(targetFreeBytes),
      selectedMode: mode,
      plannedBytes,
      plannedHuman: formatBytes(plannedBytes),
      selectedFiles: selected.length,
      candidates: selected,
      status: enoughFromDetailedList ? "atingivel" : "estimativa_exige_mais_detalhe",
      statusText: enoughFromDetailedList
        ? `usar nivel ${mode} libera aproximadamente ${formatBytes(total)} com ${selected.length} arquivo(s).`
        : `nivel ${mode} estima ${modeData.reallocatableHuman}; a lista detalhada foi compactada e o A.L.C deve confirmar os candidatos finais.`
    };
  }
  return {
    targetBytes: targetFreeBytes,
    targetHuman: formatBytes(targetFreeBytes),
    selectedMode: "insuficiente",
    plannedBytes: spaceModes.alto.reallocatableBytes,
    plannedHuman: spaceModes.alto.reallocatableHuman,
    selectedFiles: spaceModes.alto.candidates.length,
    candidates: spaceModes.alto.candidates,
    status: "insuficiente",
    statusText: `o inventario local encontrou ${spaceModes.alto.reallocatableHuman}; abaixo da meta.`
  };
}

function buildNativeRelocationSimulation(spaceModes, totalBytes, blockedFiles) {
  return Object.fromEntries(["baixo", "medio", "alto"].map((mode) => {
    const relocatedBytes = spaceModes[mode].reallocatableBytes;
    return [mode, {
      mode,
      beforeBytes: totalBytes,
      beforeHuman: formatBytes(totalBytes),
      relocatedBytes,
      relocatedHuman: formatBytes(relocatedBytes),
      remainingBytes: Math.max(0, totalBytes - relocatedBytes),
      remainingHuman: formatBytes(Math.max(0, totalBytes - relocatedBytes)),
      relocatedPercent: totalBytes > 0 ? Math.round((relocatedBytes / totalBytes) * 1000) / 10 : 0,
      packageCount: spaceModes[mode].packageCount,
      candidateFiles: spaceModes[mode].fileCount,
      blockedFiles: blockedFiles.length,
      simulatedMoves: [],
      explanation: `Simulacao local: ${formatBytes(relocatedBytes)} no modo ${mode}.`
    }];
  }));
}

function buildNativeDepthBreakdown(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const depth = node.scanDepth || 0;
    if (!groups.has(depth)) {
      groups.set(depth, { depth, files: 0, bytes: 0, human: "0 B", canDelete: 0, probablyUseless: 0, blocked: 0, risk: { baixo: 0, medio: 0, alto: 0, critico: 0 } });
    }
    const group = groups.get(depth);
    group.files += 1;
    group.bytes += node.size || 0;
    group.canDelete += node.deletionDecision === "pode_apagar" ? 1 : 0;
    group.probablyUseless += node.deletionDecision === "inutil_provavel" ? 1 : 0;
    group.blocked += node.deletionDecision === "nao_apagar" ? 1 : 0;
    group.risk[node.risk] = (group.risk[node.risk] || 0) + 1;
  }
  return Array.from(groups.values()).map((group) => ({ ...group, human: formatBytes(group.bytes) }));
}

function buildNativeDepthRelocation(nodes, spaceModes) {
  return buildNativeDepthBreakdown(nodes).map((item) => ({
    ...item,
    totalBytes: item.bytes,
    totalHuman: item.human,
    blockedBytes: 0,
    blockedHuman: "0 B",
    reallocatable: {
      baixo: spaceModes.baixo.reallocatableBytes,
      medio: spaceModes.medio.reallocatableBytes,
      alto: spaceModes.alto.reallocatableBytes
    },
    reallocatableHuman: {
      baixo: spaceModes.baixo.reallocatableHuman,
      medio: spaceModes.medio.reallocatableHuman,
      alto: spaceModes.alto.reallocatableHuman
    }
  }));
}

function buildNativeSimulation(nodes) {
  const groups = {
    pode_apagar: nodes.filter((node) => node.deletionDecision === "pode_apagar"),
    inutil_provavel: nodes.filter((node) => node.deletionDecision === "inutil_provavel"),
    averiguar: nodes.filter((node) => node.deletionDecision === "averiguar"),
    nao_apagar: nodes.filter((node) => node.deletionDecision === "nao_apagar")
  };
  return {
    buckets: {
      isolados: nodes,
      dicentes: [],
      docentes: [],
      mistos: [],
      protegidos: groups.nao_apagar,
      blocosInterdependentes: [],
      revisar: groups.averiguar
    },
    decisionGroups: Object.fromEntries(Object.entries(groups).map(([key, items]) => [
      key,
      items.map((node) => ({ id: node.id, path: node.relativePath, risk: node.risk, action: node.simulationAction }))
    ])),
    recommendation: {}
  };
}

function nativeDecision(value) {
  return {
    can_delete: "pode_apagar",
    probably_useless: "inutil_provavel",
    review: "averiguar",
    do_not_delete: "nao_apagar"
  }[value] || "averiguar";
}

function nativeUtility(value) {
  return {
    system: "sistema",
    protected: "protegido",
    used_by_user: "usado_pelo_usuario",
    dependency_relevant: "dependencia_relevante",
    low_use: "baixo_uso",
    probably_useless: "inutil_provavel",
    uncertain: "utilidade_incerta"
  }[value] || "utilidade_incerta";
}

function normalizeExtension(extension) {
  const value = String(extension || "").toLowerCase();
  return value && !value.startsWith(".") ? `.${value}` : value;
}

function countByField(items, field) {
  return items.reduce((accumulator, item) => {
    const key = item[field] || "desconhecido";
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
}

function sumNodeBytes(nodes) {
  return nodes.reduce((sum, node) => sum + (node.size || 0), 0);
}

function filesystemDepthClient(relativePath) {
  const normalized = String(relativePath || "").replace(/\\/g, "/");
  return normalized ? normalized.split("/").filter(Boolean).length - 1 : 0;
}

function nativeEmptyGraphViews() {
  const emptyView = { mode: "local", description: "grafo reconstruido no cliente", nodes: [], edges: [] };
  return { far: emptyView, medium: emptyView, close: emptyView };
}

function setStatus(text, mode) {
  elements.serverStatus.textContent = text;
  elements.serverStatus.dataset.mode = mode;
}

function startScanProgress() {
  if (!elements.scanProgress) {
    return;
  }

  state.scanProgressStartedAt = performance.now();
  state.scanProgressPercent = 4;
  elements.scanProgress.classList.remove("is-hidden");
  elements.scanProgress.dataset.mode = "busy";
  elements.progressLabel.textContent = "Escaneando arquivos e diretorios";
  elements.progressElapsed.textContent = "0.0s";
  elements.progressBar.style.width = "4%";

  if (state.scanProgressTimer) {
    window.clearInterval(state.scanProgressTimer);
    state.scanProgressTimer = null;
  }

  state.scanProgressTimer = window.setInterval(updateScanProgress, 180);
}

function updateScanProgress() {
  if (!elements.scanProgress || !state.scanProgressStartedAt) {
    return;
  }

  const elapsedMs = performance.now() - state.scanProgressStartedAt;
  const nextPercent = state.scanProgressPercent + Math.max(0.18, (94 - state.scanProgressPercent) * 0.018);
  state.scanProgressPercent = Math.min(94, nextPercent);
  elements.progressElapsed.textContent = formatElapsed(elapsedMs);
  elements.progressBar.style.width = `${state.scanProgressPercent.toFixed(1)}%`;
  elements.progressLabel.textContent = elapsedMs > 8000
    ? "Analisando dependencias, uso e riscos"
    : "Escaneando arquivos e diretorios";
}

function finishScanProgress(mode, result) {
  if (!elements.scanProgress) {
    return;
  }

  if (state.scanProgressTimer) {
    window.clearInterval(state.scanProgressTimer);
    state.scanProgressTimer = null;
  }

  const elapsedMs = state.scanProgressStartedAt ? performance.now() - state.scanProgressStartedAt : 0;
  elements.scanProgress.dataset.mode = mode;
  elements.progressElapsed.textContent = formatElapsed(elapsedMs);

  if (mode === "ok") {
    const summary = result?.summary || {};
    elements.progressBar.style.width = "100%";
    elements.progressLabel.textContent = `Concluido: ${formatNumber(summary.files || 0)} arquivos, ${formatNumber(summary.directories || 0)} diretorios`;
  } else {
    elements.progressLabel.textContent = "Varredura interrompida";
  }
}

function updateProgressiveScanProgress(progress, result) {
  if (!elements.scanProgress) {
    return;
  }

  const elapsedMs = state.scanProgressStartedAt ? performance.now() - state.scanProgressStartedAt : 0;
  const percent = clamp(Number(progress.percent || 0), 0, 100);
  const files = result?.summary?.files || 0;
  const edges = result?.summary?.edges || 0;
  const newNodes = Number(progress.newNodeCount || 0);
  const newHuman = progress.newHuman || "0 B";
  const depthText = `prof. ${progress.currentDepth || "?"}/${progress.maxDepth || "?"}`;
  elements.scanProgress.classList.remove("is-hidden");
  elements.scanProgress.dataset.mode = progress.isFinal ? "ok" : "busy";
  elements.progressElapsed.textContent = formatElapsed(elapsedMs);
  elements.progressBar.style.width = `${Math.max(4, percent)}%`;
  elements.progressLabel.textContent = `${depthText}: ${formatNumber(files)} arquivos, ${formatNumber(edges)} arestas, +${formatNumber(newNodes)} novos (${newHuman})`;
}

function formatElapsed(ms) {
  const seconds = Math.max(0, ms / 1000);
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}m ${remainingSeconds}s`;
}

function resetSystemLog() {
  if (!elements.systemLogList) {
    return;
  }
  elements.systemLogList.innerHTML = "";
}

function appendSystemLog(message) {
  if (!elements.systemLogList) {
    return;
  }

  const item = document.createElement("li");
  const time = new Date().toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  item.textContent = `${time} - ${message}`;
  elements.systemLogList.prepend(item);

  while (elements.systemLogList.children.length > 80) {
    elements.systemLogList.lastElementChild.remove();
  }
}

function renderAll() {
  syncDepthFilterOptions();
  renderMetrics();
  renderGraph();
  renderFiles();
  renderSimulation();
  renderRelocationPlan();
  renderContinuousState();
  renderCycles();
  renderTextReport();
  renderDepthTimeline();
  renderDependencies();
  renderWarnings();
  renderNodeDetails();
}

function scheduleGraphRender() {
  if (state.graphRenderFrame) {
    return;
  }
  state.graphRenderFrame = window.requestAnimationFrame(() => {
    state.graphRenderFrame = 0;
    renderGraph();
  });
}

function resetGraphCache() {
  state.graphViewCache = new Map();
  state.graphViewCacheResult = state.result;
}

function renderEmpty() {
  elements.metrics.innerHTML = metricMarkup([
    ["0", "entradas"],
    ["0", "arquivos"],
    ["0", "diretórios"],
    ["0", "arestas"],
    ["0", "alto risco"],
    ["0", "médio risco"],
    ["0", "baixo risco"],
    ["0", "candidatos"]
  ]);
  elements.metrics.innerHTML = metricMarkup([
    ["0 B", "espaco usado"],
    ["0 B", "A.R.E alto"],
    ["0", "arquivos"],
    ["0", "diretorios"],
    ["0", "pode apagar"],
    ["0", "inutil provavel"],
    ["0", "nao apagar"],
    ["0", "alto/critico"]
  ]);
  elements.filesTable.innerHTML = empty("Nenhuma varredura executada.");
  elements.dependenciesTable.innerHTML = empty("Nenhuma dependência detectada ainda.");
  elements.simulationGrid.innerHTML = "";
  if (elements.areSummary) elements.areSummary.innerHTML = empty("Execute uma varredura para calcular o A.R.E.");
  if (elements.areModalBody) elements.areModalBody.innerHTML = empty("Execute uma varredura para calcular o A.R.E.");
  if (elements.openAreModal) elements.openAreModal.disabled = true;
  if (elements.alcModalBody) elements.alcModalBody.innerHTML = empty("Execute uma varredura para preparar o A.L.C.");
  if (elements.openAlcModal) elements.openAlcModal.disabled = true;
  if (elements.continuousState) elements.continuousState.innerHTML = "";
  if (elements.cyclesList) elements.cyclesList.innerHTML = empty("Nenhum ciclo detectado.");
  if (elements.textReport) elements.textReport.textContent = "";
  if (elements.depthTimeline) elements.depthTimeline.innerHTML = empty("Nenhuma profundidade registrada.");
  if (elements.depthFilter) elements.depthFilter.innerHTML = `<option value="all">Todas</option>`;
  elements.warningsList.innerHTML = empty("Sem avisos.");
  updateZoomLabel();
}

function renderError(message) {
  elements.metrics.innerHTML = "";
  elements.filesTable.innerHTML = empty(message);
  elements.dependenciesTable.innerHTML = empty(message);
  elements.simulationGrid.innerHTML = "";
  if (elements.areSummary) elements.areSummary.innerHTML = empty(message);
  if (elements.areModalBody) elements.areModalBody.innerHTML = empty(message);
  if (elements.openAreModal) elements.openAreModal.disabled = true;
  if (elements.alcModalBody) elements.alcModalBody.innerHTML = empty(message);
  if (elements.openAlcModal) elements.openAlcModal.disabled = true;
  if (elements.continuousState) elements.continuousState.innerHTML = "";
  if (elements.cyclesList) elements.cyclesList.innerHTML = empty(message);
  if (elements.textReport) elements.textReport.textContent = message;
  if (elements.depthTimeline) elements.depthTimeline.innerHTML = empty(message);
  elements.warningsList.innerHTML = empty(message);
  clearCanvas(message);
}

function renderMetrics() {
  if (!state.result) {
    return;
  }
  const summary = state.result.summary;
  const scale = state.result.scaleEstimate?.scale || "n/d";
  elements.metrics.innerHTML = metricMarkup([
    [summary.entries, "entradas lidas"],
    [summary.cycles || 0, "ciclos"],
    [summary.files, "arquivos"],
    [summary.directories, "diretórios"],
    [summary.canDelete || 0, "pode apagar"],
    [summary.probablyUseless || 0, "inútil provável"],
    [summary.mustKeep || 0, "não apagar"],
    [summary.byRisk.critico || 0, "critico"],
    [summary.byRisk.alto || 0, "alto risco"],
    [summary.staleCandidates || summary.candidateLowRisk, `candidatos - ${scale}`]
  ]);
  const highReclaimable = state.result.relocationPlan?.spaceModes?.alto?.reallocatableHuman
    || state.result.relocationPlan?.summary?.reallocatableHuman?.alto
    || "0 B";
  elements.metrics.innerHTML = metricMarkup([
    [summary.totalHuman || formatBytes(summary.totalBytes || 0), "espaco usado"],
    [highReclaimable, `A.R.E alto - ${scale}`],
    [summary.files, "arquivos"],
    [summary.directories, "diretorios"],
    [summary.canDelete || 0, "pode apagar"],
    [summary.probablyUseless || 0, "inutil provavel"],
    [summary.mustKeep || 0, "nao apagar"],
    [(summary.byRisk?.critico || 0) + (summary.byRisk?.alto || 0), "alto/critico"]
  ]);
}

function syncDepthFilterOptions() {
  if (!elements.depthFilter || !state.result?.summary?.depthBreakdown) {
    return;
  }

  const current = elements.depthFilter.value || "all";
  const depths = state.result.summary.depthBreakdown.map((item) => String(item.depth));
  elements.depthFilter.innerHTML = [
    `<option value="all">Todas</option>`,
    ...depths.map((depth) => `<option value="${escapeHtml(depth)}">Prof. ${escapeHtml(depth)}</option>`)
  ].join("");
  elements.depthFilter.value = depths.includes(current) ? current : "all";
}

function metricMarkup(items) {
  return items.map(([value, label]) => `
    <div class="metric">
      <strong>${formatNumber(value)}</strong>
      <span>${escapeHtml(label)}</span>
    </div>
  `).join("");
}

function fileMapButton(path, label = path) {
  if (!path) {
    return "-";
  }
  return `<button class="file-map-link" type="button" data-file-map="${escapeHtml(path)}">${escapeHtml(label || path)}</button>`;
}

function renderGraph() {
  if (!state.result) {
    clearCanvas("Execute uma varredura para renderizar o grafo.");
    return;
  }

  const canvas = elements.graphCanvas;
  const context = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(320, Math.floor(rect.width * ratio));
  canvas.height = Math.max(300, Math.floor(rect.height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);

  const width = rect.width;
  const height = rect.height;
  context.clearRect(0, 0, width, height);

  const mode = resolveGraphMode();
  state.graphMode = mode.key;
  const view = getInteractiveGraphView(mode);
  const visibleNodes = selectGraphNodes(view.nodes, mode);
  const visibleIds = new Set(visibleNodes.map((node) => node.id));
  const edges = selectGraphEdges(view.edges, visibleIds, mode);
  state.currentGraphNodes = visibleNodes;
  state.currentGraphEdges = edges;

  const capped = visibleNodes.length < view.nodes.length ? "mais relevantes" : "todos";
  elements.graphHint.textContent = `${mode.label} - ${visibleNodes.length}/${view.nodes.length} nos (${capped}) - ${focusText()}`;
  updateZoomLabel(mode);

  if (!visibleNodes.length) {
    clearCanvas("Nenhum nó dentro do filtro atual.");
    return;
  }

  const world = graphWorldSize(width, height, visibleNodes.length, mode);
  const layout = computeImpactLayout(visibleNodes, world.width, world.height, mode);
  state.graphTransform = graphTransformFor(width, height, world.width, world.height);
  state.graphLayout = layout;

  context.save();
  context.translate(state.graphTransform.offsetX, state.graphTransform.offsetY);
  context.scale(state.graphTransform.scale, state.graphTransform.scale);
  drawGraphBackdrop(context, world.width, world.height);
  drawDecisionZones(context, world.width, world.height, mode);
  drawEdges(context, edges, layout);
  drawNodes(context, layout, mode);
  context.restore();
}

function resolveGraphMode() {
  return graphModes[state.graphMode] || graphModes.medium;
}

function updateZoomLabel(mode = resolveGraphMode()) {
  if (!elements.zoomLabel) {
    return;
  }
  const pan = state.graphPan || { x: 0, y: 0 };
  elements.zoomLabel.textContent = `${mode.label} - ${Math.round(state.zoom * 100)}% - x:${Math.round(pan.x)} y:${Math.round(pan.y)}`;
  elements.modeFar?.classList.toggle("is-active", mode.key === "far");
  elements.modeMedium?.classList.toggle("is-active", mode.key === "medium");
  elements.modeClose?.classList.toggle("is-active", mode.key === "close");
}

function graphScale() {
  return clamp(state.zoom, 0.42, 3.6);
}

function zoomGraphWithWheel(event) {
  if (!state.result) {
    return;
  }
  event.preventDefault();

  const rect = elements.graphCanvas.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;
  const previousTransform = state.graphTransform;
  const worldPoint = previousTransform
    ? screenToWorld(screenX, screenY, previousTransform)
    : { x: rect.width / 2, y: rect.height / 2 };

  const factor = event.deltaY < 0 ? 1.12 : 0.89;
  state.zoom = clamp(state.zoom * factor, 0.42, 3.6);

  if (previousTransform) {
    const scale = graphScale();
    const baseX = (rect.width - previousTransform.worldWidth * scale) / 2;
    const baseY = (rect.height - previousTransform.worldHeight * scale) / 2;
    state.graphPan = {
      x: screenX - worldPoint.x * scale - baseX,
      y: screenY - worldPoint.y * scale - baseY
    };
  }

  scheduleGraphRender();
}

function graphWorldSize(width, height, nodeCount, mode) {
  const densityFactor = clamp(Math.sqrt(Math.max(1, nodeCount) / 160), 1, mode.key === "close" ? 4.2 : mode.key === "medium" ? 2.8 : 1.8);
  return {
    width: Math.max(width, width * densityFactor),
    height: Math.max(height, height * densityFactor)
  };
}

function graphTransformFor(width, height, worldWidth, worldHeight) {
  const scale = graphScale();
  const baseX = (width - worldWidth * scale) / 2;
  const baseY = (height - worldHeight * scale) / 2;
  return {
    scale,
    worldWidth,
    worldHeight,
    offsetX: baseX + (state.graphPan?.x || 0),
    offsetY: baseY + (state.graphPan?.y || 0)
  };
}

function baseGraphOffset(transform) {
  return {
    x: -((transform.worldWidth * graphScale()) - elements.graphCanvas.getBoundingClientRect().width) / 2,
    y: -((transform.worldHeight * graphScale()) - elements.graphCanvas.getBoundingClientRect().height) / 2
  };
}

function screenToWorld(screenX, screenY, transform = state.graphTransform) {
  if (!transform) {
    return { x: screenX, y: screenY };
  }
  return {
    x: (screenX - transform.offsetX) / transform.scale,
    y: (screenY - transform.offsetY) / transform.scale
  };
}

function getInteractiveGraphView(mode) {
  if (state.graphViewCacheResult !== state.result) {
    resetGraphCache();
  }

  const expandedKey = Array.from(state.expandedGroups).sort().join(",");
  const cacheKey = `${mode.key}:${expandedKey}`;
  if (state.graphViewCache.has(cacheKey)) {
    return state.graphViewCache.get(cacheKey);
  }

  const nativeView = state.result.graphViews?.[mode.view];
  const hasNativeView = (nativeView?.nodes || []).length > 0;
  const baseView = hasNativeView ? nativeView : emptyGraphView();
  const view = buildInteractiveGraphView(baseView, mode);
  state.graphViewCache.set(cacheKey, view);
  return view;
}

function emptyGraphView() {
  return {
    nodes: [],
    edges: state.result?.edges || []
  };
}

function fallbackGraphView() {
  return {
    nodes: state.result.nodes.filter((node) => node.kind === "file").map((node) => ({
      ...node,
      label: node.name || node.relativePath,
      fileCount: 1,
      directoryCount: 0,
      children: [node.id]
    })),
    edges: state.result.edges
  };
}

function buildInteractiveGraphView(baseView, mode) {
  if (!state.result) {
    return baseView;
  }
  if (mode.key === "far" && (baseView.nodes || []).length) {
    return baseView;
  }

  const files = state.result.nodes.filter((node) => node.kind === "file");
  const groups = new Map();
  for (const file of files) {
    const key = groupKeyForFile(file, mode);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(file);
  }

  const nodes = [];
  const fileToVisibleNode = new Map();

  for (const [key, groupFiles] of groups.entries()) {
    const groupId = `group:${mode.key}:${key}`;
    const shouldGroup = groupFiles.length > 1 || mode.key === "medium";
    const expanded = state.expandedGroups.has(groupId);

    if (!shouldGroup) {
      const file = groupFiles[0];
      nodes.push(fileToGraphNode(file, "file"));
      fileToVisibleNode.set(file.id, file.id);
      continue;
    }

    const groupNode = buildUiGroupNode(groupId, key, groupFiles, mode, expanded);
    nodes.push(groupNode);

    if (expanded) {
      for (const file of groupFiles) {
        const child = fileToGraphNode(file, "expanded_file");
        child.parentGroupId = groupId;
        child.label = file.name;
        nodes.push(child);
        fileToVisibleNode.set(file.id, file.id);
      }
    } else {
      for (const file of groupFiles) {
        fileToVisibleNode.set(file.id, groupId);
      }
    }
  }

  return {
    ...baseView,
    nodes,
    edges: aggregateVisibleEdges(state.result.edges, fileToVisibleNode)
  };
}

function groupKeyForFile(file, mode) {
  const dir = topDirectoryFromPath(file.relativePath);
  const decision = file.deletionDecision || "averiguar";
  if (mode.key === "far") {
    return `${decision}|${dir}`;
  }
  if (mode.key === "close") {
    return `${decision}|${dir}|${file.extension || "sem_ext"}`;
  }
  return `${decision}|${dir}`;
}

function buildUiGroupNode(groupId, key, files, mode, expanded) {
  const [decision, dir, extension] = key.split("|");
  const labelParts = mode.key === "close"
    ? [decisionLabel(decision), dir, extension || "sem ext"]
    : [decisionLabel(decision), dir];
  const incoming = files.reduce((sum, file) => sum + (file.incoming || 0), 0);
  const outgoing = files.reduce((sum, file) => sum + (file.outgoing || 0), 0);
  const impactCount = files.reduce((sum, file) => sum + (file.impactCount || 0), 0);
  const size = files.reduce((sum, file) => sum + (file.size || 0), 0);
  const dominantFile = files
    .slice()
    .sort((a, b) => dependencyScore(b) - dependencyScore(a) || String(a.name).localeCompare(String(b.name)))[0];

  return {
    id: groupId,
    kind: "ui_group",
    label: `${labelParts.filter(Boolean).join(" - ")} (${files.length})`,
    name: labelParts.filter(Boolean).join(" - "),
    relativePath: dir,
    extension: extension || "",
    risk: maxRiskClient(files),
    classification: "grupo",
    fileCount: files.length,
    directoryCount: new Set(files.map((file) => topDirectoryFromPath(file.relativePath))).size,
    scanDepth: Math.max(0, ...files.map((file) => Number(file.scanDepth ?? 0))),
    scanDepths: Array.from(new Set(files.map((file) => Number(file.scanDepth ?? 0)))).sort((a, b) => a - b),
    incoming,
    outgoing,
    impactCount,
    dependencyScore: files.reduce((sum, file) => sum + dependencyScore(file), 0),
    dominantFileName: dominantFile?.name || dominantFile?.relativePath || "",
    depth: Math.max(0, ...files.map((file) => file.depth || 0)),
    size,
    daysSinceAccess: Math.min(...files.map((file) => Number(file.daysSinceAccess ?? 9999))),
    deletionDecision: aggregateDeletionDecisionClient(files),
    utilityStatus: aggregateUtilityStatusClient(files),
    action: expanded ? "grupo_expandido" : "clique_para_expandir",
    children: files.map((file) => file.id),
    searchText: files.map((file) => file.relativePath).join(" "),
    expanded,
    groupReason: expanded ? "grupo aberto" : "grupo expansível"
  };
}

function fileToGraphNode(file, kind) {
  return {
    ...file,
    kind,
    label: file.name || file.relativePath,
    dependencyScore: dependencyScore(file),
    dominantFileName: file.name || file.relativePath,
    fileCount: 1,
    directoryCount: 0,
    children: [file.id],
    action: file.simulationAction
  };
}

function aggregateVisibleEdges(edges, fileToVisibleNode) {
  const aggregate = new Map();
  for (const edge of edges) {
    const source = fileToVisibleNode.get(edge.source);
    const target = fileToVisibleNode.get(edge.target);
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
      item.samples.push(edge);
    }
  }
  return Array.from(aggregate.values());
}

function selectGraphNodes(nodes, mode) {
  const filter = elements.graphFilter.value;
  const depthFilter = elements.depthFilter?.value || "all";
  const query = elements.fileSearch.value.trim().toLowerCase();
  return nodes
    .filter((node) => filter === "all" || node.risk === filter)
    .filter((node) => depthFilter === "all" || nodeMatchesDepth(node, depthFilter))
    .filter((node) => {
      if (!query) {
        return true;
      }
      const haystack = [
        node.label,
        node.name,
        node.relativePath,
        node.searchText,
        ...(node.children || [])
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    })
    .sort((a, b) => {
      const scoreA = riskWeight[a.risk] * 1000 + (a.incoming + a.outgoing) * 12 + (a.fileCount || 1) + a.depth * 4;
      const scoreB = riskWeight[b.risk] * 1000 + (b.incoming + b.outgoing) * 12 + (b.fileCount || 1) + b.depth * 4;
      return scoreB - scoreA || String(a.label).localeCompare(String(b.label));
    })
    .slice(0, mode.limit);
}

function selectGraphEdges(edges, visibleIds, mode) {
  if (!mode.edgeLimit) {
    return [];
  }
  const focusId = state.hoveredNodeId || state.selectedNodeId;
  const visibleEdges = edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  if (focusId) {
    const focused = visibleEdges
      .filter((edge) => edge.source === focusId || edge.target === focusId)
      .sort((a, b) => (b.weight || 1) - (a.weight || 1))
      .slice(0, Math.min(mode.edgeLimit, 160));
    const seen = new Set(focused.map((edge) => edge.id || `${edge.source}->${edge.target}`));
    const context = visibleEdges
      .filter((edge) => !seen.has(edge.id || `${edge.source}->${edge.target}`))
      .sort((a, b) => (b.weight || 1) - (a.weight || 1))
      .slice(0, Math.max(0, mode.edgeLimit - focused.length));
    return [...focused, ...context];
  }
  return visibleEdges
    .sort((a, b) => (b.weight || 1) - (a.weight || 1))
    .slice(0, mode.edgeLimit);
}

function nodeMatchesDepth(node, depthFilter) {
  const depth = Number(depthFilter);
  if (!Number.isFinite(depth)) {
    return true;
  }
  if (Array.isArray(node.scanDepths)) {
    return node.scanDepths.includes(depth);
  }
  return Number(node.scanDepth ?? 0) === depth;
}

function focusText() {
  const focused = state.hoveredNodeId || state.selectedNodeId;
  if (!focused) {
    return "visão limpa";
  }
  const node = state.currentGraphNodes.find((item) => item.id === focused);
  return node ? `foco: ${trimLabel(node.label || node.relativePath, 28)}` : "foco ativo";
}

function computeImpactLayout(nodes, width, height, mode) {
  const layout = new Map();
  const zones = decisionZones(width, height);
  const grouped = new Map();

  for (const node of nodes) {
    const key = zoneKeyFor(node);
    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(node);
  }

  for (const [key, groupNodes] of grouped.entries()) {
    const zone = zones[key] || zones.averiguar;
    groupNodes.sort((a, b) => {
      const scoreA = (a.fileCount || 1) + (a.impactCount || 0) * 2 + (a.incoming || 0) * 3;
      const scoreB = (b.fileCount || 1) + (b.impactCount || 0) * 2 + (b.incoming || 0) * 3;
      return scoreB - scoreA || String(a.label).localeCompare(String(b.label));
    });

    groupNodes.forEach((node, index) => {
      const spiral = Math.sqrt(index + 1) / Math.sqrt(groupNodes.length + 1);
      const angle = index * 2.399963 + hashNumber(node.id) * 0.0008;
      const jitter = mode.key === "close" ? 1.05 : mode.key === "far" ? 0.72 : 0.88;
      const x = zone.x + Math.cos(angle) * zone.rx * spiral * jitter;
      const y = zone.y + Math.sin(angle) * zone.ry * spiral * jitter;
      const degree = (node.incoming || 0) + (node.outgoing || 0) + (node.impactCount || 0);
      const mass = Math.max(1, node.fileCount || 1);
      const radius = clamp((5 + Math.sqrt(degree + mass) * 2.4) * mode.nodeScale, mode.key === "close" ? 4 : 8, mode.key === "far" ? 36 : 24);

      layout.set(node.id, {
        x: clamp(x, radius + 16, width - radius - 16),
        y: clamp(y, radius + 16, height - radius - 16),
        radius,
        node,
        zoneKey: key
      });
    });
  }

  return layout;
}

function decisionZones(width, height) {
  return {
    pode_apagar: { x: width * 0.22, y: height * 0.7, rx: width * 0.16, ry: height * 0.18, label: "pode apagar", color: "#2f8f57" },
    inutil_provavel: { x: width * 0.26, y: height * 0.32, rx: width * 0.16, ry: height * 0.18, label: "inútil provável", color: "#84a94f" },
    averiguar: { x: width * 0.56, y: height * 0.48, rx: width * 0.19, ry: height * 0.24, label: "averiguar", color: "#d7a02c" },
    nao_apagar: { x: width * 0.82, y: height * 0.48, rx: width * 0.15, ry: height * 0.28, label: "não apagar", color: "#c84444" }
  };
}

function zoneKeyFor(node) {
  return node.deletionDecision || node.relocationDecision || "averiguar";
}

function drawGraphBackdrop(context, width, height) {
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#f7faf8");
  gradient.addColorStop(0.5, "#ffffff");
  gradient.addColorStop(1, "#f3f6f7");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  context.save();
  context.globalAlpha = 0.45;
  context.strokeStyle = "rgba(35, 43, 47, 0.06)";
  context.lineWidth = 1;
  const step = 42;
  for (let x = 0; x < width; x += step) {
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, height);
    context.stroke();
  }
  for (let y = 0; y < height; y += step) {
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(width, y);
    context.stroke();
  }
  context.restore();
}

function drawDecisionZones(context, width, height) {
  const zones = decisionZones(width, height);
  context.save();
  context.textAlign = "center";
  context.textBaseline = "middle";
  for (const zone of Object.values(zones)) {
    const gradient = context.createRadialGradient(zone.x, zone.y, 6, zone.x, zone.y, Math.max(zone.rx, zone.ry));
    gradient.addColorStop(0, hexToRgba(zone.color, 0.13));
    gradient.addColorStop(1, hexToRgba(zone.color, 0));
    context.fillStyle = gradient;
    context.beginPath();
    context.ellipse(zone.x, zone.y, zone.rx, zone.ry, 0, 0, Math.PI * 2);
    context.fill();

    context.fillStyle = hexToRgba(zone.color, 0.7);
    context.font = "800 12px Segoe UI, sans-serif";
    context.fillText(zone.label, zone.x, zone.y - zone.ry - 12);
  }
  context.restore();
}

function drawEdges(context, edges, layout) {
  const focusId = state.hoveredNodeId || state.selectedNodeId;
  context.save();
  for (const edge of edges) {
    const source = layout.get(edge.source);
    const target = layout.get(edge.target);
    if (!source || !target) {
      continue;
    }
    const focused = focusId && (edge.source === focusId || edge.target === focusId);
    const important = !focusId && Math.max(edge.weight || 1, source.node.impactCount || 0, target.node.impactCount || 0) >= 3;
    if (!focused && !important) {
      continue;
    }

    const weight = Math.max(1, edge.weight || 1);
    context.beginPath();
    context.strokeStyle = edgeColor(source.node.risk, target.node.risk, weight, focused);
    context.lineWidth = focused ? clamp(1.4 + Math.sqrt(weight), 1.6, 5) : clamp(0.8 + Math.sqrt(weight) * 0.35, 0.8, 2.4);
    context.moveTo(source.x, source.y);
    context.lineTo(target.x, target.y);
    context.stroke();
    if (focused) {
      drawArrowHead(context, source, target);
    }
  }
  context.restore();
}

function drawArrowHead(context, source, target) {
  const angle = Math.atan2(target.y - source.y, target.x - source.x);
  const size = 6;
  const x = target.x - Math.cos(angle) * (target.radius + 2);
  const y = target.y - Math.sin(angle) * (target.radius + 2);
  context.beginPath();
  context.moveTo(x, y);
  context.lineTo(x - Math.cos(angle - 0.45) * size, y - Math.sin(angle - 0.45) * size);
  context.lineTo(x - Math.cos(angle + 0.45) * size, y - Math.sin(angle + 0.45) * size);
  context.closePath();
  context.fillStyle = context.strokeStyle;
  context.fill();
}

function drawNodes(context, layout, mode) {
  const focusId = state.hoveredNodeId || state.selectedNodeId;
  const topLabelIds = topDependencyLabelIds(layout, mode);
  context.save();
  for (const point of layout.values()) {
    const node = point.node;
    const focused = node.id === focusId;
    const selected = node.id === state.selectedNodeId;
    const dim = focusId && !focused && !isConnectedToFocus(node.id);

    context.globalAlpha = dim ? 0.28 : 1;
    context.beginPath();
    context.fillStyle = riskColors[node.risk] || "#81878b";
    context.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = selected ? 4 : focused ? 3 : 1.4;
    context.strokeStyle = selected || focused ? "#182025" : "rgba(255, 255, 255, 0.92)";
    context.stroke();

    if ((node.fileCount > 1 || node.kind === "ui_group") && (mode.key !== "close" || focused || node.kind === "ui_group")) {
      context.fillStyle = "#ffffff";
      context.font = "800 11px Segoe UI, sans-serif";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(node.expanded ? "−" : formatCompact(node.fileCount), point.x, point.y);
    }
  }
  context.globalAlpha = 1;

  for (const point of layout.values()) {
    const node = point.node;
    const focused = node.id === focusId;
    const showLabel = focused || node.id === state.selectedNodeId || topLabelIds.has(node.id);
    if (showLabel) {
      drawNodeLabel(context, point, mode, { compact: topLabelIds.has(node.id) && !focused });
    }
  }
  context.restore();
}

function drawNodeLabel(context, point, mode, options = {}) {
  const labelSource = options.compact
    ? point.node.dominantFileName || point.node.label || point.node.relativePath
    : point.node.label || point.node.dominantFileName || point.node.relativePath;
  const label = trimLabel(labelSource || "nó", mode.key === "close" ? 30 : 24);
  context.font = mode.key === "close" ? "12px Cascadia Mono, Consolas, monospace" : "800 12px Segoe UI, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "top";
  const labelWidth = Math.min(210, context.measureText(label).width + 14);
  const labelHeight = 20;
  const x = point.x - labelWidth / 2;
  const y = point.y + point.radius + 7;
  context.fillStyle = "rgba(255, 255, 255, 0.94)";
  roundRect(context, x, y, labelWidth, labelHeight, 6);
  context.fill();
  context.strokeStyle = "rgba(28, 34, 38, 0.12)";
  context.stroke();
  context.fillStyle = "#1c2226";
  context.fillText(label, point.x, y + 3);
}

function importantNode(node) {
  return node.risk === "critico" || node.risk === "alto" || node.deletionDecision === "pode_apagar" || (node.impactCount || 0) >= 4;
}

function topDependencyLabelIds(layout, mode) {
  const maxLabels = mode.key === "far" ? 3 : mode.key === "medium" ? 5 : 8;
  return new Set(
    Array.from(layout.values())
      .filter((point) => dependencyScore(point.node) > 0)
      .sort((a, b) => dependencyScore(b.node) - dependencyScore(a.node))
      .slice(0, maxLabels)
      .map((point) => point.node.id)
  );
}

function dependencyScore(node) {
  return Number(node.dependencyScore ?? ((node.incoming || 0) * 3 + (node.outgoing || 0) * 2 + (node.impactCount || 0) * 4));
}

function topDirectoryFromPath(relativePath) {
  const normalized = String(relativePath || ".").replace(/\\/g, "/");
  if (!normalized || normalized === "." || !normalized.includes("/")) {
    return ".";
  }
  return normalized.split("/")[0];
}

function maxRiskClient(files) {
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

function aggregateDeletionDecisionClient(files) {
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

function aggregateUtilityStatusClient(files) {
  const statuses = new Set(files.map((file) => file.utilityStatus));
  if (statuses.has("sistema")) return "sistema";
  if (statuses.has("protegido")) return "protegido";
  if (statuses.has("dependencia_relevante")) return "dependencia_relevante";
  if (statuses.has("usado_pelo_usuario")) return "usado_pelo_usuario";
  if (statuses.has("utilidade_incerta")) return "utilidade_incerta";
  if (statuses.has("baixo_uso")) return "baixo_uso";
  return "inutil_provavel";
}

function isConnectedToFocus(nodeId) {
  const focusId = state.hoveredNodeId || state.selectedNodeId;
  if (!focusId || nodeId === focusId) {
    return true;
  }
  return state.currentGraphEdges.some((edge) => {
    return (edge.source === focusId && edge.target === nodeId) || (edge.target === focusId && edge.source === nodeId);
  });
}

function edgeColor(sourceRisk, targetRisk, weight, focused = false) {
  const risk = riskWeight[sourceRisk] >= riskWeight[targetRisk] ? sourceRisk : targetRisk;
  const color = riskColors[risk] || "#60676c";
  const alpha = focused ? 0.66 : clamp(0.12 + weight * 0.04, 0.14, 0.32);
  return hexToRgba(color, alpha);
}

function clearCanvas(message) {
  const canvas = elements.graphCanvas;
  const context = canvas.getContext("2d");
  const rect = canvas.getBoundingClientRect();
  context.clearRect(0, 0, canvas.width, canvas.height);
  drawGraphBackdrop(context, rect.width || canvas.width, rect.height || canvas.height);
  context.fillStyle = "#626a70";
  context.font = "14px Segoe UI, sans-serif";
  context.fillText(message, 18, 32);
  elements.graphHint.textContent = message;
  state.graphLayout = new Map();
  state.currentGraphNodes = [];
  state.currentGraphEdges = [];
  state.graphTransform = null;
}

function hoverCanvasNode(event) {
  if (!state.graphLayout.size) {
    return;
  }
  if (state.isPanningGraph) {
    const current = { x: event.clientX, y: event.clientY };
    const previous = state.lastPanPoint || current;
    state.graphPan = {
      x: (state.graphPan?.x || 0) + current.x - previous.x,
      y: (state.graphPan?.y || 0) + current.y - previous.y
    };
    state.lastPanPoint = current;
    scheduleGraphRender();
    return;
  }
  const point = nearestCanvasPoint(event);
  const nextHoverId = point ? point.node.id : null;
  elements.graphCanvas.style.cursor = point ? "pointer" : "grab";
  if (state.hoveredNodeId !== nextHoverId) {
    state.hoveredNodeId = nextHoverId;
    scheduleGraphRender();
  }
}

function selectCanvasNode(event) {
  if (event.button === 2 || state.isPanningGraph) {
    return;
  }
  if (!state.graphLayout.size) {
    return;
  }
  const nearest = nearestCanvasPoint(event);
  if (nearest) {
    state.selectedNodeId = nearest.node.id;
    if (nearest.node.kind === "ui_group") {
      if (state.expandedGroups.has(nearest.node.id)) {
        state.expandedGroups.delete(nearest.node.id);
      } else {
        state.expandedGroups.add(nearest.node.id);
      }
      resetGraphCache();
    }
    renderNodeDetails();
    renderGraph();
  } else if (state.selectedNodeId) {
    state.selectedNodeId = null;
    renderNodeDetails();
    renderGraph();
  }
}

function nearestCanvasPoint(event) {
  const rect = elements.graphCanvas.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;
  const world = screenToWorld(screenX, screenY);
  const x = world.x;
  const y = world.y;
  let nearest = null;
  let nearestDistance = Infinity;

  for (const point of state.graphLayout.values()) {
    const distance = Math.hypot(point.x - x, point.y - y);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearest = point;
    }
  }

  const hitSlack = 12 / Math.max(0.4, state.graphTransform?.scale || 1);
  return nearest && nearestDistance <= nearest.radius + hitSlack ? nearest : null;
}

function startGraphPan(event) {
  if (event.button !== 2) {
    return;
  }
  event.preventDefault();
  state.isPanningGraph = true;
  state.lastPanPoint = { x: event.clientX, y: event.clientY };
  elements.graphCanvas.style.cursor = "grabbing";
}

function stopGraphPan() {
  if (!state.isPanningGraph) {
    return;
  }
  state.isPanningGraph = false;
  state.lastPanPoint = null;
  elements.graphCanvas.style.cursor = "grab";
}

function clearNodeSelectionOnOutsideClick(event) {
  const fileMapTrigger = event.target.closest?.("[data-file-map]");
  const clickedDependencyPopover = event.target.closest?.("#fileDependencyPopover");
  if (fileMapTrigger) {
    showFileDependencyPopover(fileMapTrigger.dataset.fileMap, event);
    return;
  }
  if (!clickedDependencyPopover) {
    hideFileDependencyPopover();
  }

  if (!state.selectedNodeId) {
    return;
  }
  const clickedCanvas = event.target === elements.graphCanvas;
  const clickedInspector = elements.nodeDetails?.contains(event.target);
  const clickedTableNode = Boolean(event.target.closest?.("[data-node-id]"));
  if (clickedCanvas || clickedInspector || clickedTableNode) {
    return;
  }
  state.selectedNodeId = null;
  renderNodeDetails();
  renderGraph();
}

function showFileDependencyPopover(path, event) {
  const popover = elements.fileDependencyPopover;
  if (!popover || !path) {
    return;
  }

  const node = findFileNodeByPath(path);
  const dependencyMap = buildFileDependencyMap(path, node);
  popover.innerHTML = renderFileDependencyPopover(path, node, dependencyMap);
  popover.classList.remove("is-hidden");

  const width = Math.min(440, window.innerWidth - 24);
  const estimatedHeight = Math.min(520, window.innerHeight - 24);
  let left = event.clientX + 14;
  let top = event.clientY + 14;
  if (left + width > window.innerWidth - 12) {
    left = Math.max(12, event.clientX - width - 14);
  }
  if (top + estimatedHeight > window.innerHeight - 12) {
    top = Math.max(12, window.innerHeight - estimatedHeight - 12);
  }
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function hideFileDependencyPopover() {
  elements.fileDependencyPopover?.classList.add("is-hidden");
}

function renderFileDependencyPopover(path, node, dependencyMap) {
  const incoming = dependencyMap.incoming.slice(0, 8);
  const outgoing = dependencyMap.outgoing.slice(0, 8);
  const related = [...incoming, ...outgoing].slice(0, 10);
  return `
    <header class="file-map-header">
      <div>
        <span>Mapa de dependencias</span>
        <strong>${escapeHtml(node?.name || path.split(/[\\/]/).pop() || path)}</strong>
      </div>
      <small>${node ? formatBytes(node.size || 0) : "arquivo citado"}</small>
    </header>
    <dl class="file-map-facts">
      <dt>caminho</dt><dd>${fileMapButton(path)}</dd>
      <dt>risco</dt><dd>${node ? riskMarkup(node.risk) : "-"}</dd>
      <dt>decisao</dt><dd>${node ? escapeHtml(decisionLabel(node.deletionDecision)) : "-"}</dd>
      <dt>utilidade</dt><dd>${node ? escapeHtml(utilityLabel(node.utilityStatus)) : "-"}</dd>
    </dl>
    <div class="dependency-mini-map" aria-label="Mapa compacto de dependencias">
      <div class="dependency-side">
        <span>Entrada</span>
        <b>${formatNumber(dependencyMap.incoming.length)}</b>
      </div>
      <div class="dependency-center">
        <span>${escapeHtml(trimLabel(node?.name || path, 34))}</span>
      </div>
      <div class="dependency-side">
        <span>Saida</span>
        <b>${formatNumber(dependencyMap.outgoing.length)}</b>
      </div>
    </div>
    <div class="file-map-columns">
      <section>
        <h3>Depende dele</h3>
        ${incoming.length ? `<ol>${incoming.map((item) => `<li>${fileMapButton(item.path)}<small>${escapeHtml(item.type || "dep")}</small></li>`).join("")}</ol>` : `<p class="muted">Nenhuma entrada registrada.</p>`}
      </section>
      <section>
        <h3>Ele depende de</h3>
        ${outgoing.length ? `<ol>${outgoing.map((item) => `<li>${fileMapButton(item.path)}<small>${escapeHtml(item.type || "dep")}</small></li>`).join("")}</ol>` : `<p class="muted">Nenhuma saida registrada.</p>`}
      </section>
    </div>
    ${related.length ? "" : `<p class="muted">Sem arestas no inventario atual; para arquivos do modo Rust local, o A.D.D pode ter apenas metadados.</p>`}
  `;
}

function buildFileDependencyMap(path, node) {
  const normalizedPath = normalizePathKey(path);
  const nodeId = node?.id;
  const incoming = [];
  const outgoing = [];
  for (const edge of state.result?.edges || []) {
    const sourcePath = edge.sourcePath || nodePathFromId(edge.source);
    const targetPath = edge.targetPath || nodePathFromId(edge.target);
    const sourceMatches = edge.source === nodeId || normalizePathKey(sourcePath) === normalizedPath;
    const targetMatches = edge.target === nodeId || normalizePathKey(targetPath) === normalizedPath;
    if (targetMatches && sourcePath) {
      incoming.push({ path: sourcePath, type: edge.type });
    }
    if (sourceMatches && targetPath) {
      outgoing.push({ path: targetPath, type: edge.type });
    }
  }
  return {
    incoming: uniqueFileMapItems(incoming),
    outgoing: uniqueFileMapItems(outgoing)
  };
}

function uniqueFileMapItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${normalizePathKey(item.path)}:${item.type || ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function findFileNodeByPath(path) {
  const normalized = normalizePathKey(path);
  return (state.result?.nodes || []).find((node) => normalizePathKey(node.relativePath) === normalized);
}

function nodePathFromId(id) {
  return (state.result?.nodes || []).find((node) => node.id === id)?.relativePath || "";
}

function normalizePathKey(path) {
  return String(path || "").replace(/\\/g, "/").toLowerCase();
}

function renderNodeDetails() {
  const graphNode = state.currentGraphNodes.find((item) => item.id === state.selectedNodeId);
  const fileNode = state.result?.nodes.find((item) => item.id === state.selectedNodeId);
  const node = graphNode || fileNode;
  if (!node) {
    elements.nodeDetails.innerHTML = `
      <h2>Nó selecionado</h2>
      <p class="muted">Clique em um nó do grafo ou em uma linha da tabela.</p>
    `;
    return;
  }

  const childFiles = (node.children || [])
    .map((id) => state.result.nodes.find((item) => item.id === id))
    .filter(Boolean);
  const samples = childFiles.slice(0, 8).map((item) => item.relativePath).join("; ");
  const reasons = node.protectedReasons?.length ? node.protectedReasons.join(", ") : node.groupReason || "sem proteção especial";
  const riskReasons = node.riskReasons?.length ? node.riskReasons.join("; ") : reasons;
  const unresolved = node.unresolvedSpecifiers?.length
    ? node.unresolvedSpecifiers.map((item) => `${item.type}: ${item.specifier}`).join("; ")
    : "nenhuma";

  elements.nodeDetails.innerHTML = `
    <h2>${escapeHtml(node.label || node.name || node.relativePath)}</h2>
    <dl>
      <dt>visão</dt><dd>${escapeHtml(graphModes[state.graphMode]?.label || "arquivo")}</dd>
      <dt>caminho</dt><dd>${fileMapButton(node.relativePath || "-")}</dd>
      <dt>classe</dt><dd>${escapeHtml(labels[node.classification] || node.classification || "-")}</dd>
      <dt>risco</dt><dd>${riskMarkup(node.risk)}</dd>
      <dt>apagar</dt><dd>${escapeHtml(decisionLabel(node.deletionDecision))}</dd>
      <dt>utilidade</dt><dd>${escapeHtml(utilityLabel(node.utilityStatus))}</dd>
      <dt>sistema</dt><dd>${escapeHtml(impactLabel(node.impact?.system))}</dd>
      <dt>usuário</dt><dd>${escapeHtml(impactLabel(node.impact?.user))}</dd>
      <dt>deps</dt><dd>${escapeHtml(impactLabel(node.impact?.dependencies))}</dd>
      <dt>arquivos</dt><dd>${formatNumber(node.fileCount || 1)}</dd>
      <dt>diretórios</dt><dd>${formatNumber(node.directoryCount || 0)}</dd>
      <dt>entrada</dt><dd>${formatNumber(node.incoming || 0)}</dd>
      <dt>saída</dt><dd>${formatNumber(node.outgoing || 0)}</dd>
      <dt>impacto</dt><dd>${formatNumber(node.impactCount || 0)}</dd>
      <dt>score</dt><dd>${formatNumber(node.riskScore || 0)}</dd>
      <dt>profundidade</dt><dd>${formatNumber(node.depth || 0)}</dd>
      <dt>tamanho</dt><dd>${formatBytes(node.size || 0)}</dd>
      <dt>último uso</dt><dd>${formatAccess(node.daysSinceAccess)}</dd>
      <dt>ação</dt><dd>${escapeHtml(node.action || node.simulationAction || "-")}</dd>
      <dt>motivo</dt><dd>${escapeHtml(riskReasons)}</dd>
      <dt>pendências</dt><dd>${escapeHtml(unresolved)}</dd>
      <dt>amostra</dt><dd>${escapeHtml(samples || "-")}</dd>
    </dl>
  `;
}

function renderFiles() {
  if (!state.result) {
    return;
  }

  const query = elements.fileSearch.value.trim().toLowerCase();
  const depthFilter = elements.depthFilter?.value || "all";
  const rows = state.result.nodes
    .filter((node) => node.kind === "file")
    .filter((node) => depthFilter === "all" || nodeMatchesDepth(node, depthFilter))
    .filter((node) => !query || node.relativePath.toLowerCase().includes(query))
    .sort((a, b) => {
      const riskDiff = riskWeight[b.risk] - riskWeight[a.risk];
      return riskDiff || b.incoming - a.incoming || a.relativePath.localeCompare(b.relativePath);
    })
    .slice(0, 1000);

  if (!rows.length) {
    elements.filesTable.innerHTML = empty("Nenhum arquivo encontrado no filtro.");
    return;
  }

  elements.filesTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Risco</th>
          <th>Apagar</th>
          <th>Utilidade</th>
          <th>Classe</th>
          <th>Entrada</th>
          <th>Saída</th>
          <th>Impacto</th>
          <th>Prof.</th>
          <th>Último uso</th>
          <th>Tamanho</th>
          <th>Caminho</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((node) => `
          <tr data-node-id="${escapeHtml(node.id)}">
            <td>${riskMarkup(node.risk)}</td>
            <td>${escapeHtml(decisionLabel(node.deletionDecision))}</td>
            <td>${escapeHtml(utilityLabel(node.utilityStatus))}</td>
            <td>${escapeHtml(labels[node.classification] || node.classification)}</td>
            <td>${formatNumber(node.incoming || 0)}</td>
            <td>${formatNumber(node.outgoing || 0)}</td>
            <td>${formatNumber(node.impactCount || 0)}</td>
            <td>${formatNumber(node.depth || 0)}</td>
            <td>${formatAccess(node.daysSinceAccess)}</td>
            <td>${formatBytes(node.size || 0)}</td>
            <td class="path-cell">${fileMapButton(node.relativePath)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;

  elements.filesTable.querySelectorAll("tr[data-node-id]").forEach((row) => {
    row.addEventListener("click", () => {
      state.zoom = 1.9;
      state.selectedNodeId = row.dataset.nodeId;
      renderNodeDetails();
      renderGraph();
    });
  });
}

function renderSimulation() {
  if (!state.result) {
    return;
  }

  const groups = [
    ["pode_apagar", "Pode apagar", "não afeta sistema nem dependências relevantes"],
    ["inutil_provavel", "Inútil provável", "baixo uso, baixo impacto, bom candidato"],
    ["averiguar", "Averiguar", "incerteza, uso ou dependência moderada"],
    ["nao_apagar", "Não apagar", "sistema, uso recente ou impacto alto"]
  ];
  const decisions = state.result.simulation?.decisionGroups || buildDecisionGroupsFromNodes(state.result.nodes || []);

  elements.simulationGrid.innerHTML = groups.map(([key, title, subtitle]) => {
    const items = decisions[key] || [];
    return `
      <article class="bucket">
        <h3>${escapeHtml(title)} - ${formatNumber(items.length)}</h3>
        <p class="muted">${escapeHtml(subtitle)}</p>
        ${items.length ? `
          <ol>
            ${items.slice(0, 24).map((item) => `
              <li>
                ${fileMapButton(item.path)}
                <span class="muted">${escapeHtml(item.reason)}</span>
              </li>
            `).join("")}
          </ol>
        ` : `<p class="muted">Nenhum item.</p>`}
      </article>
    `;
  }).join("");
}

function buildDecisionGroupsFromNodes(nodes) {
  const groups = {
    pode_apagar: [],
    inutil_provavel: [],
    averiguar: [],
    nao_apagar: []
  };

  for (const node of nodes.filter((item) => item.kind === "file")) {
    const key = groups[node.deletionDecision] ? node.deletionDecision : "averiguar";
    groups[key].push({
      path: node.relativePath,
      reason: (node.riskReasons || []).join(", ") || node.utilityStatus || "classificacao por metadados"
    });
  }

  for (const items of Object.values(groups)) {
    items.sort((a, b) => a.path.localeCompare(b.path));
  }

  return groups;
}

function renderRelocationPlan() {
  if (!state.result || !elements.areSummary || !elements.areModalBody) {
    return;
  }

  const plan = state.result.relocationPlan;
  if (!plan) {
    elements.areSummary.innerHTML = empty("Plano A.R.E indisponivel.");
    elements.areModalBody.innerHTML = empty("Plano A.R.E indisponivel.");
    if (elements.openAreModal) elements.openAreModal.disabled = true;
    if (elements.openAlcModal) elements.openAlcModal.disabled = true;
    if (elements.alcModalBody) elements.alcModalBody.innerHTML = empty("Plano A.L.C indisponivel.");
    return;
  }

  if (elements.openAreModal) elements.openAreModal.disabled = false;
  if (elements.openAlcModal) elements.openAlcModal.disabled = !getAlcCandidates({ applyRiskFilters: false }).length;
  elements.areSummary.innerHTML = renderAreSummary(plan);
  elements.areModalBody.innerHTML = renderAreModal(plan);
  if (elements.alcModalBody) elements.alcModalBody.innerHTML = renderAlcModal();
  elements.areSummary.querySelectorAll("[data-open-are-modal]").forEach((button) => {
    button.addEventListener("click", openAreModal);
  });
  elements.areModalBody.querySelectorAll("[data-open-alc-modal]").forEach((button) => {
    button.addEventListener("click", () => {
      closeAreModal();
      openAlcModal();
    });
  });
}

function renderAreSummary(plan) {
  const modes = ["baixo", "medio", "alto"];
  return `
    <div class="are-summary-grid">
      ${modes.map((modeKey) => {
        const mode = plan.spaceModes?.[modeKey] || {};
        return `
          <button class="are-summary-card" type="button" data-open-are-modal>
            <span>${escapeHtml(modeLabel(modeKey))}</span>
            <strong>${escapeHtml(mode.reallocatableHuman || "0 B")}</strong>
            <small>${escapeHtml(mode.inventoryEstimateUsed ? "estimativa total + candidatos" : `${formatNumber(mode.packageCount || 0)} pacote(s) simulados`)}</small>
          </button>
        `;
      }).join("")}
      <button class="are-summary-card are-summary-card-blocked" type="button" data-open-are-modal>
        <span>Bloqueados</span>
        <strong>${escapeHtml(plan.summary?.blockedHuman || "0 B")}</strong>
        <small>${formatNumber(plan.blockedFiles?.length || 0)} arquivo(s)</small>
      </button>
    </div>
  `;
}

function renderAreModal(plan) {
  const modes = ["baixo", "medio", "alto"];
  return `
    ${renderTargetPlan(plan.targetPlan || plan.summary?.targetPlan)}
    ${renderAreAlcBridge(plan)}
    ${renderAreSimulation(plan)}
    ${renderAreDepthBreakdown(plan)}
    <section class="are-modal-summary">
      ${modes.map((modeKey) => {
        const mode = plan.spaceModes?.[modeKey] || {};
        const simulation = plan.relocationSimulation?.[modeKey] || {};
        return `
          <article class="are-mode-total are-mode-${escapeHtml(modeKey)}">
            <span>${escapeHtml(modeLabel(modeKey))}</span>
            <strong>${escapeHtml(mode.reallocatableHuman || "0 B")}</strong>
            <small>${escapeHtml(mode.inventoryEstimateUsed ? `inventario ${mode.inventoryEstimatedHuman || "0 B"} / detalhado ${mode.detailedReallocatableHuman || "0 B"}` : `${formatNumber(mode.packageCount || 0)} pacote(s) / depois: ${simulation.remainingHuman || "0 B"}`)}</small>
          </article>
        `;
      }).join("")}
      <article class="are-mode-total are-mode-blocked">
        <span>Bloqueados</span>
        <strong>${escapeHtml(plan.summary?.blockedHuman || "0 B")}</strong>
        <small>${formatNumber(plan.blockedFiles?.length || 0)} arquivo(s)</small>
      </article>
    </section>
    <section class="are-safety-report">
      <h3>Relatorio de seguranca</h3>
      <p>${escapeHtml(plan.safetyReport?.text || "Sem relatorio.")}</p>
    </section>
    ${modes.map((modeKey) => renderAreMode(plan.spaceModes?.[modeKey], modeKey)).join("")}
    ${renderBlockedFiles(plan.blockedFiles || [])}
  `;
}

function renderAreAlcBridge(plan) {
  const candidates = getAlcCandidates({ applyRiskFilters: false });
  if (!candidates.length) {
    return "";
  }
  const targetPlan = plan.targetPlan || plan.summary?.targetPlan;
  const total = candidates.reduce((sum, item) => sum + candidateBytes(item), 0);
  return `
    <section class="are-simulation-board are-alc-bridge">
      <div class="are-section-heading">
        <div>
          <h3>A.R.E -> A.L.C</h3>
          <p class="muted">Use o plano do A.R.E como fila editavel do A.L.C: filtre por nivel, risco e confirme apenas o que deve ser realocado.</p>
        </div>
        <button class="primary-button" type="button" data-open-alc-modal>Abrir A.L.C</button>
      </div>
      <div class="are-simulation-grid">
        <article class="are-sim-card">
          <span>Fila inicial</span>
          <strong>${formatNumber(candidates.length)}</strong>
          <small>arquivo(s) detalhados</small>
        </article>
        <article class="are-sim-card">
          <span>Espaco visivel</span>
          <strong>${formatBytes(total)}</strong>
          <small>A.L.C confirma antes de mover</small>
        </article>
        <article class="are-sim-card">
          <span>Nivel sugerido</span>
          <strong>${escapeHtml(modeLabel(targetPlan?.selectedMode || "alto"))}</strong>
          <small>${escapeHtml(targetPlan?.status || "manual")}</small>
        </article>
      </div>
    </section>
  `;
}

function renderTargetPlan(targetPlan) {
  if (!targetPlan) {
    return "";
  }
  return `
    <section class="are-simulation-board">
      <div class="are-section-heading">
        <div>
          <h3>Meta de limpeza</h3>
          <p class="muted">${escapeHtml(targetPlan.statusText || "Meta calculada pelo MaidSpace.")}</p>
        </div>
      </div>
      <div class="are-simulation-grid">
        <article class="are-sim-card">
          <span>Meta</span>
          <strong>${escapeHtml(targetPlan.targetHuman || "0 B")}</strong>
          <small>espaco desejado</small>
        </article>
        <article class="are-sim-card">
          <span>Nivel</span>
          <strong>${escapeHtml(modeLabel(targetPlan.selectedMode || "alto"))}</strong>
          <small>${escapeHtml(targetPlan.status || "planejado")}</small>
        </article>
        <article class="are-sim-card">
          <span>Plano</span>
          <strong>${escapeHtml(targetPlan.plannedHuman || "0 B")}</strong>
          <small>${formatNumber(targetPlan.selectedFiles || 0)} arquivo(s)</small>
        </article>
      </div>
    </section>
  `;
}

function renderAreDepthBreakdown(plan) {
  const depths = plan.depthRelocation || [];
  if (!depths.length) {
    return "";
  }

  return `
    <section class="are-simulation-board">
      <div class="are-section-heading">
        <div>
          <h3>Realocacao por profundidade</h3>
          <p class="muted">Cada linha soma a camada lida pelo A.D.D; o total do A.R.E usa todas as camadas acumuladas.</p>
        </div>
      </div>
      <div class="table-wrap are-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Prof.</th>
              <th>Arquivos</th>
              <th>Total lido</th>
              <th>Baixo</th>
              <th>Medio</th>
              <th>Alto</th>
              <th>Bloqueado</th>
            </tr>
          </thead>
          <tbody>
            ${depths.map((item) => `
              <tr>
                <td>${escapeHtml(item.depth)}</td>
                <td>${formatNumber(item.files || 0)}</td>
                <td>${escapeHtml(item.totalHuman || "0 B")}</td>
                <td>${escapeHtml(item.reallocatableHuman?.baixo || "0 B")}</td>
                <td>${escapeHtml(item.reallocatableHuman?.medio || "0 B")}</td>
                <td>${escapeHtml(item.reallocatableHuman?.alto || "0 B")}</td>
                <td>${escapeHtml(item.blockedHuman || "0 B")}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderAreSimulation(plan) {
  const modes = ["baixo", "medio", "alto"];
  return `
    <section class="are-simulation-board">
      <div class="are-section-heading">
        <div>
          <h3>Simulacao de realocacao</h3>
          <p class="muted">Mostra quanto sairia do diretorio principal se o usuario confirmasse a realocacao.</p>
        </div>
      </div>
      <div class="are-simulation-grid">
        ${modes.map((modeKey) => {
          const simulation = plan.relocationSimulation?.[modeKey] || {};
          const percent = clamp(Number(simulation.relocatedPercent || 0), 0, 100);
          return `
            <article class="are-simulation-card">
              <div class="are-simulation-head">
                <strong>${escapeHtml(modeLabel(modeKey))}</strong>
                <span>${escapeHtml(simulation.relocatedHuman || "0 B")}</span>
              </div>
              <div class="space-bar" aria-label="Espaco realocado em ${escapeHtml(modeKey)}">
                <span style="width: ${percent}%"></span>
              </div>
              <dl>
                <dt>antes</dt><dd>${escapeHtml(simulation.beforeHuman || "0 B")}</dd>
                <dt>realocado</dt><dd>${escapeHtml(simulation.relocatedHuman || "0 B")}</dd>
                <dt>depois</dt><dd>${escapeHtml(simulation.remainingHuman || "0 B")}</dd>
                <dt>pacotes</dt><dd>${formatNumber(simulation.packageCount || 0)}</dd>
              </dl>
              <p class="muted">${escapeHtml(simulation.explanation || "")}</p>
            </article>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function renderAreMode(mode, modeKey) {
  const candidates = mode?.candidates || [];
  return `
    <section class="are-mode-section">
      <div class="are-section-heading">
        <div>
          <h3>${escapeHtml(modeLabel(modeKey))} - ${escapeHtml(mode?.reallocatableHuman || "0 B")}</h3>
          <p class="muted">${escapeHtml(mode?.description || "")}</p>
        </div>
        <span class="risk ${escapeHtml(modeRiskClass(modeKey))}">${escapeHtml(modeKey)}</span>
      </div>
      <ul class="are-criteria-list">
        ${(mode?.criteria || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
      </ul>
      ${renderArePackageTable(mode?.packages || [])}
      ${renderAreCandidateTable(candidates)}
    </section>
  `;
}

function renderArePackageTable(packages) {
  if (!packages.length) {
    return empty("Nenhum pacote simulado neste nivel.");
  }
  return `
    <div class="table-wrap are-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pacote simulado</th>
            <th>Espaco</th>
            <th>Arquivos</th>
            <th>Destino simulado</th>
            <th>Justificativa</th>
          </tr>
        </thead>
        <tbody>
          ${packages.slice(0, 60).map((item) => `
            <tr>
              <td class="path-cell">${fileMapButton(item.files[0] || item.id)}</td>
              <td>${escapeHtml(item.human || formatBytes(item.bytes || 0))}</td>
              <td>${formatNumber(item.fileCount || 0)}</td>
              <td>${escapeHtml(item.targetDirectory || "-")}</td>
              <td>${escapeHtml(item.justification || "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderAreCandidateTable(candidates) {
  if (!candidates.length) {
    return empty("Nenhum candidato neste nivel.");
  }
  return `
    <div class="table-wrap are-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Arquivo</th>
            <th>Pacote</th>
            <th>Classe</th>
            <th>Risco</th>
            <th>Ult. acesso</th>
            <th>Ult. mod.</th>
            <th>Justificativa</th>
          </tr>
        </thead>
        <tbody>
          ${candidates.slice(0, 80).map((item) => `
            <tr>
              <td class="path-cell">${fileMapButton(item.path)}</td>
              <td>${escapeHtml(item.packageHuman || item.sizeHuman || "0 B")}<br><span class="muted">${formatNumber(item.packageFileCount || 1)} arquivo(s)</span></td>
              <td>${escapeHtml(labels[item.classification] || item.classification || "-")}</td>
              <td>${riskMarkup(item.risk)}</td>
              <td>${formatAccess(item.daysSinceAccess)}</td>
              <td>${formatAccess(item.daysSinceModified)}</td>
              <td>${escapeHtml(item.justification || "-")}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    </div>
  `;
}

function renderBlockedFiles(blockedFiles) {
  return `
    <section class="are-mode-section are-blocked-section">
      <div class="are-section-heading">
        <div>
          <h3>Arquivos bloqueados - ${formatNumber(blockedFiles.length)}</h3>
          <p class="muted">Arquivos fora dos niveis baixo, medio e alto por risco, sistema, ciclo, uso recente ou dependencia importante.</p>
        </div>
      </div>
      ${blockedFiles.length ? `
        <div class="table-wrap are-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Arquivo</th>
                <th>Tamanho</th>
                <th>Classe</th>
                <th>Risco</th>
                <th>Motivo</th>
              </tr>
            </thead>
            <tbody>
              ${blockedFiles.slice(0, 120).map((item) => `
                <tr>
                  <td class="path-cell">${fileMapButton(item.path)}</td>
                  <td>${escapeHtml(item.sizeHuman || formatBytes(item.sizeBytes || 0))}</td>
                  <td>${escapeHtml(labels[item.classification] || item.classification || "-")}</td>
                  <td>${riskMarkup(item.risk)}</td>
                  <td>${escapeHtml(item.reason || item.blockingReasons?.[0] || "-")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      ` : empty("Nenhum arquivo bloqueado.")}
    </section>
  `;
}

function openAreModal() {
  if (!state.result?.relocationPlan || !elements.areModal) {
    return;
  }
  elements.areModal.classList.remove("is-hidden");
  elements.areModal.setAttribute("aria-hidden", "false");
  setModalOpenState();
}

function closeAreModal() {
  if (!elements.areModal) {
    return;
  }
  elements.areModal.classList.add("is-hidden");
  elements.areModal.setAttribute("aria-hidden", "true");
  setModalOpenState();
}

function openAlcModal() {
  if (!state.result?.relocationPlan || !elements.alcModal || !elements.alcModalBody) {
    return;
  }
  elements.alcModalBody.innerHTML = renderAlcModal();
  elements.alcModal.classList.remove("is-hidden");
  elements.alcModal.setAttribute("aria-hidden", "false");
  setModalOpenState();
  wireAlcModalControls();
}

function closeAlcModal() {
  if (!elements.alcModal) {
    return;
  }
  elements.alcModal.classList.add("is-hidden");
  elements.alcModal.setAttribute("aria-hidden", "true");
  setModalOpenState();
}

function setModalOpenState() {
  const anyOpen = [elements.areModal, elements.alcModal].some((modal) => modal && !modal.classList.contains("is-hidden"));
  document.body.classList.toggle("modal-open", anyOpen);
}

function renderAlcModal() {
  const candidates = getAlcCandidates();
  const allCandidates = getAlcCandidates({ applyRiskFilters: false });
  const targetPlan = state.result?.relocationPlan?.targetPlan || state.result?.relocationPlan?.summary?.targetPlan;
  if (!state.result?.relocationPlan) {
    return empty("Execute uma varredura para preparar o A.L.C.");
  }
  if (!allCandidates.length) {
    return empty("Nenhum candidato detalhado para o A.L.C executar agora.");
  }

  const totalBytes = allCandidates.reduce((sum, item) => sum + candidateBytes(item), 0);
  const visibleBytes = candidates.reduce((sum, item) => sum + candidateBytes(item), 0);
  const userContentCount = candidates.filter(isLikelyUserContentCandidate).length;
  const nativeExecutor = isNativeMaidSpace();
  const activeMode = currentAlcAreMode();
  const activeRisks = currentAlcRisks();
  const estimateWarning = targetPlan?.status === "estimativa_exige_mais_detalhe"
    ? `<div class="alc-alert">O A.R.E atingiu a meta por estimativa compactada. O A.L.C MVP executa apenas os candidatos detalhados abaixo; uma etapa futura pode pedir uma segunda varredura focada para completar a meta.</div>`
    : "";
  const nativeWarning = nativeExecutor
    ? ""
    : `<div class="alc-alert is-strong">O executor A.L.C precisa do MaidSpace local/Tauri. No fallback web, esta tela serve apenas para revisar a fila.</div>`;
  const userWarning = userContentCount
    ? `<div class="alc-alert is-strong">${formatNumber(userContentCount)} candidato(s) parecem conteudo criado pelo usuario. Revise a selecao antes de executar.</div>`
    : "";

  return `
    <section class="alc-console">
      ${nativeWarning}
      ${estimateWarning}
      ${userWarning}
      <div class="alc-summary">
        <span><strong>${formatNumber(candidates.length)}</strong> visivel(is)</span>
        <span><strong>${formatNumber(allCandidates.length)}</strong> na fonte</span>
        <span><strong>${formatBytes(visibleBytes)}</strong> filtrados</span>
        <span><strong>${formatBytes(totalBytes)}</strong> fonte completa</span>
        <span><strong>${escapeHtml(targetPlan?.targetHuman || "0 B")}</strong> meta</span>
        <span><strong>${escapeHtml(modeLabel(targetPlan?.selectedMode || "alto"))}</strong> nivel sugerido</span>
      </div>
      <div class="alc-filter-grid">
        <label class="field">
          <span>Fonte A.R.E</span>
          <select id="alcAreMode">
            <option value="target"${activeMode === "target" ? " selected" : ""}>Plano da meta</option>
            <option value="baixo"${activeMode === "baixo" ? " selected" : ""}>Nivel baixo</option>
            <option value="medio"${activeMode === "medio" ? " selected" : ""}>Nivel medio</option>
            <option value="alto"${activeMode === "alto" ? " selected" : ""}>Nivel alto</option>
          </select>
        </label>
        <div class="field">
          <span>Riscos na fila</span>
          <div class="alc-risk-filter">
            ${["baixo", "medio", "alto", "critico"].map((risk) => `
              <label>
                <input type="checkbox" data-alc-risk-filter="${escapeHtml(risk)}"${activeRisks.includes(risk) ? " checked" : ""}>
                <span class="risk ${escapeHtml(risk)}">${escapeHtml(risk)}</span>
              </label>
            `).join("")}
          </div>
        </div>
      </div>
      <div class="alc-control-grid" role="radiogroup" aria-label="Destino do A.L.C">
        <label class="alc-target-card">
          <input type="radio" name="alcTargetKind" value="directory"${state.alcDraft.targetKind === "trash" ? "" : " checked"}>
          <span><b>Mover para pasta</b><br>Preserva a estrutura relativa dentro do destino escolhido.</span>
        </label>
        <label class="alc-target-card">
          <input type="radio" name="alcTargetKind" value="trash"${state.alcDraft.targetKind === "trash" ? " checked" : ""}>
          <span><b>Enviar para lixeira</b><br>Usa a lixeira do sistema, sem exclusao permanente imediata.</span>
        </label>
      </div>
      <div id="alcDestinationBlock" class="alc-destination">
        <label class="field">
          <span>Destino A.L.C</span>
          <div class="input-action-row">
            <input id="alcDestinationPath" type="text" spellcheck="false" placeholder="D:\\MaidSpace\\Realocados" value="${escapeHtml(state.alcDraft.targetDirectory || "")}">
            <button id="chooseAlcDestination" class="ghost-button" type="button">Escolher</button>
          </div>
        </label>
        <p class="muted">Escolha uma pasta fora da raiz varrida para realmente tirar dados do diretorio analisado.</p>
      </div>
      <div class="alc-action-row">
        <div>
          <button id="alcSelectAll" class="ghost-button" type="button">Selecionar tudo</button>
          <button id="alcClearSelection" class="ghost-button" type="button">Limpar selecao</button>
        </div>
        <span id="alcSelectedSummary" class="muted">Calculando selecao...</span>
      </div>
      <div class="table-wrap alc-table-wrap">
        <table class="alc-table">
          <thead>
            <tr>
              <th>Usar</th>
              <th>Arquivo</th>
              <th>Espaco</th>
              <th>Risco</th>
              <th>Decisao</th>
              <th>Motivo</th>
            </tr>
          </thead>
          <tbody>
            ${candidates.length ? candidates.slice(0, 220).map((item) => {
              const userContent = isLikelyUserContentCandidate(item);
              return `
                <tr>
                  <td><input type="checkbox" data-alc-file="${escapeHtml(item.path)}" checked aria-label="Selecionar ${escapeHtml(item.path)}"></td>
                  <td class="path-cell">
                    ${fileMapButton(item.path)}
                    ${userContent ? `<span class="alc-user-warning">possivel arquivo do usuario</span>` : ""}
                  </td>
                  <td>${escapeHtml(item.sizeHuman || item.packageHuman || formatBytes(candidateBytes(item)))}</td>
                  <td>${riskMarkup(item.risk)}</td>
                  <td>${escapeHtml(decisionLabel(item.deletionDecision))}</td>
                  <td>${escapeHtml(item.justification || item.reason || "candidato A.R.E")}</td>
                </tr>
              `;
            }).join("") : `
              <tr>
                <td colspan="6">${empty("Nenhum arquivo combina com os filtros atuais.")}</td>
              </tr>
            `}
          </tbody>
        </table>
      </div>
      <div id="alcResult" class="alc-result is-hidden"></div>
      <div class="alc-footer">
        <p class="muted">O A.L.C MVP move arquivos confirmados. A execucao continua sera ligada em etapa posterior.</p>
        <button id="executeAlcButton" class="primary-button" type="button"${nativeExecutor ? "" : " disabled"}>Executar A.L.C</button>
      </div>
    </section>
  `;
}

function wireAlcModalControls() {
  const body = elements.alcModalBody;
  if (!body) {
    return;
  }

  const destinationInput = body.querySelector("#alcDestinationPath");
  const executeButton = body.querySelector("#executeAlcButton");
  const destinationBlock = body.querySelector("#alcDestinationBlock");
  const summary = body.querySelector("#alcSelectedSummary");
  const update = () => {
    const kind = body.querySelector("input[name='alcTargetKind']:checked")?.value || "directory";
    state.alcDraft.targetKind = kind;
    state.alcDraft.targetDirectory = destinationInput?.value.trim() || "";
    const selected = selectedAlcCandidates();
    const bytes = selected.reduce((sum, item) => sum + candidateBytes(item), 0);
    const hasDestination = kind === "trash" || Boolean(destinationInput?.value.trim());
    if (destinationBlock) {
      destinationBlock.style.display = kind === "directory" ? "grid" : "none";
    }
    if (summary) {
      summary.textContent = `${formatNumber(selected.length)} arquivo(s), ${formatBytes(bytes)} selecionados`;
    }
    if (executeButton) {
      executeButton.disabled = !isNativeMaidSpace() || !selected.length || !hasDestination;
    }
  };

  body.querySelector("#alcAreMode")?.addEventListener("change", (event) => {
    state.alcFilters.areMode = event.target.value;
    refreshAlcModal();
  });
  body.querySelectorAll("[data-alc-risk-filter]").forEach((input) => {
    input.addEventListener("change", () => {
      state.alcFilters.risks = Array.from(body.querySelectorAll("[data-alc-risk-filter]:checked"))
        .map((item) => item.dataset.alcRiskFilter);
      refreshAlcModal();
    });
  });
  body.querySelectorAll("input[name='alcTargetKind']").forEach((input) => {
    input.addEventListener("change", update);
  });
  body.querySelectorAll("[data-alc-file]").forEach((input) => {
    input.addEventListener("change", update);
  });
  destinationInput?.addEventListener("input", update);
  body.querySelector("#chooseAlcDestination")?.addEventListener("click", async () => {
    try {
      const directory = await pickDirectory("Cole o caminho de destino do A.L.C:");
      if (directory && destinationInput) {
        destinationInput.value = directory;
        update();
      }
    } catch (error) {
      showAlcResult(null, error);
    }
  });
  body.querySelector("#alcSelectAll")?.addEventListener("click", () => {
    body.querySelectorAll("[data-alc-file]").forEach((input) => {
      input.checked = true;
    });
    update();
  });
  body.querySelector("#alcClearSelection")?.addEventListener("click", () => {
    body.querySelectorAll("[data-alc-file]").forEach((input) => {
      input.checked = false;
    });
    update();
  });
  executeButton?.addEventListener("click", executeAlcRelocation);
  update();
}

function refreshAlcModal() {
  if (!elements.alcModalBody || elements.alcModal?.classList.contains("is-hidden")) {
    return;
  }
  elements.alcModalBody.innerHTML = renderAlcModal();
  wireAlcModalControls();
}

function currentAlcAreMode() {
  const mode = state.alcFilters?.areMode || "target";
  return ["target", "baixo", "medio", "alto"].includes(mode) ? mode : "target";
}

function currentAlcRisks() {
  const risks = Array.isArray(state.alcFilters?.risks) ? state.alcFilters.risks : [];
  return risks.filter((risk) => ["baixo", "medio", "alto", "critico"].includes(risk));
}

function getAlcCandidateSource() {
  const plan = state.result?.relocationPlan;
  if (!plan) {
    return [];
  }

  const mode = currentAlcAreMode();
  const targetPlan = plan.targetPlan || plan.summary?.targetPlan;
  if (mode === "target") {
    return targetPlan?.candidates?.length
      ? targetPlan.candidates
      : plan.spaceModes?.alto?.candidates || [];
  }
  return plan.spaceModes?.[mode]?.candidates || [];
}

function getAlcCandidates(options = {}) {
  const source = getAlcCandidateSource();
  const activeRisks = currentAlcRisks();
  const applyRiskFilters = options.applyRiskFilters !== false;
  const seen = new Set();
  return source
    .filter((item) => item && item.path && item.deletionDecision !== "nao_apagar")
    .filter((item) => !applyRiskFilters || activeRisks.includes(item.risk || "baixo"))
    .sort((a, b) => candidateBytes(b) - candidateBytes(a))
    .filter((item) => {
      if (seen.has(item.path)) {
        return false;
      }
      seen.add(item.path);
      return true;
    })
    .slice(0, 220);
}

function selectedAlcCandidates() {
  const body = elements.alcModalBody;
  if (!body) {
    return [];
  }
  const selectedPaths = new Set(
    Array.from(body.querySelectorAll("[data-alc-file]:checked")).map((input) => input.dataset.alcFile)
  );
  return getAlcCandidates().filter((item) => selectedPaths.has(item.path));
}

async function executeAlcRelocation() {
  const body = elements.alcModalBody;
  if (!body) {
    return;
  }

  const targetKind = body.querySelector("input[name='alcTargetKind']:checked")?.value || "directory";
  const targetDirectory = targetKind === "directory"
    ? body.querySelector("#alcDestinationPath")?.value.trim()
    : null;
  const candidates = selectedAlcCandidates();
  const userContentCount = candidates.filter(isLikelyUserContentCandidate).length;
  const selectedBytes = candidates.reduce((sum, item) => sum + candidateBytes(item), 0);

  if (!candidates.length) {
    showAlcResult(null, new Error("Selecione pelo menos um arquivo."));
    return;
  }

  if (targetKind === "directory" && !targetDirectory) {
    showAlcResult(null, new Error("Escolha a pasta de destino."));
    return;
  }

  const actionLabel = targetKind === "trash" ? "enviar para a lixeira" : "mover para o destino";
  const warning = userContentCount
    ? `\n\nATENCAO: ${userContentCount} arquivo(s) parecem conteudo criado pelo usuario.`
    : "";
  const confirmed = window.confirm(`Confirmar A.L.C para ${actionLabel} ${candidates.length} arquivo(s), somando ${formatBytes(selectedBytes)}?${warning}`);
  if (!confirmed) {
    return;
  }

  const executeButton = body.querySelector("#executeAlcButton");
  if (executeButton) {
    executeButton.disabled = true;
    executeButton.textContent = "Executando...";
  }

  let executionCompleted = false;
  try {
    const request = {
      rootPath: state.result.rootPath || elements.rootPath.value.trim(),
      targetKind,
      targetDirectory,
      files: candidates.map((item) => ({
        relativePath: item.path,
        size: candidateBytes(item),
        userContent: isLikelyUserContentCandidate(item)
      }))
    };
    const report = await fetchJson("/api/alc/relocate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ request })
    });
    state.lastAlcReport = report;
    appendSystemLog(`A.L.C executado: ${formatNumber(report.movedFiles || 0)} arquivo(s), ${formatBytes(report.movedBytes || 0)} realocados.`);
    showAlcResult(report);
    executionCompleted = true;
  } catch (error) {
    appendSystemLog(`Erro A.L.C: ${errorMessage(error)}`);
    showAlcResult(null, error);
  } finally {
    if (executeButton) {
      executeButton.textContent = "Executar A.L.C";
      executeButton.disabled = executionCompleted;
    }
  }
}

function showAlcResult(report, error = null) {
  const result = elements.alcModalBody?.querySelector("#alcResult");
  if (!result) {
    return;
  }
  result.classList.remove("is-hidden", "is-error");
  if (error) {
    result.classList.add("is-error");
    result.innerHTML = `
      <strong>Falha no A.L.C</strong>
      <span>${escapeHtml(errorMessage(error))}</span>
    `;
    return;
  }

  result.innerHTML = `
    <strong>A.L.C concluido</strong>
    <span>${formatNumber(report.movedFiles || 0)} arquivo(s) realocados, ${formatBytes(report.movedBytes || 0)} retirados da raiz.</span>
    <span>${formatNumber(report.failedFiles || 0)} falha(s), ${formatNumber(report.skippedFiles || 0)} ignorado(s). Execute nova varredura para atualizar o A.D.D/A.R.E.</span>
  `;
}

function candidateBytes(item) {
  return Number(item?.packageBytes || item?.sizeBytes || item?.bytes || 0);
}

function isLikelyUserContentCandidate(item) {
  const path = String(item?.path || "").replace(/\\/g, "/").toLowerCase();
  const extension = (path.match(/\.([a-z0-9_+-]+)$/)?.[1] || "").toLowerCase();
  const userFolder = /(^|\/)(users|desktop|documents|downloads|pictures|videos|music|onedrive|ideaProjects|projects|workspace|repos)(\/|$)/i.test(path);
  const personalExtension = new Set([
    "doc", "docx", "xls", "xlsx", "ppt", "pptx", "pdf", "txt", "md", "rtf",
    "jpg", "jpeg", "png", "gif", "webp", "psd", "kra", "clip",
    "mp4", "mov", "mkv", "avi", "mp3", "wav", "flac",
    "zip", "rar", "7z", "blend", "sai"
  ]).has(extension);
  const notObviouslyGenerated = !/(^|\/)(node_modules|target|build|dist|cache|tmp|temp|logs?)(\/|$)/i.test(path);
  return notObviouslyGenerated && (userFolder || personalExtension || item?.userImpact === "alto");
}

function modeLabel(modeKey) {
  const labels = {
    baixo: "Nivel baixo",
    medio: "Nivel medio",
    alto: "Nivel alto"
  };
  return labels[modeKey] || modeKey;
}

function modeRiskClass(modeKey) {
  if (modeKey === "baixo") return "baixo";
  if (modeKey === "medio") return "medio";
  return "alto";
}

function renderContinuousState() {
  if (!state.result || !elements.continuousState) {
    return;
  }

  const alc = state.result.continuousState;
  if (!alc) {
    elements.continuousState.innerHTML = empty("Estado A.L.C indisponivel.");
    return;
  }

  const summary = alc.summary || {};
  elements.continuousState.innerHTML = metricMarkup([
    [alc.mode === "primeiro_estado" ? "inicial" : "comparacao", "modo"],
    [summary.newFiles || 0, "novos"],
    [summary.modifiedFiles || 0, "modificados"],
    [summary.removedFiles || 0, "removidos"],
    [summary.riskChangedFiles || 0, "mudanca risco"],
    [summary.dependencyChangedFiles || 0, "mudanca deps"],
    [summary.reanalysisNeeded ? "sim" : "nao", "reanalise"],
    [state.result.modules?.alc?.statePath ? "salvo" : "nao salvo", "estado"]
  ]);
}

function renderDepthTimeline() {
  if (!state.result || !elements.depthTimeline) {
    return;
  }

  const depths = state.result.summary?.depthBreakdown || [];
  const relocationDepths = new Map((state.result.relocationPlan?.depthRelocation || []).map((item) => [Number(item.depth), item]));
  if (!depths.length) {
    elements.depthTimeline.innerHTML = empty("Nenhuma profundidade registrada.");
    return;
  }

  elements.depthTimeline.innerHTML = depths.map((depth) => {
    const relocation = relocationDepths.get(Number(depth.depth)) || {};
    const high = relocation.reallocatableHuman?.alto || "0 B";
    const medium = relocation.reallocatableHuman?.medio || "0 B";
    const low = relocation.reallocatableHuman?.baixo || "0 B";
    return `
      <button class="depth-row" type="button" data-depth="${escapeHtml(depth.depth)}">
        <span class="depth-index">Prof. ${escapeHtml(depth.depth)}</span>
        <span>${formatNumber(depth.files)} arquivo(s)</span>
        <strong>${escapeHtml(depth.human || "0 B")}</strong>
        <small>ARE alto ${escapeHtml(high)} / medio ${escapeHtml(medium)} / baixo ${escapeHtml(low)}</small>
      </button>
    `;
  }).join("");

  elements.depthTimeline.querySelectorAll("[data-depth]").forEach((button) => {
    button.addEventListener("click", () => {
      if (!elements.depthFilter) {
        return;
      }
      elements.depthFilter.value = String(button.dataset.depth);
      renderGraph();
      renderFiles();
    });
  });
}

function renderCycles() {
  if (!state.result || !elements.cyclesList) {
    return;
  }

  const cycles = state.result.cycles || [];
  if (!cycles.length) {
    elements.cyclesList.innerHTML = empty("Nenhum ciclo detectado por DFS.");
    return;
  }

  const nodesById = new Map(state.result.nodes.map((node) => [node.id, node]));
  elements.cyclesList.innerHTML = cycles.map((cycle) => {
    const files = cycle.nodeIds
      .map((id) => nodesById.get(id)?.relativePath)
      .filter(Boolean)
      .join(" -> ");
    return `
      <div class="warning-item critical-warning">
        <strong>${escapeHtml(cycle.id)} - ${formatNumber(cycle.nodeCount)} arquivos</strong>
        <p class="muted">${escapeHtml(files)}</p>
        <p class="muted">${escapeHtml(cycle.suggestion || "manter junto e revisar manualmente")}</p>
      </div>
    `;
  }).join("");
}

function renderTextReport() {
  if (!state.result || !elements.textReport) {
    return;
  }
  elements.textReport.textContent = state.result.report?.text || "";
}

function renderDependencies() {
  if (!state.result) {
    return;
  }

  const rows = state.result.edges.slice(0, 1200);
  if (!rows.length) {
    elements.dependenciesTable.innerHTML = empty("Nenhuma dependência local resolvida.");
    return;
  }

  elements.dependenciesTable.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Tipo</th>
          <th>Linha</th>
          <th>Origem</th>
          <th>Destino</th>
          <th>Declaração</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((edge) => `
          <tr>
            <td>${escapeHtml(edge.type)}</td>
            <td>${edge.line || "-"}</td>
            <td class="path-cell">${fileMapButton(edge.sourcePath)}</td>
            <td class="path-cell">${fileMapButton(edge.targetPath)}</td>
            <td class="path-cell">${escapeHtml(edge.specifier)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function renderWarnings() {
  if (!state.result) {
    return;
  }

  const items = [
    ...state.result.warnings.map((warning) => ({ path: "varredura", reason: warning })),
    ...state.result.skipped
  ];

  if (!items.length) {
    elements.warningsList.innerHTML = empty("Sem avisos para esta varredura.");
    return;
  }

  elements.warningsList.innerHTML = items.slice(0, 500).map((item) => `
    <div class="warning-item">
      <strong>${escapeHtml(item.path || ".")}</strong>
      <p class="muted">${escapeHtml(item.reason || "ignorado")}</p>
    </div>
  `).join("");
}

function exportJson() {
  if (!state.result) {
    return;
  }
  const blob = new Blob([JSON.stringify(state.result, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const date = new Date().toISOString().replace(/[:.]/g, "-");
  anchor.href = url;
  anchor.download = `relatorio-add-${date}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function riskMarkup(risk) {
  return `<span class="risk ${escapeHtml(risk)}">${escapeHtml(risk)}</span>`;
}

function decisionLabel(value) {
  const labels = {
    pode_apagar: "pode apagar",
    inutil_provavel: "inútil provável",
    averiguar: "averiguar",
    nao_apagar: "não apagar"
  };
  return labels[value] || value || "-";
}

function utilityLabel(value) {
  const labels = {
    sistema: "sistema",
    protegido: "protegido",
    usado_pelo_usuario: "usado",
    dependencia_relevante: "dependência relevante",
    bloco_interdependente: "bloco interdependente",
    inutil_provavel: "inútil provável",
    baixo_uso: "baixo uso",
    utilidade_incerta: "incerta",
    desconhecido: "desconhecida"
  };
  return labels[value] || value || "-";
}

function impactLabel(value) {
  const labels = {
    afeta_sistema: "afeta sistema",
    nao_afeta_sistema: "não afeta sistema",
    protegido: "protegido",
    critico: "critico",
    alto: "alto",
    medio: "médio",
    baixo: "baixo",
    nenhum: "nenhum",
    incerto: "incerto"
  };
  return labels[value] || value || "-";
}

function formatAccess(days) {
  if (!Number.isFinite(Number(days))) {
    return "-";
  }
  if (days <= 0) {
    return "hoje";
  }
  if (days === 1) {
    return "1 dia";
  }
  return `${formatNumber(days)} dias`;
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

function formatNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return String(value ?? "-");
  }
  return new Intl.NumberFormat("pt-BR").format(numeric);
}

function formatCompact(value) {
  if (value >= 1000) {
    return `${Math.round(value / 100) / 10}k`;
  }
  return String(value);
}

function trimLabel(value, maxLength) {
  const text = String(value || "");
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(3, maxLength - 1))}…`;
}

function hexToRgba(hex, alpha) {
  const clean = hex.replace("#", "");
  const bigint = Number.parseInt(clean, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hashNumber(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function roundRect(context, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function empty(message) {
  return `<div class="empty-state">${escapeHtml(message)}</div>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
