const http = require("node:http");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");
const {
  analyzeDirectory,
  analyzeDirectoryProgressive,
  construir_grafo: buildGraphViews,
  DEFAULT_OPTIONS
} = require("./src/add/analyzer");
const { generateRelocationPlan } = require("./src/are/planner");
const {
  buildDirectoryState,
  compareDirectoryStates,
  loadPreviousState,
  saveCurrentState
} = require("./src/alc/state");
const {
  applyPreferencesToAddReport,
  loadRootPreferences,
  saveExemptDirectories,
  saveFileDecision,
  saveTargetPreference
} = require("./src/alc/preferences");
const { scanRelocationCandidates } = require("./src/scan/fastInventory");
const { generateSrcReport } = require("./src/report");
const {
  buildOperationItem,
  createOperationId,
  createOperationManifest,
  effectiveActionForTargetKind,
  operationLogDirectory,
  protectedPathReason,
  quarantineDirectoryFor,
  recordOperationResult,
  writeOperationManifest
} = require("./src/alc/operationManifest");

const rootDirectory = __dirname;
const publicDirectory = path.join(rootDirectory, "public");
const DEFAULT_ALC_WAVE_BYTES = 50 * 1024 * 1024 * 1024;
const MAX_ALC_WAVE_FILES = 5000;
const activeAlcCancellations = new Set();
const activeAlcJobs = new Map();

function createAppServer() {
  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/api/health") {
        return sendJson(response, 200, {
          ok: true,
          cwd: rootDirectory,
          defaultRootPath: defaultRootPath(),
          defaultOptions: {
            ...DEFAULT_OPTIONS,
            minimumFreeBytes: 0
          },
          diskStatus: await diskStatusForPath(defaultRootPath())
        });
      }

      if (request.method === "GET" && request.url.startsWith("/api/disk")) {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const rootPath = url.searchParams.get("rootPath") || defaultRootPath();
        return sendJson(response, 200, await diskStatusForPath(rootPath));
      }

      if (request.method === "POST" && request.url === "/api/scan") {
        const body = await readJsonBody(request);
        const result = await runSrcPipeline(body.rootPath || rootDirectory, body.options || {});
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && request.url === "/api/scan-progressive") {
        const body = await readJsonBody(request);
        return streamSrcPipeline(response, body.rootPath || rootDirectory, body.options || {});
      }

      if (request.method === "GET" && request.url.startsWith("/api/preferences")) {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const rootPath = url.searchParams.get("rootPath") || defaultRootPath();
        const preferences = await loadRootPreferences(rootPath);
        return sendJson(response, 200, preferences);
      }

      if (request.method === "POST" && request.url === "/api/preferences/decision") {
        const body = await readJsonBody(request);
        const preferences = await saveFileDecision(
          body.rootPath || defaultRootPath(),
          body.relativePath,
          body.decision,
          body.metadata || {}
        );
        return sendJson(response, 200, preferences);
      }

      if (request.method === "POST" && request.url === "/api/preferences/exemptions") {
        const body = await readJsonBody(request);
        const preferences = await saveExemptDirectories(
          body.rootPath || defaultRootPath(),
          body.directories || []
        );
        return sendJson(response, 200, preferences);
      }

      if (request.method === "POST" && request.url === "/api/preferences/target") {
        const body = await readJsonBody(request);
        const preferences = await saveTargetPreference(
          body.rootPath || defaultRootPath(),
          body.targetFreeBytes,
          body.minimumFreeBytes
        );
        return sendJson(response, 200, preferences);
      }

      if (request.method === "POST" && request.url === "/api/alc/expand-candidates") {
        const body = await readJsonBody(request);
        const rootPath = body.rootPath || defaultRootPath();
        const preferences = await loadRootPreferences(rootPath);
        const result = await scanRelocationCandidates(rootPath, {
          mode: body.mode || "alto",
          targetBytes: body.targetBytes || 0,
          limit: body.limit,
          fastScanMs: body.fastScanMs,
          preferences,
          options: {
            ...DEFAULT_OPTIONS,
            includeProgramFiles: true
          },
          skipDirectories: DEFAULT_OPTIONS.skipDirectories || []
        });
        return sendJson(response, 200, result);
      }

      if (request.method === "POST" && request.url === "/api/alc/relocate") {
        const body = await readJsonBody(request, { limitBytes: 64 * 1024 * 1024 });
        const report = await executeAlcRelocationServer(body.request || {});
        return sendJson(response, 200, report);
      }

      if (request.method === "POST" && request.url === "/api/alc/relocate-job") {
        const body = await readJsonBody(request, { limitBytes: 64 * 1024 * 1024 });
        const job = startAlcRelocationJob(body.request || {});
        return sendJson(response, 202, {
          ok: true,
          jobId: job.jobId,
          operationId: job.operationId,
          progress: job.progress
        });
      }

      if (request.method === "GET" && request.url.startsWith("/api/alc/jobs/")) {
        const jobId = decodeURIComponent(request.url.split("/").pop() || "");
        const job = activeAlcJobs.get(jobId);
        if (!job) {
          return sendJson(response, 404, { error: "Job de limpeza nao encontrado." });
        }
        return sendJson(response, 200, serializeAlcJob(job));
      }

      if (request.method === "POST" && request.url === "/api/alc/cancel") {
        const body = await readJsonBody(request).catch(() => ({}));
        const job = body.jobId ? activeAlcJobs.get(String(body.jobId)) : null;
        const operationId = sanitizeOperationId(body.operationId || body.request?.operationId || job?.operationId);
        if (operationId) {
          activeAlcCancellations.add(operationId);
        }
        return sendJson(response, 200, { ok: true, supported: Boolean(operationId), operationId });
      }

      if (request.method === "POST" && request.url === "/api/open-path") {
        const body = await readJsonBody(request);
        await openSystemPath(body.path);
        return sendJson(response, 200, { ok: true });
      }

      if (request.method !== "GET") {
        return sendJson(response, 405, { error: "Metodo nao suportado." });
      }

      return serveStatic(request, response);
    } catch (error) {
      return sendJson(response, 500, {
        error: error.message || "Erro inesperado no servidor."
      });
    }
  });
}

async function runSrcPipeline(rootPath, options = {}) {
  const addReport = await analyzeDirectory(rootPath, options);
  return buildSrcResult(addReport, options, { saveState: options.saveState !== false });
}

