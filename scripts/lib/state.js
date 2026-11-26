// 状态读写门面：三道判据进度 + siteFilled 标记，所有写走原子写。
import path from 'node:path';
import { atomicWriteJson, sha256 } from './util.js';
import { readJson, ROOT } from './validate.js';

export function statePath(root = ROOT) {
  return path.join(root, 'state.json');
}

export function loadState(root = ROOT) {
  return readJson(statePath(root));
}

export function saveState(state, root = ROOT) {
  state.runs ||= [];
  atomicWriteJson(statePath(root), state);
  return state;
}

export function recordRun(state, { stage, provider, summary, inputs }) {
  state.runs ||= [];
  state.runs.push({
    at: new Date().toISOString(),
    stage,
    provider: provider || 'mock',
    inputHash: sha256(inputs || {}),
    summary: summary || ''
  });
  if (state.runs.length > 200) state.runs = state.runs.slice(-200);
  return state;
}

// 判据①：联想词 ≥阈值、≥源数、新增率 <上限。
export function signalsPassed(state, manifest) {
  const t = manifest.thresholds;
  return state.signals.count >= t.signalsMin
    && state.signals.sources >= t.signalsSourcesMin
    && state.signals.newRate < t.signalsNewRateMax;
}

// 判据②：≥1 条 L1 官方源 或 ≥2 条独立域 L2。
export function sourcesPassed(state, manifest) {
  const t = manifest.thresholds;
  return state.sources.l1 >= t.sourceL1Min || state.sources.independentL2 >= t.sourceL2IndependentMin;
}

// 判据③：门禁至少拦下过 1 次 + 已生成内容。
export function contentPassed(state, manifest) {
  return state.content.generated > 0 && state.content.gateBlocked >= manifest.thresholds.gateBlocksMin;
}
