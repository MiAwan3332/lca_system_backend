// Generated inventory is checked in CI. New endpoints fail closed until reviewed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { parse } = require('@babel/parser');
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((item) => walk(item, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
};
const ast = (text) => parse(text, { sourceType: 'module' });
const entry = ast(await fs.readFile(path.join(root, 'index.js'), 'utf8'));
const imports = new Map();
walk(entry, (node) => { if (node.type === 'ImportDeclaration') for (const item of node.specifiers) imports.set(item.local.name, node.source.value); });
const mounts = [];
walk(entry, (node) => {
  if (node.type === 'CallExpression' && node.callee?.object?.name === 'app' && node.callee.property?.name === 'use' &&
      node.arguments[0]?.type === 'StringLiteral' && imports.get(node.arguments[1]?.name)?.startsWith('./routes/')) {
    mounts.push({ prefix: node.arguments[0].value, file: imports.get(node.arguments[1].name) });
  }
});
const publicHandlers = new Set(['login', 'adminlogin', 'forgotPassword', 'googleCallback', 'verifyAdmissionSlip']);
const routes = [];
const fieldGroups = { general: [], contact: [], identity: [], financial: [], evidence: [], internal: [], integration: [], credentials: [] };
const readOnlyFields = ['_id', '__v', 'created_by', 'createdAt', 'updatedAt', 'user', 'actor', 'platformOwner',
  'accessManaged', 'accountType', 'disabledAt', 'accessOnboardingRole', 'creation_pending', 'creation_request',
  'creation_worker_epoch', 'processing_status'];
const classifyField = (name) => /secret|token|lease|fingerprint|^plan$|migrationKey|accessOnboarding/i.test(name) ? null
  : /password/i.test(name) ? 'credentials'
  : /evidence|attachment|resume|avatar|photo|image/i.test(name) ? 'evidence'
  : /cnic|birth|nationality/i.test(name) ? 'identity'
  : /phone|email|contact|address|^city$/i.test(name) ? 'contact'
  : /fee|cash|payment|amount|refund|discount|salary|balance|revenue|expense|paid|recovered|finance|^net$|received|^online$|^pending$/i.test(name) ? 'financial'
  : /remarks|internal|approval_comment|rejection/i.test(name) ? 'internal'
  : /google|calendar|classroom|meeting/i.test(name) ? 'integration' : 'general';
for (const file of (await fs.readdir(path.join(root, 'models'))).sort()) {
  if (!file.endsWith('.js') || file.startsWith('access')) continue;
  walk(ast(await fs.readFile(path.join(root, 'models', file), 'utf8')), (node) => {
    if (!['CallExpression', 'NewExpression'].includes(node.type) || node.callee?.property?.name !== 'Schema') return;
    for (const property of node.arguments[0]?.properties || []) {
      const key = property.key?.name || property.key?.value;
      const group = typeof key === 'string' && classifyField(key);
      if (group && !fieldGroups[group].includes(key)) fieldGroups[group].push(key);
    }
  });
}
for (const mount of mounts) {
  if (mount.file === './routes/access.js') continue;
  const tree = ast(await fs.readFile(path.join(root, mount.file), 'utf8'));
  walk(tree, (node) => {
    if (node.type !== 'CallExpression' || node.callee?.object?.name !== 'router' ||
      !['get', 'post', 'put', 'patch', 'delete'].includes(node.callee.property?.name)) return;
    if (node.arguments[0]?.type !== 'StringLiteral') throw new Error('Route inventory requires literal paths');
    const last = node.arguments.at(-1);
    const handler = last?.name || (last?.type === 'CallExpression' ? last.callee.name : null);
    if (!handler) throw new Error(`Classify inline route handler in ${mount.file}`);
    const resource = mount.prefix.replace(/^\/(api\/)?/, '');
    const permission = `${resource}.${handler.replace(/([a-z0-9])([A-Z])/g, '$1.$2').toLowerCase()}`;
    routes.push({ method: node.callee.property.name.toUpperCase(), path: `${mount.prefix}${node.arguments[0].value === '/' ? '' : node.arguments[0].value}`,
      permission, resource, handler, public: publicHandlers.has(handler), blocked: handler === 'register' });
  });
}
for (const file of (await fs.readdir(path.join(root, 'controllers'))).sort()) {
  if (!file.endsWith('.js')) continue;
  walk(ast(await fs.readFile(path.join(root, 'controllers', file), 'utf8')), (node) => {
    if (node.type !== 'CallExpression' || node.callee?.property?.name !== 'json' || node.arguments[0]?.type !== 'ObjectExpression') return;
    walk(node.arguments[0], (child) => {
      if (child.type !== 'ObjectProperty') return;
      const key = child.key?.name || child.key?.value;
      const group = typeof key === 'string' && classifyField(key);
      if (group && !fieldGroups[group].includes(key)) fieldGroups[group].push(key);
    });
  });
}
// Include request-only fields (uploads, command parameters and credential changes).
for (const directory of ['controllers', 'utils']) for (const file of (await fs.readdir(path.join(root, directory))).sort()) {
  if (!file.endsWith('.js')) continue;
  const requestObject = (node) => node?.type === 'MemberExpression' && node.object?.name === 'req' && ['body', 'files'].includes(node.property?.name);
  const recordField = (key) => {
    const group = typeof key === 'string' && classifyField(key);
    if (group && !fieldGroups[group].includes(key)) fieldGroups[group].push(key);
  };
  walk(ast(await fs.readFile(path.join(root, directory, file), 'utf8')), (node) => {
    if (['MemberExpression', 'OptionalMemberExpression'].includes(node.type) && requestObject(node.object)) recordField(node.property?.name || node.property?.value);
    if (node.type === 'VariableDeclarator' && node.id?.type === 'ObjectPattern' &&
      (requestObject(node.init) || requestObject(node.init?.left))) {
      for (const property of node.id.properties) recordField(property.key?.name || property.key?.value);
    }
  });
}
for (const fields of Object.values(fieldGroups)) fields.sort();
const permissions = [...new Map(routes.filter((route) => !route.public && !route.blocked).map((route) => [route.permission,
  { key: route.permission, group: route.resource, label: route.handler.replace(/([a-z])([A-Z])/g, '$1 $2'), type: 'action' }])).values()];
for (const [path, handler] of [['/operations/creation-metrics', 'getCreationMetrics'], ['/operations/creation-capabilities', 'getCreationCapabilities']]) {
  const permission = `operations.${handler.replace(/([a-z])([A-Z])/g, '$1.$2').toLowerCase()}`;
  routes.push({ method: 'GET', path, permission, resource: 'operations', handler, public: false, blocked: false });
  permissions.push({ key: permission, group: 'operations', label: handler, type: 'action' });
}
for (const group of [...new Set(routes.map((route) => route.resource))]) {
  for (const action of ['export', 'print']) permissions.push({ key: `${group}.${action}`, group, label: action, type: 'action' });
}
for (const group of Object.keys(fieldGroups)) {
  for (const action of group === 'credentials' ? ['write'] : ['read', 'write']) permissions.push({ key: `fields.${group}.${action}`, group: 'fields', label: `${group} ${action}`, type: 'field', fields: fieldGroups[group].filter((field) => action !== 'write' || !readOnlyFields.includes(field)).sort() });
}
for (const key of ['access.read', 'access.manage', 'access.assign', 'access.audit', 'access.explain', 'files.download']) {
  permissions.push({ key, group: key.split('.')[0], label: key, type: 'action' });
}
const workflows = JSON.parse(await fs.readFile(path.join(root, 'config/accessWorkflows.json'), 'utf8'));
for (const rule of workflows) for (const key of [...(rule.all || []), ...rule.any, ...(rule.permissions || [])]) {
  if (!permissions.some(p => p.key === key)) throw new Error(`Unknown workflow permission: ${key}`);
}
const output = `${JSON.stringify({ version: 1, routes, permissions, fieldGroups, readOnlyFields, workflows }, null, 2)}\n`;
const destination = path.join(root, 'config/accessCatalog.generated.json');
if (process.argv.includes('--check')) {
  if (await fs.readFile(destination, 'utf8') !== output) throw new Error('Route inventory changed: regenerate and review access catalog');
} else { await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, output); }
const browserCopy = path.join(root, '../lca_system_frontend/src/config/accessCatalog.generated.json');
if (await fs.stat(path.join(root, '../lca_system_frontend/src')).catch(() => null)) {
  const shared = await fs.readFile(path.join(root, 'utils/accessWorkflowRules.js'), 'utf8');
  const sharedCopy = path.join(root, '../lca_system_frontend/src/utlls/accessWorkflowRules.js');
  if (process.argv.includes('--check')) {
    if (await fs.readFile(sharedCopy, 'utf8') !== shared) throw new Error('Browser workflow rules are stale');
  } else await fs.writeFile(sharedCopy, shared);
  if (process.argv.includes('--check')) {
    if (await fs.readFile(browserCopy, 'utf8') !== output) throw new Error('Browser access catalog is stale');
  } else { await fs.mkdir(path.dirname(browserCopy), { recursive: true }); await fs.writeFile(browserCopy, output); }
}
console.log(JSON.stringify({ routes: routes.length, permissions: permissions.length }));