async function* runSrcPipelineProgressive(rootPath, options = {}) {
  for await (const addReport of analyzeDirectoryProgressive(rootPath, options)) {
    const saveState = addReport.progressive?.isFinal && options.saveState !== false;
    yield buildSrcResult(addReport, options, { saveState, streamMode: true });
  }
}

async function buildSrcResult(addReport, options = {}, { saveState = false, streamMode = false } = {}) {
  const isPartial = Boolean(addReport.progressive?.enabled && !addReport.progressive?.isFinal);
  const isTurboInventory = addReport.summary?.inventoryProvider && addReport.summary.inventoryProvider !== "node";
  const preferences = await loadRootPreferences(addReport.rootPath);
  applyPreferencesToAddReport(addReport, preferences);
  const targetFreeBytes = Number(options.targetFreeBytes || preferences.targetFreeBytes || 0);
  const minimumFreeBytes = Number(options.minimumFreeBytes || preferences.minimumFreeBytes || 0);
  const diskStatus = await diskStatusForPath(addReport.rootPath);
  const relocationPlan = generateRelocationPlan(addReport, streamMode ? {
    compact: true,
    candidateLimit: options.areCandidateLimit,
    packageLimit: options.arePackageLimit,
    blockedLimit: options.areBlockedLimit,
    operationLimit: options.areOperationLimit,
    targetFreeBytes
  } : {
    targetFreeBytes
  });
  const shouldBuildContinuousState = !isPartial && (!isTurboInventory || saveState || options.compareState === true);
  const currentState = shouldBuildContinuousState ? buildDirectoryState(addReport) : null;
  const previousState = shouldBuildContinuousState ? await loadPreviousState(addReport.rootPath) : null;
  const continuousState = streamMode && isPartial
    ? minimalContinuousState(addReport)
    : shouldBuildContinuousState
      ? compareDirectoryStates(previousState, currentState)
      : minimalContinuousState(addReport);
  let statePath = null;

  if (saveState && currentState) {
    statePath = await saveCurrentState(addReport.rootPath, currentState);
  }

  const report = streamMode && isPartial
    ? { text: "Relatorio parcial omitido durante streaming para reduzir memoria." }
    : generateSrcReport({
        addReport,
        relocationPlan,
        continuousState
      });

  return {
    ...addReport,
    diskStatus,
    system: "MaidSpace",
    options: {
      ...(addReport.options || {}),
      ...options,
      targetFreeBytes,
      minimumFreeBytes
    },
    modules: {
      add: {
        algorithm: "Grafo",
        status: isPartial ? "parcial" : "concluido",
        summary: addReport.summary
      },
      are: {
        algorithm: "Plano",
        status: isPartial ? "plano_parcial" : "plano_gerado",
        summary: relocationPlan.summary
      },
      alc: {
        algorithm: "Limpeza",
        status: saveState ? "estado_salvo" : "estado_nao_salvo",
        summary: continuousState.summary,
        statePath
      }
    },
    relocationPlan,
    continuousState,
    preferences,
    report
  };
}

