// ddgs 无 key 搜索适配器。网络发生在外部 Python 适配器，Node 侧经 guard.throttleOnly 统一限速。
// 双通道：opts.adapterFn(query, limit) 注入优先（测试/外部系统）；否则 spawn adapters/ddgs_search.py。
// 失败显式抛错，由上层 discover 降级 mock 并写报告，不静默伪造。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from './validate.js';

function runPythonAdapter(query, limit, root) {
  return new Promise((resolve, reject) => {
    const script = path.join(root, 'adapters', 'ddgs_search.py');
    const python = process.env.PYTHON || 'python3';
    const child = spawn(python, [script, query, String(limit)], { cwd: root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (e) => reject(new Error(`ddgs 适配器启动失败: ${e.message}`)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ddgs 适配器退出码 ${code}: ${(stderr || stdout).slice(0, 300)}`));
        return;
      }
      let data;
      try { data = JSON.parse(stdout); }
      catch { reject(new Error(`ddgs 适配器输出非法 JSON: ${stdout.slice(0, 200)}`)); return; }
      if (data && data.error) { reject(new Error(`ddgs 适配器错误: ${data.error}`)); return; }
      resolve(Array.isArray(data) ? data : (data.results || []));
    });
  });
}

// 执行 ddgs 搜索。返回统一候选结构 {url,title,snippet,provider,query}。
export async function ddgsSearch(terms, opts = {}) {
  const guard = opts.guard || null;
  const limit = Math.max(1, Number(opts.limit || 5));
  const out = [];
  for (const term of terms) {
    if (guard) await guard.throttleOnly();
    let rows;
    if (typeof opts.adapterFn === 'function') {
      rows = await opts.adapterFn(term, limit);
    } else {
      rows = await runPythonAdapter(term, limit, opts.root || ROOT);
    }
    for (const r of rows || []) {
      if (!r || !r.url) continue;
      out.push({
        url: r.url,
        title: r.title || r.url,
        snippet: r.snippet || '',
        provider: 'ddgs',
        query: term
      });
    }
  }
  return out;
}
