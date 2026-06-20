const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const STORE_VERSION = 1;

async function loadRootPreferences(rootPath) {
  const store = await readStore();
  return cloneRootPreferences(mergeRootPreferences(rootKeyAliases(rootPath).map((key) => store.roots[key])));
}

async function saveFileDecision(rootPath, relativePath, decision, metadata = {}) {
  const store = await readStore();
  const root = ensureRoot(store, rootPath);
  const key = normalizeRelative(relativePath);
  if (!key) {
    throw new Error("Arquivo invalido para decisao do usuario.");
  }

  if (decision === "clear") {
    delete root.fileDecisions[key];
  } else {
    root.fileDecisions[key] = {
      decision,
      updatedAt: new Date().toISOString(),
      note: metadata.note || "",
      size: Number(metadata.size || 0)
    };
  }

  await writeStore(store);
  return cloneRootPreferences(root);
}

async function saveExemptDirectories(rootPath, directories = []) {
  const store = await readStore();
  const root = ensureRoot(store, rootPath);
  root.exemptDirectories = {};
  for (const directory of directories) {
    const key = normalizeRelative(directory);
    if (!key) {
      continue;
    }
    root.exemptDirectories[key] = {
      path: key,
      updatedAt: new Date().toISOString()
    };
  }
  await writeStore(store);
  return cloneRootPreferences(root);
}

async function saveTargetPreference(rootPath, targetFreeBytes, minimumFreeBytes = 0) {
  const store = await readStore();
  const root = ensureRoot(store, rootPath);
  const bytes = Number(targetFreeBytes || 0);
  const minimum = Number(minimumFreeBytes || 0);
  root.targetFreeBytes = Number.isFinite(bytes) && bytes > 0 ? Math.round(bytes) : 0;
  root.minimumFreeBytes = Number.isFinite(minimum) && minimum > 0 ? Math.round(minimum) : 0;
  root.updatedAt = new Date().toISOString();
  await writeStore(store);
  return cloneRootPreferences(root);
}

function applyPreferencesToAddReport(addReport, preferences = {}) {
  if (!addReport || !Array.isArray(addReport.nodes)) {
    return addReport;
  }

  const fileDecisions = preferences.fileDecisions || {};
  const exemptDirectories = Object.keys(preferences.exemptDirectories || {});
  const nodesById = new Map(addReport.nodes.map((node) => [node.id, node]));
  const nodesByPath = new Map(addReport.nodes.map((node) => [normalizeRelative(node.relativePath), node]));
  const blockedPaths = new Set();

  for (const node of addReport.nodes) {
    if (node.kind !== "file") {
      continue;
    }
    const relative = normalizeRelative(node.relativePath);
    const decision = fileDecisions[relative]?.decision;
    if (decision === "ignore") {
      blockNode(node, "ignorado pelo usuario");
      blockedPaths.add(relative);
    } else if (decision === "relocate") {
      node.userDecision = {
        action: "relocate",
        updatedAt: fileDecisions[relative]?.updatedAt || null
      };
      node.riskReasons = Array.from(new Set([...(node.riskReasons || []), "aprovado pelo usuario para realocacao"]));
    }

    if (isInsideAnyDirectory(relative, exemptDirectories)) {
      blockNode(node, "pasta isenta pelo usuario");
      blockedPaths.add(relative);
    }
  }

  if (blockedPaths.size && Array.isArray(addReport.edges)) {
    for (const edge of addReport.edges) {
      const sourcePath = normalizeRelative(edge.sourcePath);
      const targetPath = normalizeRelative(edge.targetPath);
      const touchesBlocked = blockedPaths.has(sourcePath) || blockedPaths.has(targetPath);
      if (!touchesBlocked) {
        continue;
      }
      const sourceNode = nodesById.get(edge.source) || nodesByPath.get(sourcePath);
      const targetNode = nodesById.get(edge.target) || nodesByPath.get(targetPath);
      if (sourceNode && !blockedPaths.has(normalizeRelative(sourceNode.relativePath))) {
        blockNode(sourceNode, "ligado a pasta/arquivo isento");
      }
      if (targetNode && !blockedPaths.has(normalizeRelative(targetNode.relativePath))) {
        blockNode(targetNode, "ligado a pasta/arquivo isento");
      }
    }
  }

  addReport.userPreferences = {
    fileDecisions: Object.keys(fileDecisions).length,
    exemptDirectories: exemptDirectories.length,
    targetFreeBytes: Number(preferences.targetFreeBytes || 0),
    minimumFreeBytes: Number(preferences.minimumFreeBytes || 0)
  };
  refreshSummary(addReport);
  return addReport;
}

function blockNode(node, reason) {
  node.protectedReasons = Array.from(new Set([...(node.protectedReasons || []), reason]));
  node.deletionDecision = "nao_apagar";
  node.relocationDecision = "nao_mover";
  node.userDecision = {
    ...(node.userDecision || {}),
    action: reason.includes("ignorado") ? "ignore" : "exempt"
  };
  node.impact = {
    ...(node.impact || {}),
    user: "alto",
    system: node.impact?.system === "afeta_sistema" ? "afeta_sistema" : "protegido"
  };
  node.risk = node.risk === "critico" ? "critico" : "alto";
  node.riskReasons = Array.from(new Set([...(node.riskReasons || []), reason]));
}

