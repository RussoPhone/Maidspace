const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { analyzeDirectory } = require("../src/add/analyzer");
const { generateRelocationPlan } = require("../src/are/planner");
const { applyPreferencesToAddReport } = require("../src/alc/preferences");
const {
  buildOperationItem,
  createOperationManifest,
  isProtectedPath,
  recordOperationResult,
  unsafeRelativePathReason
} = require("../src/alc/operationManifest");
const { createAppServer, runSrcPipeline, runSrcPipelineProgressive } = require("../server");

const testDataDir = path.join(os.tmpdir(), `maidspace-test-data-${process.pid}`);
process.env.MAIDSPACE_DATA_DIR = testDataDir;
test.after(async () => {
  await fs.rm(testDataDir, { recursive: true, force: true });
});

test("Grafo classifica dicente, docente, isolado e protegido", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "src-add-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "app.js"), "import { helper } from './lib.js';\nimport './style.css';\nhelper();\n");
  await fs.writeFile(path.join(root, "src", "lib.js"), "export function helper() { return true; }\n");
  await fs.writeFile(path.join(root, "src", "style.css"), "body { color: #111; }\n");
  await fs.writeFile(path.join(root, "src", "orphan.txt"), "sem dependencia\n");
  await fs.writeFile(path.join(root, "src", "recent.tmp"), "temporario\n");
  await fs.writeFile(path.join(root, "src", "old.log"), "log antigo\n");
  await fs.writeFile(path.join(root, "package.json"), "{\"scripts\":{\"start\":\"node src/app.js\"}}\n");
  const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  await fs.utimes(path.join(root, "src", "orphan.txt"), oldDate, oldDate);
  await fs.utimes(path.join(root, "src", "old.log"), oldDate, oldDate);

  const result = await analyzeDirectory(root, {
    scanEngine: "node",
    dependencyMode: "full",
    maxFiles: 100,
    maxDepth: 5,
    maxFileSizeBytes: 128 * 1024
  });

  const byPath = new Map(result.nodes.map((node) => [node.relativePath, node]));

  assert.equal(result.summary.files, 7);
  assert.equal(result.summary.edges, 2);
  assert.equal(byPath.get("src/app.js").classification, "dicente");
  assert.equal(byPath.get("src/lib.js").classification, "docente");
  assert.equal(byPath.get("src/lib.js").impactCount, 1);
  assert.equal(byPath.get("src/lib.js").deletionDecision, "averiguar");
  assert.equal(byPath.get("src/style.css").classification, "docente");
  assert.equal(byPath.get("src/orphan.txt").classification, "isolado");
  assert.equal(byPath.get("src/orphan.txt").risk, "baixo");
  assert.equal(byPath.get("src/orphan.txt").deletionDecision, "inutil_provavel");
  assert.equal(byPath.get("src/orphan.txt").utilityStatus, "baixo_uso");
  assert.equal(byPath.get("src/orphan.txt").relocationDecision, "pode_mexer");
  assert.equal(byPath.get("src/old.log").deletionDecision, "pode_apagar");
  assert.equal(byPath.get("src/old.log").utilityStatus, "inutil_provavel");
  assert.equal(byPath.get("src/recent.tmp").deletionDecision, "inutil_provavel");
  assert.equal(byPath.get("src/recent.tmp").utilityStatus, "baixo_uso");
  assert.equal(byPath.get("package.json").classification, "critico_protegido");
  assert.equal(byPath.get("package.json").risk, "alto");
  assert.equal(byPath.get("package.json").deletionDecision, "nao_apagar");
  assert.ok(result.summary.entries >= result.summary.files + result.summary.directories);
  assert.ok(result.graphViews.far.nodes.length >= 1);
  assert.ok(result.graphViews.medium.nodes.length >= 1);
  assert.equal(result.graphViews.close.nodes.length, result.summary.files);
  assert.ok(result.simulation.decisionGroups.pode_apagar.length >= 1);
  assert.ok(result.simulation.decisionGroups.nao_apagar.length >= 1);
});

