#!/usr/bin/env node
// ctx.mjs — метрики текущей pi-сессии для скилла session-gate.
// Usage: node ctx.mjs [--json] [--window N] [path/to/session.jsonl]
// Окно можно задать вручную: --window N или SESSION_GATE_CONTEXT_WINDOW=N.
// Источник пути: аргумент -> $PI_SESSION_FILE -> самый свежий файл сессии текущего cwd.
// Зависимостей нет: работает на node и на bun.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
const DEFAULT_RESERVE = 16384;

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const winArgIdx = argv.indexOf("--window");
if (winArgIdx >= 0) process.env.SESSION_GATE_CONTEXT_WINDOW = argv[winArgIdx + 1] || "";
const explicitPath = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--window");

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function sessionDirFor(cwd) {
  const key = cwd.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-");
  return path.join(AGENT_DIR, "sessions", `--${key}--`);
}

function latestSessionFile() {
  const dir = process.env.PI_CODING_AGENT_SESSION_DIR || sessionDirFor(process.cwd());
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
  } catch {
    return null;
  }
  return files.length ? path.join(dir, files[0].f) : null;
}

function resolveContextWindow(provider, modelId) {
  const envWindow = Number(process.env.SESSION_GATE_CONTEXT_WINDOW);
  if (Number.isFinite(envWindow) && envWindow > 0) return { window: envWindow, source: "env" };

  const store = readJson(path.join(AGENT_DIR, "models-store.json"));
  if (store && provider && store[provider]) {
    const m = (store[provider].models || []).find((x) => x.id === modelId);
    if (m && Number.isFinite(m.contextWindow)) return { window: m.contextWindow, source: "models-store" };
  }
  const models = readJson(path.join(AGENT_DIR, "models.json"));
  const pm = models?.providers?.[provider];
  const entry = (pm?.models || []).find((x) => x.id === modelId);
  if (entry && Number.isFinite(entry.contextWindow)) return { window: entry.contextWindow, source: "models.json" };

  // Кастомный провайдер (свой baseUrl/ключ) наследует окно от того же id модели в каталоге Pi.
  if (store && modelId) {
    for (const [pid, p] of Object.entries(store)) {
      const m = (p.models || []).find((x) => x.id === modelId);
      if (m && Number.isFinite(m.contextWindow)) return { window: m.contextWindow, source: `models-store:${pid}` };
    }
  }
  return { window: null, source: "unknown" };
}

function resolveReserve() {
  const global = readJson(path.join(AGENT_DIR, "settings.json"));
  const project = readJson(path.join(process.cwd(), ".pi", "settings.json"));
  const v = project?.compaction?.reserveTokens ?? global?.compaction?.reserveTokens;
  return Number.isFinite(v) ? v : DEFAULT_RESERVE;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && (b.type === "text" || typeof b.text === "string"))
    .map((b) => b.text || "")
    .join("\n");
}

function oneLine(s, max) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

const file = explicitPath || process.env.PI_SESSION_FILE || latestSessionFile();
if (!file) {
  console.error("ctx.mjs: не найден файл сессии (нет $PI_SESSION_FILE и пустой каталог сессий)");
  process.exit(1);
}

let lines;
try {
  lines = fs.readFileSync(file, "utf8").trim().split("\n");
} catch (e) {
  console.error(`ctx.mjs: не читается ${file}: ${e.message}`);
  process.exit(1);
}

const m = {
  file,
  cwd: null,
  sessionId: null,
  startedAt: null,
  lastAt: null,
  users: [],
  assistantTurns: 0,
  toolCalls: 0,
  toolResults: 0,
  toolErrors: 0,
  toolOutputChars: 0,
  systemMessages: 0,
  customMessages: 0,
  compactions: [],
  branchSummaries: 0,
  modelChanges: 0,
  thinkingChanges: 0,
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, costKnown: false },
  lastUsage: null,
  lastModel: { provider: null, model: null },
  files: new Map(),
};

for (const line of lines) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  if (e.type === "session") {
    m.sessionId = e.id;
    m.cwd = e.cwd || null;
    m.startedAt = e.timestamp;
    continue;
  }
  if (e.timestamp) m.lastAt = e.timestamp;
  if (e.type === "model_change") {
    m.modelChanges++;
    m.lastModel = { provider: e.provider, model: e.modelId };
    continue;
  }
  if (e.type === "thinking_level_change") {
    m.thinkingChanges++;
    continue;
  }
  if (e.type === "compaction") {
    m.compactions.push(Number.isFinite(e.tokensBefore) ? e.tokensBefore : null);
    if (e.usage) addUsage(e.usage);
    continue;
  }
  if (e.type === "branch_summary") {
    m.branchSummaries++;
    if (e.usage) addUsage(e.usage);
    continue;
  }
  if (e.type === "usage" && e.usage) {
    addUsage(e.usage);
    continue;
  }
  const msg = e.message;
  if (!msg) continue;
  if (msg.role === "system") {
    m.systemMessages++;
    continue;
  }
  if (msg.role === "custom") {
    m.customMessages++;
    continue;
  }
  if (msg.role === "user") {
    const t = textOf(msg.content);
    if (t.trim()) m.users.push({ timestamp: e.timestamp, text: t });
    continue;
  }
  if (msg.role === "assistant") {
    m.assistantTurns++;
    if (msg.usage) {
      m.lastUsage = msg.usage;
      addUsage(msg.usage);
    }
    if (msg.provider || msg.model) m.lastModel = { provider: msg.provider || m.lastModel.provider, model: msg.model || m.lastModel.model };
    if (Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b?.type === "toolCall") {
          m.toolCalls++;
          const a = b.arguments || {};
          const p = a.path || a.file || a.pattern || a.filePath;
          if (typeof p === "string" && p) m.files.set(p, (m.files.get(p) || 0) + 1);
        }
      }
    }
    continue;
  }
  if (msg.role === "toolResult") {
    m.toolResults++;
    if (msg.isError) m.toolErrors++;
    m.toolOutputChars += textOf(msg.content).length;
    continue;
  }
}

