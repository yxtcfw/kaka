// 统一信源采集编排：discover-sources → fetch-body 顺序执行（v7 阶段 1.4）。
import { runDiscover } from './discover-sources.js';
import { runFetchBody } from './fetch-body.js';

export async function runCollectSources(root, args = {}) {
  const discover = await runDiscover(root, args);
  const body = await runFetchBody(root, args);
  return { stage: 'collect-sources', discover, body, passed: body.sourcesPassed === true };
}