test("Grafo evita falsos positivos em conteudo do usuario e estado de aplicativo", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "src-add-user-safe-"));
  await fs.mkdir(path.join(root, "Users", "me", "Downloads"), { recursive: true });
  await fs.mkdir(path.join(root, "Users", "me", "AppData", "Roaming", "Editor"), { recursive: true });
  await fs.mkdir(path.join(root, "Users", "me", "AppData", "Local", "Temp"), { recursive: true });
  await fs.writeFile(path.join(root, "Users", "me", "Downloads", "notes.txt"), "anotacao pessoal\n");
  await fs.writeFile(path.join(root, "Users", "me", "AppData", "Roaming", "Editor", "profile.sqlite"), Buffer.alloc(4096));
  await fs.writeFile(path.join(root, "Users", "me", "AppData", "Local", "Temp", "cache.tmp"), Buffer.alloc(2048));
  const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  await fs.utimes(path.join(root, "Users", "me", "Downloads", "notes.txt"), oldDate, oldDate);
  await fs.utimes(path.join(root, "Users", "me", "AppData", "Roaming", "Editor", "profile.sqlite"), oldDate, oldDate);
  await fs.utimes(path.join(root, "Users", "me", "AppData", "Local", "Temp", "cache.tmp"), oldDate, oldDate);

  const result = await analyzeDirectory(root, {
    scanEngine: "node",
    dependencyMode: "metadata",
    adaptive: false,
    maxFiles: 100,
    maxDepth: 8
  });
  const byPath = new Map(result.nodes.map((node) => [node.relativePath, node]));
  const notes = byPath.get("Users/me/Downloads/notes.txt");
  const profile = byPath.get("Users/me/AppData/Roaming/Editor/profile.sqlite");
  const cache = byPath.get("Users/me/AppData/Local/Temp/cache.tmp");

  assert.equal(notes.fileKnowledge.isKnownUserFolder, true);
  assert.equal(notes.deletionDecision, "inutil_provavel");
  assert.notEqual(notes.deletionDecision, "pode_apagar");
  assert.equal(notes.risk, "medio");
  assert.equal(profile.fileKnowledge.isApplicationState, true);
  assert.equal(profile.deletionDecision, "averiguar");
  assert.notEqual(profile.deletionDecision, "pode_apagar");
  assert.equal(cache.fileKnowledge.isLowValueGenerated, true);
  assert.equal(cache.deletionDecision, "pode_apagar");
});

test("Preferencias do usuario bloqueiam arquivos ignorados e pastas isentas", () => {
  const addReport = {
    rootPath: "C:/",
    summary: {
      totalBytes: 8192,
      files: 2,
      byDeletionDecision: {},
      byRisk: {}
    },
    nodes: [
      {
        id: "file:Users/me/Downloads/old.iso",
        kind: "file",
        relativePath: "Users/me/Downloads/old.iso",
        size: 4096,
        risk: "baixo",
        classification: "isolado",
        deletionDecision: "pode_apagar",
        relocationDecision: "pode_mexer",
        protectedReasons: [],
        riskReasons: [],
        impact: { system: "nao_afeta_sistema", user: "baixo", dependencies: "nenhum" },
        incoming: 0,
        outgoing: 0,
        impactCount: 0
      },
      {
        id: "file:Users/me/Documents/work.db",
        kind: "file",
        relativePath: "Users/me/Documents/work.db",
        size: 4096,
        risk: "medio",
        classification: "isolado",
        deletionDecision: "averiguar",
        relocationDecision: "averiguar",
        protectedReasons: [],
        riskReasons: [],
        impact: { system: "nao_afeta_sistema", user: "medio", dependencies: "nenhum" },
        incoming: 0,
        outgoing: 0,
        impactCount: 0
      }
    ],
    edges: []
  };

  applyPreferencesToAddReport(addReport, {
    fileDecisions: {
      "users/me/downloads/old.iso": { decision: "ignore" }
    },
    exemptDirectories: {
      "users/me/documents": { path: "users/me/documents" }
    }
  });
  const plan = generateRelocationPlan(addReport);

  assert.equal(addReport.nodes[0].deletionDecision, "nao_apagar");
  assert.equal(addReport.nodes[1].deletionDecision, "nao_apagar");
  assert.equal(plan.candidatesByMode.alto.some((item) => item.path === "Users/me/Downloads/old.iso"), false);
  assert.equal(plan.candidatesByMode.alto.some((item) => item.path === "Users/me/Documents/work.db"), false);
});

test("Grafo resolve import Python relativo", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "src-add-py-"));
  await fs.mkdir(path.join(root, "pkg"), { recursive: true });
  await fs.writeFile(path.join(root, "pkg", "__init__.py"), "");
  await fs.writeFile(path.join(root, "pkg", "main.py"), "from .utils import work\nwork()\n");
  await fs.writeFile(path.join(root, "pkg", "utils.py"), "def work():\n    return 1\n");

  const result = await analyzeDirectory(root, {
    scanEngine: "node",
    dependencyMode: "full",
    maxFiles: 100,
    maxDepth: 5
  });

  const edge = result.edges.find((item) => item.sourcePath === "pkg/main.py" && item.targetPath === "pkg/utils.py");
  assert.ok(edge, "esperava aresta Python relativa entre main.py e utils.py");
});