function addUsage(u) {
  for (const k of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (Number.isFinite(u[k])) m.usage[k] += u[k];
  }
  const c = u.cost?.total;
  if (Number.isFinite(c) && c > 0) {
    m.usage.cost += c;
    m.usage.costKnown = true;
  }
}

const provider = m.lastModel.provider || process.env.PI_PROVIDER || null;
const modelId = m.lastModel.model || process.env.PI_MODEL || null;
const { window, source: windowSource } = resolveContextWindow(provider, modelId);
const reserve = resolveReserve();
const usable = window ? Math.max(window - reserve, 1) : null;

const ctxNow = m.lastUsage
  ? (m.lastUsage.input || 0) + (m.lastUsage.cacheRead || 0) + (m.lastUsage.cacheWrite || 0)
  : null;
const pct = usable && ctxNow != null ? ctxNow / usable : null;
const stage = pct == null ? "unknown" : pct >= 0.8 ? "hot" : pct >= 0.4 ? "warn" : "ok";

const toolOutputTokens = Math.round(m.toolOutputChars / 4);
const elapsedMs =
  m.startedAt && m.lastAt ? Math.max(new Date(m.lastAt) - new Date(m.startedAt), 0) : null;
const elapsed = (() => {
  if (elapsedMs == null) return "?";
  const min = Math.round(elapsedMs / 60000);
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}m`;
})();

const topFiles = [...m.files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);

const fmt = (n) => (n == null ? "?" : n.toLocaleString("en-US"));
const prompts = m.users.map((u, i) => ({ i: i + 1, timestamp: u.timestamp, text: oneLine(u.text, 90) }));

const report = {
  file,
  sessionId: m.sessionId,
  cwd: m.cwd,
  provider,
  model: modelId,
  contextWindow: window,
  windowSource,
  reserveTokens: reserve,
  usableTokens: usable,
  ctxNow,
  ctxPct: pct == null ? null : Number((pct * 100).toFixed(1)),
  stage,
  thresholds: usable ? { warn: Math.round(usable * 0.4), hot: Math.round(usable * 0.8) } : null,
  userPrompts: m.users.length,
  assistantTurns: m.assistantTurns,
  toolCalls: m.toolCalls,
  toolResults: m.toolResults,
  toolErrors: m.toolErrors,
  toolOutputTokens,
  toolOutputVsCtx: ctxNow ? Number((toolOutputTokens / ctxNow).toFixed(1)) : null,
  compactions: m.compactions.length,
  compactionTokensBefore: m.compactions,
  branchSummaries: m.branchSummaries,
  modelChanges: m.modelChanges,
  customMessages: m.customMessages,
  elapsed,
  usage: m.usage.costKnown ? { ...m.usage, cost: Number(m.usage.cost.toFixed(4)) } : { ...m.usage, cost: null },
  topFiles: topFiles.map(([p, n]) => ({ path: p, touches: n })),
  prompts,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const out = [];
out.push(`сессия   ${(report.sessionId || "?").slice(0, 8)}  cwd=${report.cwd || process.cwd()}`);
out.push(
  `модель   ${provider || "?"}/${modelId || "?"}  окно=${fmt(window)}${window ? ` (запас ${fmt(reserve)})` : " (неизвестно)"}`,
);
out.push(
  `контекст ${fmt(ctxNow)}${pct != null ? ` = ${report.ctxPct}% от ${fmt(usable)}` : ""}  stage=${stage}` +
    (report.thresholds ? `  [warn ${fmt(report.thresholds.warn)} / hot ${fmt(report.thresholds.hot)}]` : ""),
);
out.push(
  `ходы     user=${report.userPrompts}  assistant=${report.assistantTurns}  tool=${report.toolCalls} (${report.toolErrors} ошибок)`,
);
out.push(
  `шум      tool-вывод накоплено ≈${fmt(toolOutputTokens)} ток` +
    (report.toolOutputVsCtx != null ? ` (×${report.toolOutputVsCtx} текущего контекста)` : ""),
);
out.push(
  `сжатия   compactions=${report.compactions}${m.compactions.length ? ` (before ${m.compactions.map(fmt).join(", ")})` : ""}  branch=${report.branchSummaries}  model_change=${report.modelChanges}`,
);
out.push(
  `время    ${elapsed}   usage: in ${fmt(m.usage.input)} / out ${fmt(m.usage.output)} / cacheRead ${fmt(m.usage.cacheRead)}` +
    `   cost ${report.usage.cost == null ? "n/a" : "$" + report.usage.cost}`,
);
if (prompts.length) {
  out.push(`запросы пользователя (${prompts.length}):`);
  for (const p of prompts.slice(-6)) {
    const t = p.timestamp ? String(p.timestamp).slice(11, 16) : "--:--";
    out.push(`  ${String(p.i).padStart(2)} ${t}  ${p.text}`);
  }
  if (prompts.length > 6) out.push(`  … ещё ${prompts.length - 6} раньше`);
}
if (topFiles.length) out.push(`файлы    ${topFiles.map(([p, n]) => `${p}(${n})`).join("  ")}`);
if (!window) out.push(`примечание: окно модели неизвестно → сигнал по контексту считать нулевым (задайте --window N)`);

console.log(out.join("\n"));
