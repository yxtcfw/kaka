// 回滚：按快照还原 tree/rules/site/manifest（v7 阶段 0.5）。
import path from 'node:path';
import fs from 'node:fs';
import { ROOT } from './lib/validate.js';
import { rollbackFile, findLatestSnapshot, listSnapshots } from './lib/snapshot.js';

export function runRollback(root = ROOT, args = {}) {
  const rel = args.file;
  if (!rel) {
    return { stage: 'rollback', error: '需指定 --file <相对路径>', available: listSnapshots(root) };
  }
  const result = rollbackFile(root, rel, args.snapshot || null);
  return { stage: 'rollback', ...result };
}