test("Grafo detecta ciclo por DFS e marca bloco interdependente", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "src-add-cycle-"));
  await fs.writeFile(path.join(root, "a.js"), "import './b.js';\n");
  await fs.writeFile(path.join(root, "b.js"), "import './c.js';\n");
  await fs.writeFile(path.join(root, "c.js"), "import './a.js';\n");

  const result = await analyzeDirectory(root, {
    scanEngine: "node",
    dependencyMode: "full",
    maxFiles: 100,
    maxDepth: 2
  });
  const byPath = new Map(result.nodes.map((node) => [node.relativePath, node]));

  assert.equal(result.cycles.length, 1);
  assert.equal(result.summary.cycles, 1);
  assert.equal(byPath.get("a.js").inCycle, true);
  assert.equal(byPath.get("a.js").risk, "critico");
  assert.equal(byPath.get("a.js").deletionDecision, "nao_apagar");
  assert.ok(byPath.get("a.js").simulation.moveRequires.includes("b.js"));
});

test("MaidSpace gera plano e estado de limpeza sem mover arquivos", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "src-pipeline-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "main.js"), "import './dep.js';\n");
  await fs.writeFile(path.join(root, "src", "dep.js"), "export const dep = true;\n");
  await fs.writeFile(path.join(root, "notes.txt"), "rascunho antigo\n");
  const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  await fs.utimes(path.join(root, "notes.txt"), oldDate, oldDate);

  const result = await runSrcPipeline(root, {
    scanEngine: "node",
    dependencyMode: "full",
    maxFiles: 100,
    maxDepth: 4,
    targetFreeBytes: 4096,
    saveState: false
  });

  assert.equal(result.system, "MaidSpace");
  assert.equal(result.modules.add.status, "concluido");
  assert.equal(result.modules.are.status, "plano_gerado");
  assert.equal(result.modules.alc.status, "estado_nao_salvo");
  assert.ok(result.relocationPlan.operations.some((item) => item.source === "notes.txt"));
  assert.equal(result.continuousState.mode, "primeiro_estado");
  assert.match(result.report.text, /Grafo de Dependencias/);
});

test("Plano calcula espaco realocavel por modo e arquivos bloqueados", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "src-are-space-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "old.tmp"), Buffer.alloc(4096));
  await fs.writeFile(path.join(root, "recent.txt"), Buffer.alloc(2048));
  await fs.writeFile(path.join(root, "src", "main.js"), "import './dep.js';\n");
  await fs.writeFile(path.join(root, "src", "dep.js"), "export const dep = true;\n");
  const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  await fs.utimes(path.join(root, "old.tmp"), oldDate, oldDate);
  await fs.utimes(path.join(root, "src", "main.js"), oldDate, oldDate);
  await fs.utimes(path.join(root, "src", "dep.js"), oldDate, oldDate);

  const result = await runSrcPipeline(root, {
    scanEngine: "node",
    dependencyMode: "full",
    maxFiles: 100,
    maxDepth: 4,
    targetFreeBytes: 4096,
    saveState: false
  });
  const plan = result.relocationPlan;

  assert.ok(plan.spaceModes.baixo.reallocatableBytes >= 4096);
  assert.ok(plan.spaceModes.medio.reallocatableBytes >= plan.spaceModes.baixo.reallocatableBytes);
  assert.ok(plan.spaceModes.alto.reallocatableBytes >= plan.spaceModes.medio.reallocatableBytes);
  assert.ok(plan.candidatesByMode.baixo.some((item) => item.path === "old.tmp"));
  assert.ok(plan.candidatesByMode.medio.some((item) => item.path === "src/main.js" && item.packagePaths.includes("src/dep.js")));
  assert.ok(plan.spaceModes.medio.packages.some((item) => item.files.includes("src/main.js") && item.files.includes("src/dep.js")));
  assert.equal(plan.relocationSimulation.medio.beforeBytes, plan.summary.totalBytes);
  assert.equal(
    plan.relocationSimulation.medio.remainingBytes,
    plan.summary.totalBytes - plan.relocationSimulation.medio.relocatedBytes
  );
  assert.ok(plan.relocationSimulation.medio.simulatedMoves.some((item) => item.files.includes("src/dep.js")));
  assert.equal(plan.candidatesByMode.baixo.some((item) => item.path === "recent.txt"), false);
  assert.equal(plan.candidatesByMode.medio.some((item) => item.path === "recent.txt"), false);
  assert.ok(plan.candidatesByMode.alto.some((item) => item.path === "recent.txt"));
  assert.equal(plan.targetPlan.selectedMode, "baixo");
  assert.equal(plan.targetPlan.status, "atingivel");
  assert.match(plan.safetyReport.text, /Modo baixo/);
});

