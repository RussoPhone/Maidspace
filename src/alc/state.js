const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function buildDirectoryState(addReport) {
  const files = (addReport.nodes || []).filter((node) => node.kind === "file");
  const entries = files.map((node) => ({
    path: node.relativePath,
    size: node.size || 0,
    modifiedAt: node.modifiedAt || null,
    lastAccessedAt: node.lastAccessedAt || null,
    signature: signatureFor(node),
    classification: node.classification,
    risk: node.risk,
    deletionDecision: node.deletionDecision,
    incoming: node.incoming || 0,
    outgoing: node.outgoing || 0,
    impactCount: node.impactCount || 0,
    inCycle: Boolean(node.inCycle)
  }));

  return {
    schemaVersion: 1,
    algorithm: "Limpeza",
    rootPath: addReport.rootPath,
    scannedAt: addReport.summary?.scannedAt || new Date().toISOString(),
    summary: {
      files: entries.length,
      edges: addReport.summary?.edges || 0,
      cycles: addReport.summary?.cycles || 0,
      canDelete: addReport.summary?.canDelete || 0,
      mustKeep: addReport.summary?.mustKeep || 0
    },
    entries
  };
}

function compareDirectoryStates(previousState, currentState) {
  if (!previousState) {
    return {
      schemaVersion: 1,
      algorithm: "Limpeza",
      mode: "primeiro_estado",
      previousScannedAt: null,
      currentScannedAt: currentState.scannedAt,
      summary: {
        newFiles: currentState.entries.length,
        removedFiles: 0,
        modifiedFiles: 0,
        unchangedFiles: 0,
        riskChangedFiles: 0,
        dependencyChangedFiles: 0,
        reanalysisNeeded: false
      },
      changes: {
        newFiles: currentState.entries.map((entry) => entry.path),
        removedFiles: [],
        modifiedFiles: [],
        riskChangedFiles: [],
        dependencyChangedFiles: []
      },
      recommendation: "Estado inicial salvo para comparacoes futuras."
    };
  }

  const previousByPath = new Map(previousState.entries.map((entry) => [entry.path, entry]));
  const currentByPath = new Map(currentState.entries.map((entry) => [entry.path, entry]));
  const newFiles = [];
  const removedFiles = [];
  const modifiedFiles = [];
  const riskChangedFiles = [];
  const dependencyChangedFiles = [];
  let unchangedFiles = 0;

  for (const entry of currentState.entries) {
    const previous = previousByPath.get(entry.path);
    if (!previous) {
      newFiles.push(entry.path);
      continue;
    }
    if (previous.signature !== entry.signature) {
      modifiedFiles.push(entry.path);
    } else {
      unchangedFiles += 1;
    }
    if (previous.risk !== entry.risk || previous.deletionDecision !== entry.deletionDecision) {
      riskChangedFiles.push(entry.path);
    }
    if (
      previous.incoming !== entry.incoming
      || previous.outgoing !== entry.outgoing
      || previous.impactCount !== entry.impactCount
      || Boolean(previous.inCycle) !== Boolean(entry.inCycle)
    ) {
      dependencyChangedFiles.push(entry.path);
    }
  }

  for (const entry of previousState.entries) {
    if (!currentByPath.has(entry.path)) {
      removedFiles.push(entry.path);
    }
  }

  const reanalysisNeeded = newFiles.length > 0
    || removedFiles.length > 0
    || modifiedFiles.length > 0
    || riskChangedFiles.length > 0
    || dependencyChangedFiles.length > 0;

  return {
    schemaVersion: 1,
    algorithm: "Limpeza",
    mode: "comparacao",
    previousScannedAt: previousState.scannedAt,
    currentScannedAt: currentState.scannedAt,
    summary: {
      newFiles: newFiles.length,
      removedFiles: removedFiles.length,
      modifiedFiles: modifiedFiles.length,
      unchangedFiles,
      riskChangedFiles: riskChangedFiles.length,
      dependencyChangedFiles: dependencyChangedFiles.length,
      reanalysisNeeded
    },
    changes: {
      newFiles,
      removedFiles,
      modifiedFiles,
      riskChangedFiles,
      dependencyChangedFiles
    },
    recommendation: reanalysisNeeded
      ? "Mudancas detectadas. Atualize o grafo antes de qualquer plano de realocacao."
      : "Nenhuma mudanca relevante desde o ultimo estado salvo."
  };
}

async function loadPreviousState(rootPath) {
  const filePath = stateFilePath(rootPath);
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function saveCurrentState(rootPath, state) {
  const filePath = stateFilePath(rootPath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(state, null, 2), "utf8");
  return filePath;
}

function stateFilePath(rootPath) {
  const baseDirectory = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "MaidSpace", "states")
    : path.join(os.tmpdir(), "src-states");
  const id = crypto.createHash("sha1").update(path.resolve(rootPath || ".").toLowerCase()).digest("hex");
  return path.join(baseDirectory, `${id}.json`);
}

function signatureFor(node) {
  return [
    node.relativePath,
    node.size || 0,
    node.modifiedAt || "",
    node.incoming || 0,
    node.outgoing || 0,
    node.impactCount || 0,
    node.inCycle ? "cycle" : "acyclic"
  ].join("|");
}

module.exports = {
  buildDirectoryState,
  gerar_estado_diretorio: buildDirectoryState,
  salvar_estado_diretorio: saveCurrentState,
  compareDirectoryStates,
  comparar_estados: compareDirectoryStates,
  loadPreviousState,
  saveCurrentState,
  stateFilePath
};
