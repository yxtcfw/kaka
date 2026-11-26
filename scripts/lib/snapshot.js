// 快照与回滚：AI 写 tree/rules 前先存快照；rollback 按时间戳或 latest 还原。
import fs from 'node:fs';
import path from 'node:path';
import { snapshot, atomicWriteJson } from './util.js';

export const SNAPSHOTTABLE = [
  'data/tree.json',
  'config/manifest.json',
  'data/site.json',
  'rules/signals-tree.json',
  'rules/nav-classify.json',
  'rules/source-grade.json',
  'rules/autopilot.json'
];

export function makeSnapshots(root, label = 'pre-write') {
  const dir = path.join(root, 'snapshots');
  const stamp = new Date().toISOString();
  const made = [];
  for (const rel of SNAPSHOTTABLE) {
    const file = path.join(root, rel);
    const dest = snapshot(file, path.join(dir, label), stamp);
    if (dest) made.push({ from: rel, to: path.relative(root, dest) });
  }
  return { stamp, made };
}

export function listSnapshots(root) {
  const dir = path.join(root, 'snapshots');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.json') || /\.(json\.\d{4}-)/.test(entry.name)) {
        out.push(path.relative(root, p));
      }
    }
  };
  walk(dir);
  return out.sort();
}

// 找到某个被快照文件的最近一个版本（按文件名前缀 + 时间戳排序）。
export function findLatestSnapshot(root, rel) {
  const base = path.basename(rel);
  const dir = path.join(root, 'snapshots');
  const candidates = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.startsWith(base + '.')) candidates.push(p);
    }
  };
  walk(dir);
  candidates.sort();
  return candidates.length ? candidates[candidates.length - 1] : null;
}

export function rollbackFile(root, rel, snapFile) {
  const src = snapFile || findLatestSnapshot(root, rel);
  if (!src || !fs.existsSync(src)) return { ok: false, reason: 'no snapshot found' };
  const content = JSON.parse(fs.readFileSync(src, 'utf8'));
  atomicWriteJson(path.join(root, rel), content);
  return { ok: true, restored: rel, from: path.relative(root, src) };
}