test("Varredura progressiva atualiza Grafo e Plano por profundidade", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "src-progressive-"));
  await fs.mkdir(path.join(root, "nivel1", "nivel2", "nivel3"), { recursive: true });
  await fs.writeFile(path.join(root, "raiz.tmp"), "temporario antigo\n");
  await fs.writeFile(path.join(root, "nivel1", "a.txt"), "a\n");
  await fs.writeFile(path.join(root, "nivel1", "nivel2", "b.txt"), "b\n");
  await fs.writeFile(path.join(root, "nivel1", "nivel2", "nivel3", "c.txt"), "c\n");
  const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  await fs.utimes(path.join(root, "raiz.tmp"), oldDate, oldDate);

  const snapshots = [];
  for await (const result of runSrcPipelineProgressive(root, {
    scanEngine: "node",
    dependencyMode: "full",
    adaptive: false,
    maxFiles: 100,
    maxDepth: 3,
    progressiveMaxFiles: 100,
    saveState: false
  })) {
    snapshots.push(result);
  }

  assert.ok(snapshots.length >= 1);
  assert.equal(snapshots[0].progressive.enabled, true);
  assert.equal(snapshots[0].progressive.singlePass, true);
  assert.equal(snapshots.at(-1).modules.add.status, "concluido");
  assert.ok(snapshots.at(-1).summary.files >= snapshots[0].summary.files);
  assert.ok(snapshots.at(-1).summary.depthBreakdown.length >= 3);
  assert.ok(snapshots.at(-1).summary.depthBreakdown.reduce((sum, item) => sum + item.files, 0) >= snapshots.at(-1).summary.files);
  assert.ok(snapshots.at(-1).relocationPlan.depthRelocation.length >= 3);
  assert.ok(snapshots.at(-1).relocationPlan.spaceModes.baixo.reallocatableBytes >= 0);
  assert.equal(snapshots.at(-1).progressive.isFinal, true);
});

test("Fallback progressivo HTTP emite relatorio final com tempos", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "src-progressive-http-"));
  const root = path.join(base, "root");
  const server = createAppServer();

  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "old.tmp"), "temporario\n");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scan-progressive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rootPath: root,
        options: {
          scanEngine: "node",
          dependencyMode: "metadata",
          adaptive: false,
          maxFiles: 100,
          maxDepth: 2,
          compactFinal: false,
          saveState: false
        }
      })
    });

    assert.equal(response.ok, true);
    const events = (await response.text())
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const report = events.find((event) => event.finalReport)?.finalReport;

    assert.equal(report.status, "concluido");
    assert.ok(report.stageTimings);
    assert.ok(report.stageTimings.analyzing >= 0);
    assert.ok(report.stageTimings.logging >= 0);
    assert.ok(report.logPath);
    await fs.access(report.logPath);
  } finally {
    server.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("Grafo permite alternar leitura de Program Files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "src-program-files-"));
  await fs.mkdir(path.join(root, "Program Files", "Tool", "downloads"), { recursive: true });
  await fs.writeFile(path.join(root, "Program Files", "Tool", "downloads", "cache.tmp"), "cache antigo\n");
  await fs.writeFile(path.join(root, "Program Files", "Tool", "tool.dll"), Buffer.alloc(1024));

  const blocked = await analyzeDirectory(root, {
    scanEngine: "node",
    dependencyMode: "full",
    adaptive: false,
    maxFiles: 100,
    maxDepth: 5,
    includeProgramFiles: false
  });
  const allowed = await analyzeDirectory(root, {
    scanEngine: "node",
    dependencyMode: "full",
    adaptive: false,
    maxFiles: 100,
    maxDepth: 5,
    includeProgramFiles: true
  });

  assert.equal(blocked.nodes.some((node) => node.relativePath === "Program Files/Tool/downloads/cache.tmp"), false);
  assert.equal(allowed.nodes.some((node) => node.relativePath === "Program Files/Tool/downloads/cache.tmp"), true);
  assert.equal(allowed.nodes.find((node) => node.relativePath === "Program Files/Tool/tool.dll").classification, "isolado");
  assert.equal(allowed.nodes.find((node) => node.relativePath === "Program Files/Tool/tool.dll").fileKnowledge.isInstalledApplication, true);
});

test("Grafo registra areas grandes por padrao sem isentar a pasta inteira", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "src-full-storage-"));
  await fs.mkdir(path.join(root, "Program Files (x86)", "Steam", "steamapps"), { recursive: true });
  await fs.mkdir(path.join(root, "Users", "me", "AppData", "Local", "Temp"), { recursive: true });
  await fs.writeFile(path.join(root, "Program Files (x86)", "Steam", "steamapps", "game.bin"), Buffer.alloc(4096));
  await fs.writeFile(path.join(root, "Users", "me", "AppData", "Local", "Temp", "cache.tmp"), Buffer.alloc(2048));

  const result = await analyzeDirectory(root, {
    scanEngine: "node",
    dependencyMode: "metadata",
    adaptive: false,
    maxFiles: 100,
    maxDepth: 8
  });
  const byPath = new Map(result.nodes.map((node) => [node.relativePath, node]));

  assert.equal(result.options.includeProgramFiles, true);
  assert.equal(byPath.has("Program Files (x86)/Steam/steamapps/game.bin"), true);
  assert.equal(byPath.has("Users/me/AppData/Local/Temp/cache.tmp"), true);
  assert.notEqual(byPath.get("Program Files (x86)/Steam/steamapps/game.bin").classification, "critico_protegido");
});

