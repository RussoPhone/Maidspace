const http = require("node:http");
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

const rootDirectory = __dirname;
const publicDirectory = path.join(rootDirectory, "public");

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
        algorithm: "A.D.D",
        status: isPartial ? "parcial" : "concluido",
        summary: addReport.summary
      },
      are: {
        algorithm: "A.R.E",
        status: isPartial ? "plano_parcial" : "plano_gerado",
        summary: relocationPlan.summary
      },
      alc: {
        algorithm: "A.L.C",
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

async function executeAlcRelocationServer(request = {}) {
  const rootPath = request.rootPath || defaultRootPath();
  const root = await realpathOrResolve(rootPath);
  const rootStats = await fs.stat(root);
  if (!rootStats.isDirectory()) {
    throw new Error(`A raiz nao e um diretorio: ${root}`);
  }

  const targetKind = String(request.targetKind || "directory").trim().toLowerCase();
  if (!["directory", "trash", "delete"].includes(targetKind)) {
    throw new Error("Destino A.L.C invalido.");
  }
  if (targetKind === "trash") {
    throw new Error("Lixeira esta disponivel apenas no app desktop nativo. Use Excluir para liberar espaco ou Mover para preservar os arquivos.");
  }

  const targetDirectory = targetKind === "directory"
    ? await prepareAlcTargetDirectory(request.targetDirectory, root)
    : null;

  const files = Array.isArray(request.files) ? request.files : [];
  const report = {
    targetKind,
    targetDirectory,
    requestedFiles: 0,
    movedFiles: 0,
    failedFiles: 0,
    skippedFiles: 0,
    cancelledFiles: 0,
    cancelled: false,
    movedBytes: 0,
    operations: []
  };
  const seen = new Set();
  const createdDirectories = new Set();
  const targetBytes = Math.max(0, Number(request.targetBytes || 0));
  const executeFile = async (file) => {
    const prepared = await prepareAlcFileServer(root, file, report, seen);
    if (!prepared) {
      return;
    }
    if (targetKind === "delete") {
      await deletePreparedFileServer(prepared, report);
    } else {
      await movePreparedFileServer(prepared, targetDirectory, report, createdDirectories);
    }
  };

  for (const file of files) {
    await executeFile(file);
  }

  if (request.expandPlan && targetBytes > 0 && report.movedBytes < targetBytes) {
    const preferences = await loadRootPreferences(rootPath);
    const expansion = await scanRelocationCandidates(root, {
      mode: request.planMode || "alto",
      targetBytes: targetBytes - report.movedBytes,
      limit: request.limit || 1000000,
      preferences,
      options: {
        ...DEFAULT_OPTIONS,
        includeProgramFiles: true
      },
      skipDirectories: DEFAULT_OPTIONS.skipDirectories || []
    });
    for (const candidate of expansion.candidates || []) {
      if (report.movedBytes >= targetBytes) {
        break;
      }
      await executeFile({
        relativePath: candidate.path,
        size: candidateBytesServer(candidate),
        userContent: candidate.userImpact === "alto" || candidate.userImpact === "medio"
      });
    }
  }

  return report;
}

async function prepareAlcTargetDirectory(rawTargetDirectory, root) {
  const value = String(rawTargetDirectory || "").trim();
  if (!value) {
    throw new Error("Escolha uma pasta de destino para o A.L.C.");
  }
  await fs.mkdir(value, { recursive: true });
  const target = await realpathOrResolve(value);
  if (pathIsInside(target, root) || target === root) {
    throw new Error("O destino esta dentro da raiz varrida; escolha uma pasta fora dela para liberar espaco.");
  }
  return target;
}

async function prepareAlcFileServer(root, file = {}, report, seen) {
  const relativePath = String(file.relativePath || file.path || "");
  const operation = {
    relativePath,
    sizeBytes: Number(file.size || file.sizeBytes || 0),
    status: "failed",
    targetPath: null,
    userContent: Boolean(file.userContent),
    error: null
  };

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
    operation.error = "A.L.C fallback move apenas arquivos.";
    report.skippedFiles += 1;
    pushServerOperation(report, operation);
    return null;
  }

  operation.sizeBytes = stats.size;
  return {
    source: sourceReal,
    relative,
    operation
  };
}

async function movePreparedFileServer(prepared, targetDirectory, report, createdDirectories) {
  const destination = uniqueDestinationServer(path.join(targetDirectory, prepared.relative));
  const parent = path.dirname(destination);
  try {
    if (!createdDirectories.has(parent)) {
      await fs.mkdir(parent, { recursive: true });
      createdDirectories.add(parent);
    }
    await moveFileServer(prepared.source, destination);
    prepared.operation.status = "moved";
    prepared.operation.targetPath = destination;
    report.movedFiles += 1;
    report.movedBytes += prepared.operation.sizeBytes;
  } catch (error) {
    prepared.operation.status = "failed";
    prepared.operation.error = error.message;
    report.failedFiles += 1;
  }
  pushServerOperation(report, prepared.operation);
}

async function deletePreparedFileServer(prepared, report) {
  try {
    await fs.rm(prepared.source, { force: true });
    prepared.operation.status = "deleted";
    prepared.operation.targetPath = "excluido";
    report.movedFiles += 1;
    report.movedBytes += prepared.operation.sizeBytes;
  } catch (error) {
    prepared.operation.status = "failed";
    prepared.operation.error = error.message;
    report.failedFiles += 1;
  }
  pushServerOperation(report, prepared.operation);
}

async function moveFileServer(source, destination) {
  try {
    await fs.rename(source, destination);
  } catch (renameError) {
    await fs.copyFile(source, destination);
    try {
      await fs.rm(source, { force: true });
    } catch (removeError) {
      await fs.rm(destination, { force: true }).catch(() => {});
      throw removeError;
    }
    if (renameError?.code && renameError.code !== "EXDEV") {
      return;
    }
  }
}

function safeRelativePathServer(rawPath) {
  if (!rawPath) {
    throw new Error("Caminho vazio.");
  }
  const normalized = String(rawPath).replace(/\\/g, "/");
  if (path.isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Caminho absoluto nao e aceito pelo A.L.C.");
  }
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) {
    throw new Error("Caminho relativo inseguro.");
  }
  return path.join(...parts);
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
      latestProgress = result.progressive || latestProgress;
      await writeNdjson(response, {
        type: "snapshot",
        progress: result.progressive,
        result: compactStreamResult(result, options)
      });
    }
    await writeNdjson(response, { type: "done" });
  } catch (error) {
    await writeNdjson(response, {
      type: "error",
      error: error.message || "Erro inesperado na varredura progressiva."
    });
  } finally {
    clearInterval(heartbeat);
    response.end();
  }
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
      `stream compactado: exibindo ${compactNodes.length}/${(result.nodes || []).length} nos e ${compactEdges.length}/${(result.edges || []).length} arestas; totais do A.D.D/A.R.E permanecem calculados sobre a varredura completa.`
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
