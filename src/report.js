function generateSrcReport({ addReport, relocationPlan, continuousState }) {
  const summary = addReport.summary || {};
  const lines = [
    "# MaidSpace - Relatorio de Analise",
    "",
    `Diretorio: ${addReport.rootPath}`,
    `Gerado em: ${summary.scannedAt || new Date().toISOString()}`,
    "",
    "## Grafo de Dependencias",
    `- Arquivos analisados: ${summary.files || 0}`,
    `- Diretorios analisados: ${summary.directories || 0}`,
    `- Dependencias internas: ${summary.edges || 0}`,
    `- Componentes: ${summary.components || 0}`,
    `- Ciclos/Blocos interdependentes: ${summary.cycles || 0}`,
    `- Pode apagar: ${summary.canDelete || 0}`,
    `- Inutil provavel: ${summary.probablyUseless || 0}`,
    `- Nao apagar: ${summary.mustKeep || 0}`,
    "",
    "## Risco",
    `- Baixo: ${summary.byRisk?.baixo || 0}`,
    `- Medio: ${summary.byRisk?.medio || 0}`,
    `- Alto: ${summary.byRisk?.alto || 0}`,
    `- Critico: ${summary.byRisk?.critico || 0}`,
    "",
    "## Plano de Limpeza",
    `- Espaco realocavel em modo baixo: ${relocationPlan.summary?.reallocatableHuman?.baixo || "0 B"}`,
    `- Espaco realocavel em modo medio: ${relocationPlan.summary?.reallocatableHuman?.medio || "0 B"}`,
    `- Espaco realocavel em modo alto: ${relocationPlan.summary?.reallocatableHuman?.alto || "0 B"}`,
    `- Simulacao baixo: antes ${relocationPlan.relocationSimulation?.baixo?.beforeHuman || "0 B"}, depois ${relocationPlan.relocationSimulation?.baixo?.remainingHuman || "0 B"}`,
    `- Simulacao medio: antes ${relocationPlan.relocationSimulation?.medio?.beforeHuman || "0 B"}, depois ${relocationPlan.relocationSimulation?.medio?.remainingHuman || "0 B"}`,
    `- Simulacao alto: antes ${relocationPlan.relocationSimulation?.alto?.beforeHuman || "0 B"}, depois ${relocationPlan.relocationSimulation?.alto?.remainingHuman || "0 B"}`,
    `- Arquivos bloqueados: ${relocationPlan.summary?.blockedFiles || 0}`,
    `- Espaco bloqueado: ${relocationPlan.summary?.blockedHuman || "0 B"}`,
    `- Relatorio de seguranca: ${relocationPlan.safetyReport?.text || "nao gerado"}`,
    "",
    "## Estado da Limpeza",
    `- Modo: ${continuousState.mode}`,
    `- Novos arquivos: ${continuousState.summary?.newFiles || 0}`,
    `- Removidos: ${continuousState.summary?.removedFiles || 0}`,
    `- Modificados: ${continuousState.summary?.modifiedFiles || 0}`,
    `- Mudancas de dependencia: ${continuousState.summary?.dependencyChangedFiles || 0}`,
    `- Reanalise necessaria: ${continuousState.summary?.reanalysisNeeded ? "sim" : "nao"}`,
    "",
    "## Regras de seguranca",
    "- O MaidSpace nao apaga arquivos automaticamente.",
    "- O MaidSpace nao move arquivos automaticamente.",
    "- Ciclos sao tratados como blocos interdependentes.",
    "- Dependencias externas ao diretorio analisado sao ignoradas no grafo local.",
    "- Quando a seguranca nao e provada, a decisao cai para revisao."
  ];

  return {
    format: "markdown",
    text: lines.join("\n"),
    highlights: {
      add: "mapeia impacto e risco",
      are: "gera plano nao destrutivo",
      alc: "salva e compara estados"
    }
  };
}

module.exports = {
  generateSrcReport,
  gerar_relatorio: generateSrcReport
};