test("Grafo padrao pula apenas diretorios obvios do sistema e mantem areas limpaveis", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "src-system-skip-"));
  await fs.mkdir(path.join(root, "Windows", "System32"), { recursive: true });
  await fs.mkdir(path.join(root, "ProgramData", "Vendor", "Cache"), { recursive: true });
  await fs.mkdir(path.join(root, "$Recycle.Bin", "S-1-5-21"), { recursive: true });
  await fs.writeFile(path.join(root, "Windows", "System32", "kernel32.dll"), Buffer.alloc(1024));
  await fs.writeFile(path.join(root, "ProgramData", "Vendor", "Cache", "blob.tmp"), Buffer.alloc(2048));
  await fs.writeFile(path.join(root, "$Recycle.Bin", "S-1-5-21", "deleted.iso"), Buffer.alloc(4096));

  const result = await analyzeDirectory(root, {
    scanEngine: "node",
    dependencyMode: "metadata",
    adaptive: false,
    maxFiles: 100,
    maxDepth: 8
  });
  const byPath = new Map(result.nodes.map((node) => [node.relativePath, node]));

  assert.equal(byPath.has("Windows/System32/kernel32.dll"), false);
  assert.equal(byPath.has("ProgramData/Vendor/Cache/blob.tmp"), true);
  assert.equal(byPath.has("$Recycle.Bin/S-1-5-21/deleted.iso"), true);
  assert.ok(result.skipped.some((item) => item.path === "Windows/System32"));
  assert.equal(byPath.get("ProgramData/Vendor/Cache/blob.tmp").classification, "isolado");
});

test("Plano alto apresenta potencial de 100GB fora de sistema sem desbloquear System32", () => {
  const hundredGb = 100 * 1024 * 1024 * 1024;
  const now = new Date().toISOString();
  const addReport = {
    rootPath: "C:/",
    summary: {
      files: 2,
      totalBytes: hundredGb + 4096,
      inventoryProvider: "robocopy",
      inventoryTruncated: false
    },
    nodes: [
      {
        id: "file:Users/me/Videos/capture.raw",
        kind: "file",
        name: "capture.raw",
        relativePath: "Users/me/Videos/capture.raw",
        extension: ".raw",
        size: hundredGb,
        modifiedAt: now,
        lastAccessedAt: now,
        daysSinceAccess: 0,
        classification: "isolado",
        risk: "medio",
        deletionDecision: "averiguar",
        relocationDecision: "averiguar",
        protectedReasons: [],
        fileKnowledge: { isUserContent: true, isLowValueGenerated: false },
        impact: { system: "nao_afeta_sistema", user: "medio", dependencies: "nenhum" },
        incoming: 0,
        outgoing: 0,
        impactCount: 0,
        componentId: "file:Users/me/Videos/capture.raw",
        inCycle: false
      },
      {
        id: "file:Windows/System32/kernel32.dll",
        kind: "file",
        name: "kernel32.dll",
        relativePath: "Windows/System32/kernel32.dll",
        extension: ".dll",
        size: 4096,
        modifiedAt: now,
        lastAccessedAt: now,
        daysSinceAccess: 0,
        classification: "critico_protegido",
        risk: "critico",
        deletionDecision: "nao_apagar",
        relocationDecision: "nao_mover",
        protectedReasons: ["diretorio critico do sistema operacional"],
        fileKnowledge: { isSystemEssential: true },
        impact: { system: "afeta_sistema", user: "alto", dependencies: "critico" },
        incoming: 0,
        outgoing: 0,
        impactCount: 0,
        componentId: "file:Windows/System32/kernel32.dll",
        inCycle: false
      }
    ],
    cycles: []
  };

  const plan = generateRelocationPlan(addReport);

  assert.equal(plan.spaceModes.alto.reallocatableBytes, hundredGb);
  assert.equal(plan.spaceModes.alto.reallocatableHuman, "100 GB");
  assert.ok(plan.candidatesByMode.alto.some((item) => item.path === "Users/me/Videos/capture.raw"));
  assert.ok(plan.blockedFiles.some((item) => item.path === "Windows/System32/kernel32.dll"));
});