function startAlcRelocationJob(request = {}) {
  const operationId = sanitizeOperationId(request.operationId) || createOperationId();
  const jobId = `alc-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  const job = {
    jobId,
    operationId,
    status: "running",
    startedAt: Date.now(),
    updatedAt: Date.now(),
    progress: {
      phase: request.dryRun ? "dry-run" : "start",
      percent: 0,
      movedFiles: 0,
      failedFiles: 0,
      skippedFiles: 0,
      movedBytes: 0,
      targetBytes: Number(request.targetBytes || 0),
      currentFile: ""
    },
    report: null,
    error: null
  };
  activeAlcJobs.set(jobId, job);
  cleanupOldAlcJobs();

  executeAlcRelocationServer({ ...request, operationId }, {
    onProgress(progress) {
      job.progress = {
        ...job.progress,
        ...progress
      };
      job.updatedAt = Date.now();
    }
  }).then((report) => {
    job.status = report.cancelled ? "cancelled" : "completed";
    job.report = report;
    job.progress = {
      ...job.progress,
      phase: report.cancelled ? "cancelled" : "done",
      percent: report.cancelled ? job.progress.percent || 0 : 100,
      movedFiles: report.movedFiles,
      failedFiles: report.failedFiles,
      skippedFiles: report.skippedFiles,
      movedBytes: report.movedBytes,
      targetBytes: report.plannedBytes || job.progress.targetBytes,
      currentFile: report.progress?.currentFile || ""
    };
    job.updatedAt = Date.now();
  }).catch((error) => {
    job.status = "failed";
    job.error = error.message || "Erro inesperado na limpeza.";
    job.progress = {
      ...job.progress,
      phase: "error"
    };
    job.updatedAt = Date.now();
  });

  return job;
}

function serializeAlcJob(job) {
  return {
    jobId: job.jobId,
    operationId: job.operationId,
    status: job.status,
    running: job.status === "running",
    progress: job.progress,
    report: job.report,
    error: job.error,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt
  };
}

function cleanupOldAlcJobs() {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [jobId, job] of activeAlcJobs.entries()) {
    if (job.status !== "running" && job.updatedAt < cutoff) {
      activeAlcJobs.delete(jobId);
    }
  }
}

async function executeAlcRelocationServer(request = {}, runtime = {}) {
  const operationStartedAt = Date.now();
  const planningStartedAt = Date.now();
  const rootPath = request.rootPath || defaultRootPath();
  const root = await realpathOrResolve(rootPath);
  const rootStats = await fs.stat(root);
  if (!rootStats.isDirectory()) {
    throw new Error(`A raiz nao e um diretorio: ${root}`);
  }

  const dryRun = request.dryRun === true;
  const allowPermanentDelete = request.allowPermanentDelete === true;
  let targetKind = String(request.targetKind || "directory").trim().toLowerCase();
  if (!["directory", "trash", "delete", "quarantine"].includes(targetKind)) {
    throw new Error("Destino de limpeza invalido.");
  }
  if (targetKind === "trash") {
    targetKind = "quarantine";
  }

  const operationId = sanitizeOperationId(request.operationId) || createOperationId();
  const quarantineDirectory = quarantineDirectoryFor(operationId);
  const effectiveAction = effectiveActionForTargetKind(targetKind, { allowPermanentDelete });
  const targetDirectory = targetKind === "directory"
    ? await prepareAlcTargetDirectory(request.targetDirectory, root)
    : effectiveAction === "quarantine"
    ? path.join(quarantineDirectory, "files")
    : null;

  const files = Array.isArray(request.files) ? [...request.files] : [];
  const report = {
    targetKind,
    effectiveAction,
    dryRun,
    targetDirectory,
    quarantineDirectory: effectiveAction === "quarantine" ? quarantineDirectory : null,
    manifestPath: null,
    finalManifestPath: null,
    manifestUsedPath: null,
    auditSource: String(request.auditSource || (dryRun ? "simulation" : "direct")),
    auditManifestPath: request.auditManifestPath || null,
    auditedItemCount: Math.max(0, Number(request.auditedItemCount || files.length || 0)),
    auditFingerprint: request.auditFingerprint || null,
    volumeInfo: volumeInfoForRelocation(root, targetDirectory),
    requestedFiles: 0,
    plannedFiles: 0,
    movedFiles: 0,
    failedFiles: 0,
    skippedFiles: 0,
    cancelledFiles: 0,
    cancelled: false,
    plannedBytes: 0,
    movedBytes: 0,
    averageBytesPerSecond: 0,
    waveBytes: Math.max(1, Number(request.waveBytes || DEFAULT_ALC_WAVE_BYTES)),
    waveCount: Math.max(1, Number(request.plannedWaveCount || 1)),
    wavesCompleted: 0,
    waves: [],
    stageTimings: {},
    operations: [],
    progress: {
      currentFile: null,
      completedFiles: 0,
      errorFiles: 0,
      skippedFiles: 0,
      completedBytes: 0
    }
  };
  const seen = new Set();
  const createdDirectories = new Set();
  const targetBytes = Math.max(0, Number(request.targetBytes || 0));
  emitAlcServerProgress(runtime, report, {
    phase: dryRun ? "dry-run" : "planning",
    percent: 0,
    targetBytes
  });

  if (request.expandPlan && targetBytes > 0 && report.movedBytes < targetBytes) {
    const preferences = await loadRootPreferences(rootPath);
    const expansion = await scanRelocationCandidates(root, {
      mode: request.planMode || "alto",
      targetBytes,
      limit: request.limit || 1000000,
      preferences,
      options: {
        ...DEFAULT_OPTIONS,
        includeProgramFiles: true
      },
      skipDirectories: DEFAULT_OPTIONS.skipDirectories || []
    });
    for (const candidate of expansion.candidates || []) {
      files.push({
        relativePath: candidate.path,
        size: candidateBytesServer(candidate),
        userContent: candidate.userImpact === "alto" || candidate.userImpact === "medio",
        risk: candidate.risk,
        reason: candidate.justification,
        deletionDecision: candidate.deletionDecision
      });
    }
  }

  const preparedFiles = [];
  for (const file of files) {
    const prepared = await prepareAlcFileServer(root, file, report, seen, {
      rootPath: root,
      targetKind,
      targetDirectory,
      quarantineDirectory,
      allowPermanentDelete
    });
    if (prepared) {
      preparedFiles.push(prepared);
      report.plannedFiles += 1;
      report.plannedBytes += prepared.operation.sizeBytes;
    }
  }

  const plannedOperations = preparedFiles.map((prepared) => ({
    ...prepared.operation,
    status: "planned"
  }));
  const wavePlan = buildAlcExecutionWavesFromOperations(plannedOperations, {
    waveBytes: report.waveBytes,
    plannedBytes: Math.max(report.plannedBytes, targetBytes),
    plannedFiles: report.plannedFiles
  });
  report.waveBytes = wavePlan.waveBytes;
  report.waveCount = wavePlan.total;
  report.waves = wavePlan.waves;
  const manifest = createOperationManifest({
    operationId,
    dryRun,
    rootPath: root,
    targetKind,
    targetDirectory,
    quarantineDirectory,
    allowPermanentDelete,
    items: [
      ...report.operations.map(serverOperationToManifestItem),
      ...plannedOperations.map(serverOperationToManifestItem)
    ]
  });
  report.manifestPath = await writeOperationManifest(manifest);
  report.manifestUsedPath = report.manifestPath;
  const planningSeconds = secondsSince(planningStartedAt);

  if (dryRun) {
    for (const operation of plannedOperations) {
      pushServerOperation(report, operation);
    }
    const loggingStartedAt = Date.now();
    report.finalManifestPath = await writeOperationManifest(manifest, { final: true });
    report.manifestUsedPath = report.finalManifestPath || report.manifestPath;
    report.auditedItemCount = report.plannedFiles;
    report.wavesCompleted = 0;
    report.stageTimings = buildAlcStageTimings({
      planningSeconds,
      executionSeconds: 0,
      loggingSeconds: secondsSince(loggingStartedAt),
      totalSeconds: secondsSince(operationStartedAt),
      effectiveAction,
      dryRun
    });
    emitAlcServerProgress(runtime, report, {
      phase: "done",
      percent: 100,
      targetBytes: report.plannedBytes
    });
    return report;
  }

  const executionStartedAt = Date.now();
  for (let index = 0; index < preparedFiles.length; index += 1) {
    if (activeAlcCancellations.has(operationId)) {
      report.cancelled = true;
      report.cancelledFiles += preparedFiles.length - index;
      break;
    }
    const prepared = preparedFiles[index];
    report.progress.currentFile = prepared.operation.relativePath;
    emitAlcServerProgress(runtime, report, {
      phase: "moving",
      index,
      total: preparedFiles.length,
      currentFile: prepared.operation.relativePath,
      percent: progressPercent(report.movedBytes, Math.max(report.plannedBytes, targetBytes)),
      targetBytes: Math.max(report.plannedBytes, targetBytes)
    });
    if (effectiveAction === "delete_permanent") {
      await deletePreparedFileServer(prepared, report, manifest);
    } else if (effectiveAction === "quarantine") {
      await movePreparedFileServer(prepared, targetDirectory, report, createdDirectories, manifest, "quarantined", {
        runtime,
        operationId,
        targetBytes: Math.max(report.plannedBytes, targetBytes)
      });
    } else {
      await movePreparedFileServer(prepared, targetDirectory, report, createdDirectories, manifest, effectiveAction === "trash" ? "trashed" : "moved", {
        runtime,
        operationId,
        targetBytes: Math.max(report.plannedBytes, targetBytes)
      });
    }
    report.progress.completedFiles = report.movedFiles;
    report.progress.errorFiles = report.failedFiles;
    report.progress.skippedFiles = report.skippedFiles;
    report.progress.completedBytes = report.movedBytes;
    emitAlcServerProgress(runtime, report, {
      phase: report.cancelled ? "cancelled" : "moving",
      index: index + 1,
      total: preparedFiles.length,
      currentFile: prepared.operation.relativePath,
      percent: progressPercent(report.movedBytes, Math.max(report.plannedBytes, targetBytes)),
      targetBytes: Math.max(report.plannedBytes, targetBytes)
    });
  }
  const executionSeconds = secondsSince(executionStartedAt);
  report.averageBytesPerSecond = executionSeconds > 0 ? Math.round(report.movedBytes / executionSeconds) : 0;

  manifest.status = report.cancelled ? "cancelled" : report.failedFiles > 0 ? "completed_with_errors" : "completed";
  const loggingStartedAt = Date.now();
  report.finalManifestPath = await writeOperationManifest(manifest, { final: true });
  report.manifestUsedPath = report.finalManifestPath || report.manifestPath;
  report.auditedItemCount = report.plannedFiles;
  report.wavesCompleted = report.cancelled
    ? completedAlcWaves(report.movedBytes, report.waveBytes, report.waveCount)
    : report.waveCount;
  report.stageTimings = buildAlcStageTimings({
    planningSeconds,
    executionSeconds,
    loggingSeconds: secondsSince(loggingStartedAt),
    totalSeconds: secondsSince(operationStartedAt),
    effectiveAction,
    dryRun
  });
  activeAlcCancellations.delete(operationId);
  emitAlcServerProgress(runtime, report, {
    phase: report.cancelled ? "cancelled" : "done",
    percent: report.cancelled ? progressPercent(report.movedBytes, Math.max(report.plannedBytes, targetBytes)) : 100,
    targetBytes: Math.max(report.plannedBytes, targetBytes)
  });
  return report;
}

function emitAlcServerProgress(runtime, report, extra = {}) {
  if (typeof runtime?.onProgress !== "function") {
    return;
  }
  const targetBytes = Number(extra.targetBytes || report.plannedBytes || 0);
  const movedBytes = Number(extra.movedBytes ?? report.movedBytes);
  runtime.onProgress({
    phase: extra.phase || "moving",
    currentFile: extra.currentFile ?? report.progress.currentFile ?? "",
    index: Number(extra.index ?? report.progress.completedFiles ?? 0),
    total: Number(extra.total || report.plannedFiles || 0),
    percent: Number.isFinite(extra.percent) ? extra.percent : progressPercent(movedBytes, targetBytes),
    movedFiles: report.movedFiles,
    failedFiles: report.failedFiles,
    skippedFiles: report.skippedFiles,
    cancelledFiles: report.cancelledFiles,
    movedBytes,
    movedHuman: formatBytesServer(movedBytes),
    targetBytes,
    targetHuman: formatBytesServer(targetBytes),
    waveBytes: report.waveBytes,
    waveCount: report.waveCount,
    cancelled: report.cancelled
  });
}

function progressPercent(doneBytes, totalBytes) {
  const total = Number(totalBytes || 0);
  if (total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, (Number(doneBytes || 0) / total) * 100));
}

function secondsSince(startedAt) {
  return Math.max(0, (Date.now() - Number(startedAt || Date.now())) / 1000);
}

function buildAlcStageTimings({ planningSeconds, executionSeconds, loggingSeconds, totalSeconds, effectiveAction, dryRun }) {
  return {
    planning: planningSeconds,
    moving: !dryRun && effectiveAction !== "quarantine" && effectiveAction !== "delete_permanent" ? executionSeconds : 0,
    deleting: !dryRun && effectiveAction === "delete_permanent" ? executionSeconds : 0,
    quarantining: !dryRun && effectiveAction === "quarantine" ? executionSeconds : 0,
    logging: loggingSeconds,
    total: totalSeconds
  };
}

function buildAlcExecutionWavesFromOperations(operations = [], options = {}) {
  const waveBytes = Math.max(1, Number(options.waveBytes || DEFAULT_ALC_WAVE_BYTES));
  const plannedBytes = Math.max(0, Number(options.plannedBytes || 0));
  const plannedFiles = Math.max(0, Number(options.plannedFiles || operations.length || 0));
  const waves = [];
  let current = { index: 1, files: 0, bytes: 0 };
  for (const operation of operations) {
    const bytes = Math.max(0, Number(operation.sizeBytes || operation.size || 0));
    if (current.files > 0 && (current.bytes + bytes > waveBytes || current.files >= MAX_ALC_WAVE_FILES)) {
      waves.push(current);
      current = { index: waves.length + 1, files: 0, bytes: 0 };
    }
    current.files += 1;
    current.bytes += bytes;
  }
  if (current.files > 0 || !waves.length) {
    waves.push(current);
  }
  const estimatedByBytes = Math.max(1, Math.ceil(plannedBytes / waveBytes));
  const total = Math.max(waves.length, estimatedByBytes);
  return {
    total,
    waveBytes,
    plannedBytes,
    plannedFiles,
    waves
  };
}

function completedAlcWaves(movedBytes, waveBytes, waveCount) {
  const completed = Math.floor(Math.max(0, Number(movedBytes || 0)) / Math.max(1, Number(waveBytes || DEFAULT_ALC_WAVE_BYTES)));
  return Math.max(0, Math.min(Number(waveCount || 1), completed));
}

function volumeInfoForRelocation(root, targetDirectory) {
  if (!targetDirectory) {
    return {
      known: false,
      sameVolume: null,
      strategy: "managed",
      sourceRoot: path.parse(root).root || null,
      destinationRoot: null,
      message: "destino gerenciado pelo sistema ou quarentena"
    };
  }
  const sourceRoot = path.parse(root).root;
  const destinationRoot = path.parse(targetDirectory).root;
  const known = Boolean(sourceRoot && destinationRoot);
  const sameVolume = known ? sourceRoot.toLowerCase() === destinationRoot.toLowerCase() : null;
  return {
    known,
    sameVolume,
    strategy: sameVolume === true ? "rename" : sameVolume === false ? "copy_then_remove" : "unknown",
    sourceRoot,
    destinationRoot,
    message: !known
      ? "nao foi possivel confirmar o volume"
      : sameVolume
        ? "mesmo volume: move/rename tende a ser rapido"
        : "volumes diferentes: copia e remocao podem demorar mais"
  };
}

function sanitizeOperationId(value) {
  const text = String(value || "").trim();
  return /^[0-9A-Za-z._-]{6,120}$/.test(text) ? text : "";
}

async function prepareAlcTargetDirectory(rawTargetDirectory, root) {
  const value = String(rawTargetDirectory || "").trim();
  if (!value) {
    throw new Error("Escolha uma pasta de destino para a limpeza.");
  }
  const resolved = path.resolve(value);
  if (resolved === root || pathIsInside(resolved, root)) {
    throw new Error("O destino esta dentro da raiz varrida; escolha uma pasta fora dela para liberar espaco.");
  }
  const blockedReason = protectedTargetDirectoryReasonServer(resolved);
  if (blockedReason) {
    throw new Error(blockedReason);
  }
  await fs.mkdir(value, { recursive: true });
  const target = await realpathOrResolve(value);
  if (target === root || pathIsInside(target, root)) {
    throw new Error("O destino esta dentro da raiz varrida; escolha uma pasta fora dela para liberar espaco.");
  }
  const targetBlockedReason = protectedTargetDirectoryReasonServer(target);
  if (targetBlockedReason) {
    throw new Error(targetBlockedReason);
  }
  return target;
}

async function prepareAlcFileServer(root, file = {}, report, seen, context = {}) {
  const relativePath = String(file.relativePath || file.path || "");
  const manifestItem = buildOperationItem(file, {
    ...context,
    rootPath: root
  });
  const operation = {
    id: manifestItem.id,
    relativePath,
    originalPath: manifestItem.originalPath,
    sizeBytes: Number(file.size || file.sizeBytes || 0),
    status: "error",
    action: manifestItem.action,
    reason: manifestItem.reason,
    risk: manifestItem.risk,
    plannedDestination: manifestItem.plannedDestination,
    targetPath: null,
    userContent: Boolean(file.userContent),
    error: null
  };

  if (manifestItem.status === "skipped") {
    operation.status = "skipped";
    operation.error = manifestItem.error;
    report.skippedFiles += 1;
    pushServerOperation(report, operation);
    return null;
  }

  let relative;
  try {
    relative = safeRelativePathServer(relativePath);
  } catch (error) {
    operation.error = error.message;
    report.failedFiles += 1;
    pushServerOperation(report, operation);
    return null;
  }

  const relativeKey = normalizeServerPath(relative);
  if (seen.has(relativeKey)) {
    return null;
  }
  seen.add(relativeKey);
  report.requestedFiles += 1;

  const source = path.resolve(root, relative);
  if (!pathIsInside(source, root) && source !== root) {
    operation.error = "Arquivo fora da raiz varrida.";
    report.failedFiles += 1;
    pushServerOperation(report, operation);
    return null;
  }

  let sourceReal;
  let stats;
  try {
    sourceReal = await fs.realpath(source);
    if (!pathIsInside(sourceReal, root) && sourceReal !== root) {
      throw new Error("Arquivo fora da raiz varrida.");
    }
    stats = await fs.stat(sourceReal);
  } catch (error) {
    operation.error = `Arquivo indisponivel: ${error.message}`;
    report.failedFiles += 1;
    pushServerOperation(report, operation);
    return null;
  }

  if (!stats.isFile()) {
    operation.status = "skipped";
    operation.error = "A limpeza move apenas arquivos.";
    report.skippedFiles += 1;
    pushServerOperation(report, operation);
    return null;
  }

  operation.sizeBytes = stats.size;
  operation.originalPath = sourceReal;
  operation.plannedDestination = buildOperationItem({
    ...file,
    relativePath: relative,
    size: stats.size
  }, {
    ...context,
    rootPath: root
  }).plannedDestination;
  return {
    source: sourceReal,
    relative,
    operation
  };
}

async function movePreparedFileServer(prepared, targetDirectory, report, createdDirectories, manifest, successStatus = "moved", progressContext = {}) {
  const destination = uniqueDestinationServer(path.join(targetDirectory, prepared.relative));
  const parent = path.dirname(destination);
  try {
    if (normalizeServerPath(prepared.source) === normalizeServerPath(destination)) {
      prepared.operation.status = "skipped";
      prepared.operation.error = "Origem e destino sao iguais.";
      report.skippedFiles += 1;
      recordOperationResult(manifest, prepared.operation.id || prepared.operation.relativePath, {
        status: "skipped",
        finalPath: prepared.source,
        error: prepared.operation.error
      });
      pushServerOperation(report, prepared.operation);
      return;
    }
    if (!createdDirectories.has(parent)) {
      await fs.mkdir(parent, { recursive: true });
      createdDirectories.add(parent);
    }
    await moveFileServer(prepared.source, destination, {
      shouldCancel: () => Boolean(progressContext.operationId && activeAlcCancellations.has(progressContext.operationId)),
      onProgress(copiedBytes) {
        const targetBytes = Number(progressContext.targetBytes || report.plannedBytes || 0);
        emitAlcServerProgress(progressContext.runtime, report, {
          phase: "moving",
          currentFile: prepared.operation.relativePath,
          movedBytes: report.movedBytes + Number(copiedBytes || 0),
          percent: progressPercent(report.movedBytes + Number(copiedBytes || 0), targetBytes),
          targetBytes
        });
      }
    });
    prepared.operation.status = "success";
    prepared.operation.action = successStatus;
    prepared.operation.targetPath = destination;
    report.movedFiles += 1;
    report.movedBytes += prepared.operation.sizeBytes;
    recordOperationResult(manifest, prepared.operation.id || prepared.operation.relativePath, {
      status: "success",
      finalPath: destination
    });
  } catch (error) {
    if (error.message === "Cancelado." || Boolean(progressContext.operationId && activeAlcCancellations.has(progressContext.operationId))) {
      prepared.operation.status = "cancelled";
      prepared.operation.error = "Cancelado.";
      report.cancelled = true;
      report.cancelledFiles += 1;
      recordOperationResult(manifest, prepared.operation.id || prepared.operation.relativePath, {
        status: "cancelled",
        error: prepared.operation.error
      });
    } else {
      prepared.operation.status = "error";
      prepared.operation.error = error.message;
      report.failedFiles += 1;
      recordOperationResult(manifest, prepared.operation.id || prepared.operation.relativePath, {
        status: "error",
        error: error.message
      });
    }
  }
  pushServerOperation(report, prepared.operation);
}

async function deletePreparedFileServer(prepared, report, manifest) {
  try {
    await fs.rm(prepared.source, { force: true });
    prepared.operation.status = "success";
    prepared.operation.action = "delete_permanent";
    prepared.operation.targetPath = "excluido";
    report.movedFiles += 1;
    report.movedBytes += prepared.operation.sizeBytes;
    recordOperationResult(manifest, prepared.operation.id || prepared.operation.relativePath, {
      status: "success",
      finalPath: "excluido"
    });
  } catch (error) {
    prepared.operation.status = "error";
    prepared.operation.error = error.message;
    report.failedFiles += 1;
    recordOperationResult(manifest, prepared.operation.id || prepared.operation.relativePath, {
      status: "error",
      error: error.message
    });
  }
  pushServerOperation(report, prepared.operation);
}

async function moveFileServer(source, destination, options = {}) {
  try {
    await fs.rename(source, destination);
  } catch (renameError) {
    if (renameError?.code !== "EXDEV") {
      throw renameError;
    }
    await copyFileWithProgressServer(source, destination, options);
    try {
      await fs.rm(source, { force: true });
    } catch (removeError) {
      await fs.rm(destination, { force: true }).catch(() => {});
      throw removeError;
    }
  }
}

async function copyFileWithProgressServer(source, destination, options = {}) {
  await new Promise((resolve, reject) => {
    const read = fsSync.createReadStream(source, { highWaterMark: 8 * 1024 * 1024 });
    const write = fsSync.createWriteStream(destination, { flags: "wx" });
    let copiedBytes = 0;
    let lastEmitAt = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      read.destroy();
      write.destroy();
      try {
        fsSync.rmSync(destination, { force: true });
      } catch {}
      reject(error);
    };

    read.on("data", (chunk) => {
      if (typeof options.shouldCancel === "function" && options.shouldCancel()) {
        fail(new Error("Cancelado."));
        return;
      }
      copiedBytes += chunk.length;
      const now = Date.now();
      if (typeof options.onProgress === "function" && now - lastEmitAt >= 250) {
        lastEmitAt = now;
        options.onProgress(copiedBytes);
      }
    });
    read.on("error", fail);
    write.on("error", fail);
    write.on("finish", () => {
      if (settled) {
        return;
      }
      settled = true;
      if (typeof options.onProgress === "function") {
        options.onProgress(copiedBytes);
      }
      resolve();
    });
    read.pipe(write);
  });
}

function safeRelativePathServer(rawPath) {
  if (!rawPath) {
    throw new Error("Caminho vazio.");
  }
  const normalized = String(rawPath).replace(/\\/g, "/");
  if (normalized.includes("\0")) {
    throw new Error("Caminho invalido.");
  }
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Caminho absoluto nao e aceito na limpeza.");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Caminho relativo inseguro.");
  }
  if (parts.some((part) => part.includes(":"))) {
    throw new Error("Caminho com fluxo alternativo ou caractere invalido.");
  }
  return path.join(...parts);
}

function protectedTargetDirectoryReasonServer(targetDirectory) {
  const target = path.resolve(targetDirectory);
  const root = path.parse(target).root;
  if (target === root) {
    return "Escolha uma pasta de destino, nao a raiz do volume.";
  }
  const relative = normalizeServerPath(path.relative(root, target));
  if (
    relative === "windows"
    || relative.startsWith("windows/")
    || relative === "program files"
    || relative.startsWith("program files/")
    || relative === "program files (x86)"
    || relative.startsWith("program files (x86)/")
    || relative === "system volume information"
    || relative.startsWith("system volume information/")
    || relative === "$recycle.bin"
    || relative.startsWith("$recycle.bin/")
    || relative === "programdata/microsoft"
    || relative.startsWith("programdata/microsoft/")
  ) {
    return "Escolha uma pasta de destino fora de diretorios do Windows, programas ou sistema.";
  }
  return null;
}

function pathIsInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function realpathOrResolve(rawPath) {
  const resolved = path.resolve(rawPath);
  return fs.realpath(resolved).catch(() => resolved);
}

function normalizeServerPath(value) {
  return String(value || "").replace(/\\/g, "/").toLowerCase();
}

function candidateBytesServer(candidate) {
  return Number(candidate?.packageBytes || candidate?.sizeBytes || candidate?.bytes || 0);
}

function uniqueDestinationServer(base) {
  if (!fsSync.existsSync(base)) {
    return base;
  }
  const parent = path.dirname(base);
  const fileName = path.basename(base);
  for (let index = 1; index < 10000; index += 1) {
    const candidate = path.join(parent, `${fileName}.maidspace-${index}`);
    if (!fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return path.join(parent, `${fileName}.maidspace-final`);
}

function pushServerOperation(report, operation) {
  if (report.operations.length < 5000) {
    report.operations.push(operation);
  }
}

function serverOperationToManifestItem(operation = {}) {
  return {
    id: operation.id || normalizeServerPath(operation.relativePath),
    originalPath: operation.originalPath || operation.relativePath || "",
    relativePath: operation.relativePath || "",
    sizeBytes: Number(operation.sizeBytes || 0),
    action: operation.action || operation.proposedAction || "move",
    proposedAction: operation.action || operation.proposedAction || "move",
    reason: operation.reason || operation.error || "selecionado para limpeza",
    risk: operation.risk || null,
    plannedDestination: operation.plannedDestination || null,
    status: normalizeManifestStatus(operation.status),
    error: operation.error || null,
    finalPath: operation.targetPath || null
  };
}

function normalizeManifestStatus(status) {
  if (status === "failed") {
    return "error";
  }
  if (status === "moved" || status === "deleted" || status === "trashed" || status === "quarantined") {
    return "success";
  }
  return status || "planned";
}

async function openSystemPath(rawPath) {
  const target = String(rawPath || "").trim();
  if (!target) {
    throw new Error("Caminho vazio.");
  }
  const resolved = path.resolve(target);
  const exists = fsSync.existsSync(resolved);
  const openTarget = exists ? resolved : path.dirname(resolved);
  if (process.platform === "win32") {
    childProcess.spawn("explorer", [openTarget], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return;
  }
  if (process.platform === "darwin") {
    childProcess.spawn("open", [openTarget], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  childProcess.spawn("xdg-open", [openTarget], { detached: true, stdio: "ignore" }).unref();
}

function minimalContinuousState(addReport) {
  return {
    mode: "parcial_progressivo",
    summary: {
      newFiles: addReport.summary?.files || 0,
      modifiedFiles: 0,
      removedFiles: 0,
      riskChangedFiles: 0,
      dependencyChangedFiles: 0,
      reanalysisNeeded: false
    },
    changes: []
  };
}

async function streamSrcPipeline(response, rootPath, options = {}) {
  response.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });

  const startedAt = Date.now();
  let latestProgress = null;
  let latestScanProgress = null;
  let latestResult = null;
  let finalReport = null;
  const heartbeat = setInterval(() => {
    if (!response.writableEnded && !response.destroyed) {
      response.write(`${JSON.stringify({
        type: "heartbeat",
        elapsedMs: Date.now() - startedAt,
        message: latestProgress
          ? `ultima profundidade concluida: ${latestProgress.currentDepth}/${latestProgress.maxDepth}`
          : "preparando varredura",
        currentDepth: latestProgress?.currentDepth || null,
        maxDepth: latestProgress?.maxDepth || null,
        step: latestProgress?.step || null,
        totalSteps: latestProgress?.totalSteps || null,
        scan: latestScanProgress
      })}\n`);
    }
  }, 5000);

  try {
    for await (const result of runSrcPipelineProgressive(rootPath, {
      ...options,
      onScanProgress: (progress) => {
        latestScanProgress = progress;
      }
    })) {
      latestResult = result;
      latestProgress = result.progressive || latestProgress;
      if (result.progressive?.isFinal) {
        finalReport = await writeScanFinalReport(buildServerScanFinalReport("concluido", result, {
          startedAt,
          latestScanProgress
        }));
      }
      await writeNdjson(response, {
        type: "snapshot",
        progress: result.progressive,
        result: compactStreamResult(result, options),
        finalReport
      });
    }
    if (!finalReport && latestResult) {
      finalReport = await writeScanFinalReport(buildServerScanFinalReport("concluido", latestResult, {
        startedAt,
        latestScanProgress
      }));
    }
    await writeNdjson(response, { type: "done", finalReport });
  } catch (error) {
    finalReport = await writeScanFinalReport(buildServerScanFinalReport("falhou", latestResult, {
      startedAt,
      latestScanProgress,
      error: error.message || "Erro inesperado na varredura progressiva."
    })).catch(() => null);
    await writeNdjson(response, {
      type: "error",
      error: error.message || "Erro inesperado na varredura progressiva.",
      finalReport
    });
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
}

function buildServerScanFinalReport(status, result, context = {}) {
  const summary = result?.summary || {};
  const totalSeconds = Math.max(0, (Date.now() - Number(context.startedAt || Date.now())) / 1000);
  const scanningSeconds = Math.max(0, Number(context.latestScanProgress?.elapsedMs || 0) / 1000);
  const analyzingSeconds = Math.max(0, totalSeconds - scanningSeconds);
  const processedBytes = Number(summary.totalBytes || 0);
  return {
    status,
    filesAnalyzed: Number(summary.analyzedFiles || summary.files || 0),
    filesProcessed: Number(summary.files || 0),
    filesMoved: 0,
    filesSkipped: Array.isArray(result?.skipped) ? result.skipped.length : Number(summary.skipped || 0),
    errors: context.error ? 1 : 0,
    warnings: Array.isArray(result?.warnings) ? result.warnings.length : Number(summary.warnings || 0),
    processedBytes,
    processedHuman: formatBytesServer(processedBytes),
    totalSeconds,
    stageTimings: {
      scanning: scanningSeconds,
      analyzing: analyzingSeconds,
      logging: 0,
      total: totalSeconds
    },
    averageSpeedBytesPerSecond: totalSeconds > 0 ? processedBytes / totalSeconds : 0,
    logPath: null,
    error: context.error || null
  };
}

async function writeScanFinalReport(report) {
  const startedAt = Date.now();
  const directory = operationLogDirectory();
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `${createOperationId()}-scan-report.json`);
  report.logPath = filePath;
  report.stageTimings.logging = Math.max(0, (Date.now() - startedAt) / 1000);
  report.stageTimings.total = Number(report.totalSeconds || 0) + report.stageTimings.logging;
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return report;
}

async function writeNdjson(response, payload) {
  const line = `${JSON.stringify(payload)}\n`;
  if (!response.write(line)) {
    await once(response, "drain");
  }
}

function compactStreamResult(result, options = {}) {
  const shouldCompactFinal = result.progressive?.isFinal
    && options.compactFinal !== false
    && (
      options.compactFinal === true
      || result.progressive?.turbo
      || (result.summary?.files || 0) > 50000
      || (result.nodes || []).length > 50000
    );

  if (result.progressive?.isFinal && !shouldCompactFinal) {
    return result;
  }

  const nodeLimit = clampNumber(options.streamNodeLimit, 120, 200000, 15000);
  const edgeLimit = clampNumber(options.streamEdgeLimit, 200, 500000, 50000);
  const compactNodes = selectCompactNodes(result.nodes || [], result.progressive, nodeLimit);
  const compactNodeIds = new Set(compactNodes.map((node) => node.id));
  const compactEdges = (result.edges || [])
    .filter((edge) => compactNodeIds.has(edge.source) && compactNodeIds.has(edge.target))
    .slice(0, edgeLimit);
  const compactGraphViews = buildGraphViews(compactNodes, compactNodes.filter((node) => node.kind === "file"), compactEdges);
  const compactRelocationPlan = compactPlan(result.relocationPlan);

  return {
    ...result,
    nodes: compactNodes,
    edges: compactEdges,
    graphViews: compactGraphViews,
    relocationPlan: compactRelocationPlan,
    skipped: (result.skipped || []).slice(0, 300),
    warnings: [
      ...(result.warnings || []),
      `stream compactado: exibindo ${compactNodes.length}/${(result.nodes || []).length} nos e ${compactEdges.length}/${(result.edges || []).length} arestas; totais do grafo e do plano permanecem calculados sobre a varredura completa.`
    ],
    uiLimits: {
      compacted: true,
      nodesShown: compactNodes.length,
      totalNodes: (result.nodes || []).length,
      edgesShown: compactEdges.length,
      totalEdges: (result.edges || []).length,
      nodeLimit,
      edgeLimit
    }
  };
}

function selectCompactNodes(nodes, progressive, limit) {
  const files = nodes.filter((node) => node.kind === "file");
  const directories = nodes.filter((node) => node.kind === "directory");
  const selected = new Map();
  const newNodePaths = new Set(progressive?.newNodes || []);

  const newNodes = files
    .filter((node) => newNodePaths.has(node.relativePath))
    .sort((a, b) => streamNodeScore(b) - streamNodeScore(a) || String(a.relativePath).localeCompare(String(b.relativePath)))
    .slice(0, Math.min(limit, 500));

  for (const node of newNodes) {
    selected.set(node.id, node);
  }

  const ranked = files
    .slice()
    .sort((a, b) => streamNodeScore(b) - streamNodeScore(a) || String(a.relativePath).localeCompare(String(b.relativePath)));

  for (const node of ranked) {
    if (selected.size >= limit) {
      break;
    }
    selected.set(node.id, node);
  }

  const topDirectories = new Set(Array.from(selected.values()).map((node) => topDirectory(node.relativePath)));
  for (const directory of directories) {
    if (selected.size >= limit + 200) {
      break;
    }
    if (topDirectories.has(topDirectory(directory.relativePath))) {
      selected.set(directory.id, directory);
    }
  }

  return Array.from(selected.values());
}

function streamNodeScore(node) {
  const risk = { critico: 500000, alto: 300000, medio: 120000, baixo: 40000 }[node.risk] || 0;
  const dependency = ((node.incoming || 0) * 1200) + ((node.outgoing || 0) * 600) + ((node.impactCount || 0) * 1800);
  const decision = node.deletionDecision === "pode_apagar" || node.deletionDecision === "inutil_provavel" ? 90000 : 0;
  const size = Math.min(120000, Math.log2(Math.max(1, node.size || 0)) * 5000);
  const recentDepth = Math.max(0, Number(node.scanDepth || 0)) * 20;
  return risk + dependency + decision + size + recentDepth;
}

function compactPlan(plan) {
  if (!plan) {
    return plan;
  }

  const spaceModes = {};
  for (const [key, mode] of Object.entries(plan.spaceModes || {})) {
    spaceModes[key] = {
      ...mode,
      packages: (mode.packages || []).slice(0, 80),
      candidates: (mode.candidates || []).slice(0, 160)
    };
  }

  return {
    ...plan,
    spaceModes,
    candidatesByMode: {
      baixo: (plan.candidatesByMode?.baixo || []).slice(0, 160),
      medio: (plan.candidatesByMode?.medio || []).slice(0, 160),
      alto: (plan.candidatesByMode?.alto || []).slice(0, 160)
    },
    blockedFiles: (plan.blockedFiles || []).slice(0, 240),
    operations: (plan.operations || []).slice(0, 240),
    groups: compactGroups(plan.groups || {})
  };
}

function compactGroups(groups) {
  return Object.fromEntries(Object.entries(groups).map(([key, items]) => [
    key,
    Array.isArray(items) ? items.slice(0, 80) : items
  ]));
}

function topDirectory(relativePath) {
  const normalized = String(relativePath || ".").replace(/\\/g, "/");
  if (!normalized || normalized === "." || !normalized.includes("/")) {
    return ".";
  }
  return normalized.split("/")[0];
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function startServer({ port = readPort(), host = "127.0.0.1" } = {}) {
  const server = createAppServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const resolvedPort = typeof address === "object" ? address.port : port;
      const url = `http://${host}:${resolvedPort}`;
      console.log(`MaidSpace fallback rodando em ${url}`);
      resolve({ server, url, port: resolvedPort, host });
    });
  });
}