function refreshSummary(addReport) {
  const fileNodes = (addReport.nodes || []).filter((node) => node.kind === "file");
  if (!addReport.summary) {
    return;
  }
  addReport.summary.byDeletionDecision = countBy(fileNodes, "deletionDecision");
  addReport.summary.byRisk = countBy(fileNodes, "risk");
  addReport.summary.canDelete = fileNodes.filter((node) => node.deletionDecision === "pode_apagar").length;
  addReport.summary.probablyUseless = fileNodes.filter((node) => node.deletionDecision === "inutil_provavel").length;
  addReport.summary.mustKeep = fileNodes.filter((node) => node.deletionDecision === "nao_apagar").length;
  addReport.summary.criticalRisk = fileNodes.filter((node) => node.risk === "critico").length;
  addReport.summary.protected = fileNodes.filter((node) => node.protectedReasons?.length).length;
}

function countBy(items, field) {
  return items.reduce((accumulator, item) => {
    const key = item[field] || "desconhecido";
    accumulator[key] = (accumulator[key] || 0) + 1;
    return accumulator;
  }, {});
}

function cloneRootPreferences(root = {}) {
  const fileDecisions = {};
  for (const [key, value] of Object.entries(root.fileDecisions || {})) {
    const normalized = normalizeRelative(key);
    if (normalized) {
      fileDecisions[normalized] = value;
    }
  }
  const exemptDirectories = {};
  for (const [key, value] of Object.entries(root.exemptDirectories || {})) {
    const normalized = normalizeRelative(key);
    if (normalized) {
      exemptDirectories[normalized] = {
        ...(value || {}),
        path: normalized
      };
    }
  }
  return {
    schemaVersion: STORE_VERSION,
    fileDecisions,
    exemptDirectories,
    targetFreeBytes: Number(root.targetFreeBytes || 0),
    minimumFreeBytes: Number(root.minimumFreeBytes || 0),
    updatedAt: root.updatedAt || null
  };
}

function mergeRootPreferences(roots = []) {
  return roots.filter(Boolean).reduce((merged, root) => ({
    fileDecisions: {
      ...(merged.fileDecisions || {}),
      ...(root.fileDecisions || {})
    },
    exemptDirectories: {
      ...(merged.exemptDirectories || {}),
      ...(root.exemptDirectories || {})
    },
    targetFreeBytes: Math.max(Number(merged.targetFreeBytes || 0), Number(root.targetFreeBytes || 0)),
    minimumFreeBytes: Math.max(Number(merged.minimumFreeBytes || 0), Number(root.minimumFreeBytes || 0)),
    updatedAt: root.updatedAt || merged.updatedAt || null
  }), {});
}

function ensureRoot(store, rootPath) {
  const key = rootKey(rootPath);
  if (!store.roots[key]) {
    store.roots[key] = {
      fileDecisions: {},
      exemptDirectories: {},
      targetFreeBytes: 0,
      minimumFreeBytes: 0,
      updatedAt: new Date().toISOString()
    };
  }
  return store.roots[key];
}

async function readStore() {
  const filePath = preferencesFilePath();
  try {
    const store = JSON.parse(await fs.readFile(filePath, "utf8"));
    return {
      schemaVersion: STORE_VERSION,
      roots: store.roots && typeof store.roots === "object" ? store.roots : {}
    };
  } catch (error) {
    return { schemaVersion: STORE_VERSION, roots: {} };
  }
}

async function writeStore(store) {
  const filePath = preferencesFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(store, null, 2), "utf8");
}

function preferencesFilePath() {
  const base = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, "MaidSpace")
    : path.join(os.tmpdir(), "maidspace");
  return path.join(base, "preferences.json");
}

function rootKey(rootPath) {
  return path.resolve(rootPath || ".").replace(/\\/g, "/").toLowerCase();
}

function rootKeyAliases(rootPath) {
  const key = rootKey(rootPath);
  const aliases = new Set([key]);
  const driveMatch = key.match(/^([a-z]):\/?$/i);
  if (driveMatch) {
    aliases.add(`//?/${driveMatch[1].toLowerCase()}:/`);
  }
  const verbatimDriveMatch = key.match(/^\/\/\?\/([a-z]):\/?$/i);
  if (verbatimDriveMatch) {
    aliases.add(`${verbatimDriveMatch[1].toLowerCase()}:/`);
  }
  return Array.from(aliases);
}

function normalizeRelative(value) {
  const normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .trim()
    .toLowerCase();
  if (!normalized || normalized === ".") {
    return "";
  }
  return path.posix.normalize(normalized).replace(/^\.$/, "");
}

function isInsideAnyDirectory(relativePath, directories) {
  return directories.some((directory) => relativePath === directory || relativePath.startsWith(`${directory}/`));
}

module.exports = {
  applyPreferencesToAddReport,
  loadRootPreferences,
  saveExemptDirectories,
  saveFileDecision,
  saveTargetPreference,
  normalizeRelative
};