test("Plano usa estimativa completa do inventario quando detalhes sao compactados", () => {
  const hundredGb = 100 * 1024 * 1024 * 1024;
  const addReport = {
    rootPath: "C:/",
    summary: {
      files: 500000,
      totalBytes: 512 * 1024 * 1024 * 1024,
      inventoryProvider: "robocopy",
      inventoryTruncated: true,
      inventoryReclaimable: {
        provider: "metadata_estimate",
        baixo: { files: 10, bytes: 4 * 1024 * 1024 * 1024 },
        medio: { files: 25, bytes: 20 * 1024 * 1024 * 1024 },
        alto: { files: 120, bytes: hundredGb }
      }
    },
    nodes: [],
    cycles: []
  };

  const plan = generateRelocationPlan(addReport);

  assert.equal(plan.spaceModes.alto.reallocatableBytes, hundredGb);
  assert.equal(plan.spaceModes.alto.inventoryEstimateUsed, true);
  assert.equal(plan.spaceModes.alto.fileCount, 0);
  assert.equal(plan.spaceModes.alto.executableFileCount, 120);
  assert.equal(plan.spaceModes.alto.previewCandidateCount, 0);
  assert.equal(plan.summary.inventoryEstimatedReclaimableHuman.alto, "100 GB");
});

test("Plano monta meta personalizada por aproximacao sem mover nivel inteiro", () => {
  const mb = 1024 * 1024;
  const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const addReport = {
    rootPath: "C:/",
    summary: {
      files: 3,
      totalBytes: 145 * mb
    },
    nodes: [
      relocationNode("cache/a.tmp", 70 * mb, old),
      relocationNode("cache/b.tmp", 40 * mb, old),
      relocationNode("cache/c.tmp", 35 * mb, old)
    ],
    cycles: []
  };

  const plan = generateRelocationPlan(addReport, { targetFreeBytes: 100 * mb });

  assert.equal(plan.targetPlan.selectedMode, "baixo");
  assert.equal(plan.targetPlan.status, "atingivel");
  assert.equal(plan.targetPlan.plannedBytes, 105 * mb);
  assert.deepEqual(plan.targetPlan.candidates.map((item) => item.path).sort(), ["cache/a.tmp", "cache/c.tmp"]);
});

function relocationNode(relativePath, size, timestamp) {
  return {
    id: `file:${relativePath}`,
    kind: "file",
    name: path.basename(relativePath),
    relativePath,
    extension: path.extname(relativePath),
    size,
    modifiedAt: timestamp,
    lastAccessedAt: timestamp,
    daysSinceAccess: 90,
    classification: "isolado",
    risk: "baixo",
    deletionDecision: "pode_apagar",
    relocationDecision: "pode_mexer",
    protectedReasons: [],
    fileKnowledge: { isLowValueGenerated: true, isUserContent: false },
    impact: { system: "nao_afeta_sistema", user: "baixo", dependencies: "nenhum" },
    incoming: 0,
    outgoing: 0,
    impactCount: 0,
    componentId: `file:${relativePath}`,
    inCycle: false,
    unresolvedDependencies: 0
  };
}

test("Grafo agrupa DPN em HF e usa DFS limitado apenas em alvo de risco", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "src-hf-dpn-"));
  await fs.mkdir(path.join(root, "Heavy"), { recursive: true });
  await fs.writeFile(path.join(root, "Heavy", "app.js"), `import './lib.js';\n${"x".repeat(8192)}\n`);
  await fs.writeFile(path.join(root, "Heavy", "lib.js"), "export const value = true;\n");
  await fs.writeFile(path.join(root, "Heavy", "cache.tmp"), "cache antigo\n");

  const result = await analyzeDirectory(root, {
    scanEngine: "node",
    dependencyMode: "metadata",
    adaptive: false,
    maxFiles: 100,
    maxDepth: 4,
    maxDependencyReadBytes: 4096,
    heavyFolderFileThreshold: 2,
    heavyFolderBytesThreshold: 1,
    heavyFolderRiskThreshold: 1,
    targetedDfsMaxFiles: 10
  });
  const byPath = new Map(result.nodes.map((node) => [node.relativePath, node]));

  assert.ok(result.summary.heavyFolders.some((folder) => folder.path === "Heavy"));
  assert.ok(result.summary.dependencyGroups.some((group) => group.key.startsWith("dpn:dependencia")));
  assert.equal(result.summary.targetedDfsProbes.scheduled >= 1, true);
  assert.equal(result.summary.targetedDfsProbes.partialReads >= 1, true);
  assert.ok(result.edges.some((edge) => edge.sourcePath === "Heavy/app.js" && edge.targetPath === "Heavy/lib.js"));
  assert.equal(byPath.get("Heavy/app.js").dependencyProbe.status, "parsed");
  assert.equal(byPath.get("Heavy/app.js").dependencyProbe.partialRead, true);
});