if (require.main === module) {
  startServer({ port: readPort(), host: "127.0.0.1" }).catch((error) => {
    console.error(error.message || error);
    process.exitCode = 1;
  });
}

function readPort() {
  const portArgIndex = process.argv.indexOf("--port");
  if (portArgIndex !== -1 && process.argv[portArgIndex + 1]) {
    return Number(process.argv[portArgIndex + 1]);
  }
  return Number(process.env.PORT || 4173);
}

function defaultRootPath() {
  if (process.platform === "win32") {
    return `${process.env.SystemDrive || "C:"}\\`;
  }
  return "/";
}

async function diskStatusForPath(rootPath) {
  const resolved = path.resolve(rootPath || defaultRootPath());
  try {
    const stats = await fs.statfs(resolved);
    const freeBytes = Number(stats.bavail || stats.bfree || 0) * Number(stats.bsize || 0);
    const totalBytes = Number(stats.blocks || 0) * Number(stats.bsize || 0);
    return {
      available: true,
      rootPath: resolved,
      freeBytes,
      totalBytes,
      freeHuman: formatBytesServer(freeBytes),
      totalHuman: formatBytesServer(totalBytes),
      checkedAt: new Date().toISOString()
    };
  } catch (error) {
    return {
      available: false,
      rootPath: resolved,
      freeBytes: 0,
      totalBytes: 0,
      error: error.message || String(error),
      checkedAt: new Date().toISOString()
    };
  }
}

function formatBytesServer(bytes) {
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

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requestedPath = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const absolutePath = path.normalize(path.join(publicDirectory, requestedPath));
  const relativeToPublic = path.relative(publicDirectory, absolutePath);

  if (relativeToPublic.startsWith("..") || path.isAbsolute(relativeToPublic)) {
    return sendJson(response, 403, { error: "Caminho estatico invalido." });
  }

  try {
    const content = await fs.readFile(absolutePath);
    response.writeHead(200, {
      "Content-Type": contentTypeFor(absolutePath),
      "Cache-Control": "no-store"
    });
    response.end(content);
  } catch (error) {
    sendJson(response, 404, { error: "Arquivo nao encontrado." });
  }
}

function readJsonBody(request, { limitBytes = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", (chunk) => {
      data += chunk;
      if (data.length > limitBytes) {
        request.destroy();
        reject(new Error("Corpo da requisicao muito grande."));
      }
    });
    request.on("end", () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (error) {
        reject(new Error("JSON invalido."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  };
  return types[extension] || "application/octet-stream";
}

module.exports = {
  createAppServer,
  startServer,
  runSrcPipeline,
  runSrcPipelineProgressive
};
