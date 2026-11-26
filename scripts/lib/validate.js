// 零依赖轻量 JSON Schema 子集校验器。
// 支持 metaschema/schema.json 声明的关键字；错误信息稳定，供 CLI/测试断言。
import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function typeOk(value, expected) {
  if (expected === 'any') return true;
  if (expected === 'object') return value !== null && !Array.isArray(value) && typeof value === 'object';
  if (expected === 'array') return Array.isArray(value);
  return typeOf(value) === expected;
}

// 校验单个 schema（递归）。返回错误字符串数组。
export function validateAgainst(value, schema, ptr = '$') {
  const errors = [];
  if (!schema || typeof schema !== 'object') return errors;

  if (schema.type && !typeOk(value, schema.type)) {
    errors.push(`${ptr}: expected type ${schema.type}, got ${typeOf(value)}`);
    return errors; // 类型不符时不再深入，避免级联噪音
  }
  if ('const' in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) {
    errors.push(`${ptr}: expected const ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${ptr}: value ${JSON.stringify(value)} not in enum ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) {
      errors.push(`${ptr}: string shorter than minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) {
      errors.push(`${ptr}: string longer than maxLength ${schema.maxLength}`);
    }
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${ptr}: number below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${ptr}: number above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${ptr}: array shorter than minItems ${schema.minItems}`);
    }
    if (schema.items) {
      value.forEach((item, i) => errors.push(...validateAgainst(item, schema.items, `${ptr}[${i}]`)));
    }
  }
  if (typeOk(value, 'object')) {
    for (const req of schema.required || []) {
      if (!(req in value)) errors.push(`${ptr}: missing required field "${req}"`);
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) errors.push(...validateAgainst(value[key], sub, `${ptr}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in (schema.properties || {}))) errors.push(`${ptr}: unexpected field "${key}"`);
      }
    }
  }
  return errors;
}

// 按数据文件的 schema 字段解析 schema 名，加载 schema/<name>.schema.json 校验。
const SCHEMA_FILES = {
  'seeds/v1': 'seeds.schema.json',
  'state/v1': 'state.schema.json',
  'manifest/v1': 'manifest.schema.json',
  'tree/v1': 'tree.schema.json',
  'navlinks/v1': 'navlinks.schema.json',
  'sources/v1': 'sources.schema.json',
  'site/v1': 'site.schema.json',
  'signals/v1': 'signals.schema.json',
  'bundle/v1': 'bundle.schema.json',
  'alerts/v1': 'alert.schema.json'
};

export function validateDoc(value, schemaDir = path.join(ROOT, 'schema')) {
  if (!value || typeof value !== 'object' || !value.schema) {
    return ['$: missing "schema" discriminator'];
  }
  const file = SCHEMA_FILES[value.schema];
  if (!file) return [`$: unknown schema discriminator "${value.schema}"`];
  const schema = readJson(path.join(schemaDir, file));
  return validateAgainst(value, schema);
}

// 校验仓库内所有已知数据文件。返回 { results: [{file, errors}], ok }。
export function validateRepo(root = ROOT) {
  const targets = [
    'seeds.json',
    'state.json',
    'config/manifest.json',
    'data/tree.json',
    'data/navlinks.json',
    'data/sources.json',
    'data/site.json'
  ];
  // 可选产物：存在才校验（如 alerts/latest.json，首次运行前不存在）
  const optional = ['alerts/latest.json'];
  const results = [];
  for (const rel of [...targets, ...optional]) {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) {
      if (optional.includes(rel)) continue;
      results.push({ file: rel, errors: ['file not found'] });
      continue;
    }
    let value;
    try {
      value = readJson(abs);
    } catch (e) {
      results.push({ file: rel, errors: [`invalid JSON: ${e.message}`] });
      continue;
    }
    results.push({ file: rel, errors: validateDoc(value, path.join(root, 'schema')) });
  }
  return { results, ok: results.every((r) => r.errors.length === 0) };
}