test("Varredura turbo inventaria metadados sem bloquear no grafo profundo", async (t) => {
  if (process.platform !== "win32") {
    t.skip("inventario turbo usa robocopy no Windows");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "src-turbo-"));
  await fs.mkdir(path.join(root, "Downloads"), { recursive: true });
  await fs.writeFile(path.join(root, "Downloads", "old.iso"), Buffer.alloc(32 * 1024));
  await fs.writeFile(path.join(root, "Downloads", "notes.txt"), "rascunho\n");
  const oldDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  await fs.utimes(path.join(root, "Downloads", "old.iso"), oldDate, oldDate);
  await fs.utimes(path.join(root, "Downloads", "notes.txt"), oldDate, oldDate);

  const result = await runSrcPipeline(root, {
    scanEngine: "turbo",
    fastScanMs: 10000,
    fastStoredFiles: 1000,
    saveState: false
  });

  assert.equal(result.summary.inventoryProvider, "robocopy");
  assert.equal(result.summary.files, 2);
  assert.equal(result.summary.storedFiles, 2);
  assert.equal(result.edges.length, 0);
  assert.equal(result.relocationPlan.summary.inventoryProvider, "robocopy");
  assert.equal(result.relocationPlan.summary.totalBytes, result.summary.totalBytes);
  assert.ok(result.relocationPlan.summary.reallocatable.alto >= 32 * 1024);
});

test("Limpeza gera manifesto, dry-run e bloqueia caminho protegido", () => {
  assert.equal(isProtectedPath("Windows/System32/kernel32.dll"), true);
  assert.equal(isProtectedPath("Users/me/Documents/tese.pdf"), true);
  assert.equal(isProtectedPath("Users/me/Documents/tese.pdf", { manualApproval: true }), false);
  assert.equal(unsafeRelativePathReason("../escape.tmp"), "caminho relativo inseguro");
  assert.equal(unsafeRelativePathReason("cache/file.txt:stream"), "caminho com fluxo alternativo ou caractere invalido");

  const item = buildOperationItem({
    relativePath: "cache/old.tmp",
    size: 1024,
    risk: "baixo",
    reason: "cache antigo"
  }, {
    rootPath: "C:/root",
    targetKind: "delete",
    quarantineDirectory: "C:/MaidSpace/quarantine/op-1"
  });
  assert.equal(item.action, "quarantine");
  assert.match(item.plannedDestination, /quarantine/);

  const unsafeItem = buildOperationItem({
    relativePath: "../escape.tmp",
    size: 8,
    risk: "baixo"
  }, {
    rootPath: "C:/root",
    targetKind: "directory",
    targetDirectory: "D:/dest"
  });
  assert.equal(unsafeItem.status, "skipped");
  assert.equal(unsafeItem.action, "skip");
  assert.match(unsafeItem.error, /inseguro/);

  const manifest = createOperationManifest({
    operationId: "op-test",
    dryRun: true,
    rootPath: "C:/root",
    targetKind: "delete",
    quarantineDirectory: "C:/MaidSpace/quarantine/op-test",
    files: [item]
  });
  assert.equal(manifest.mode, "dry-run");
  assert.equal(manifest.totalFiles, 1);
  assert.equal(manifest.totalBytes, 1024);
  recordOperationResult(manifest, item.id, { status: "success", finalPath: "C:/dest/cache/old.tmp" });
  assert.equal(manifest.items[0].status, "success");
});

test("Limpeza fallback simula sem mover arquivos via HTTP", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "src-alc-dry-"));
  const root = path.join(base, "root");
  const server = createAppServer();

  try {
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, "cache.tmp"), "cache");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/alc/relocate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          rootPath: root,
          targetKind: "quarantine",
          dryRun: true,
          auditSource: "simulation",
          auditedItemCount: 1,
          waveBytes: 4,
          files: [{ relativePath: "cache.tmp", size: 5, risk: "baixo", reason: "teste" }]
        }
      })
    });
    const payload = await response.json();
    assert.equal(response.ok, true, payload.error || "falha HTTP");
    assert.equal(payload.dryRun, true);
    assert.equal(payload.plannedFiles, 1);
    assert.equal(payload.movedFiles, 0);
    assert.ok(payload.manifestPath);
    assert.ok(payload.manifestUsedPath);
    assert.equal(payload.auditSource, "simulation");
    assert.equal(payload.auditedItemCount, 1);
    assert.equal(payload.waveBytes, 4);
    assert.equal(payload.waveCount, 2);
    assert.equal(payload.wavesCompleted, 0);
    assert.ok(payload.stageTimings);
    assert.ok(payload.stageTimings.planning >= 0);
    assert.ok(payload.stageTimings.logging >= 0);
    await fs.access(path.join(root, "cache.tmp"));
  } finally {
    server.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("Limpeza fallback move e quarentena arquivos via HTTP", async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "src-alc-http-"));
  const root = path.join(base, "root");
  const destination = path.join(base, "dest");
  const server = createAppServer();

  try {
    await fs.mkdir(root, { recursive: true });
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(path.join(root, "move-me.txt"), "move");
    await fs.writeFile(path.join(root, "delete-me.tmp"), "delete");
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const postRelocate = async (request) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/alc/relocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request })
      });
      const payload = await response.json();
      assert.equal(response.ok, true, payload.error || "falha HTTP");
      return payload;
    };

    const insideTarget = path.join(root, "destino-interno");
    const blockedTargetResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/alc/relocate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          rootPath: root,
          targetKind: "directory",
          targetDirectory: insideTarget,
          auditSource: "expanded",
          auditedItemCount: 1,
          files: [{ relativePath: "move-me.txt" }]
        }
      })
    });
    const blockedTargetPayload = await blockedTargetResponse.json();
    assert.equal(blockedTargetResponse.ok, false);
    assert.match(blockedTargetPayload.error, /dentro da raiz/);
    await assert.rejects(fs.access(insideTarget));

    const moveReport = await postRelocate({
      operationId: "test-move-op-1",
      rootPath: root,
      targetKind: "directory",
      targetDirectory: destination,
      auditSource: "expanded",
      auditedItemCount: 1,
      waveBytes: 2,
      files: [{ relativePath: "move-me.txt" }]
    });
    assert.equal(moveReport.movedFiles, 1);
    assert.ok(moveReport.stageTimings.moving >= 0);
    assert.equal(moveReport.auditSource, "expanded");
    assert.equal(moveReport.auditedItemCount, 1);
    assert.ok(moveReport.waveCount >= 1);
    assert.equal(moveReport.wavesCompleted, moveReport.waveCount);
    assert.ok(moveReport.manifestUsedPath);
    assert.equal(moveReport.volumeInfo.known, true);
    assert.ok(["rename", "copy_then_remove", "unknown"].includes(moveReport.volumeInfo.strategy));
    assert.ok(moveReport.averageBytesPerSecond >= 0);
    await assert.rejects(fs.access(path.join(root, "move-me.txt")));
    await fs.access(path.join(destination, "move-me.txt"));

    await fs.writeFile(path.join(root, "job-me.txt"), "job");
    const jobResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/alc/relocate-job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        request: {
          operationId: "test-job-op-1",
          rootPath: root,
          targetKind: "directory",
          targetDirectory: destination,
          auditSource: "expanded",
          auditedItemCount: 1,
          files: [{ relativePath: "job-me.txt" }]
        }
      })
    });
    const jobStarted = await jobResponse.json();
    assert.equal(jobResponse.status, 202, jobStarted.error || "falha HTTP");
    assert.ok(jobStarted.jobId);
    let jobPayload = jobStarted;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const pollResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/alc/jobs/${encodeURIComponent(jobStarted.jobId)}`);
      jobPayload = await pollResponse.json();
      assert.equal(pollResponse.ok, true, jobPayload.error || "falha HTTP");
      if (jobPayload.status !== "running") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(jobPayload.status, "completed");
    assert.equal(jobPayload.report.movedFiles, 1);
    assert.equal(jobPayload.report.auditedItemCount, 1);
    assert.ok(jobPayload.progress.percent >= 100);
    await assert.rejects(fs.access(path.join(root, "job-me.txt")));
    await fs.access(path.join(destination, "job-me.txt"));

    const cancelResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/alc/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "test-cancel-op-1" })
    });
    const cancelPayload = await cancelResponse.json();
    assert.equal(cancelResponse.ok, true, cancelPayload.error || "falha HTTP");
    assert.equal(cancelPayload.supported, true);
    assert.equal(cancelPayload.operationId, "test-cancel-op-1");

    const deleteReport = await postRelocate({
      rootPath: root,
      targetKind: "delete",
      auditSource: "expanded",
      auditedItemCount: 1,
      waveBytes: 2,
      files: [{ relativePath: "delete-me.tmp" }]
    });
    assert.equal(deleteReport.movedFiles, 1);
    assert.equal(deleteReport.effectiveAction, "quarantine");
    assert.ok(deleteReport.stageTimings.quarantining >= 0);
    assert.equal(deleteReport.auditSource, "expanded");
    assert.equal(deleteReport.auditedItemCount, 1);
    assert.ok(deleteReport.waveCount >= 1);
    assert.equal(deleteReport.wavesCompleted, deleteReport.waveCount);
    await assert.rejects(fs.access(path.join(root, "delete-me.tmp")));
    await fs.access(path.join(deleteReport.quarantineDirectory, "files", "delete-me.tmp"));

    await fs.writeFile(path.join(root, "expand-me.tmp"), "expand");
    const expandReport = await postRelocate({
      rootPath: root,
      targetKind: "delete",
      planMode: "alto",
      targetBytes: 1,
      expandPlan: true,
      files: []
    });
    assert.equal(expandReport.movedFiles, 1);
    assert.equal(expandReport.effectiveAction, "quarantine");
    assert.equal(expandReport.auditedItemCount, 1);
    assert.ok(expandReport.manifestUsedPath);
    await assert.rejects(fs.access(path.join(root, "expand-me.tmp")));
    await fs.access(path.join(expandReport.quarantineDirectory, "files", "expand-me.tmp"));
  } finally {
    server.close();
    await fs.rm(base, { recursive: true, force: true });
  }
});
