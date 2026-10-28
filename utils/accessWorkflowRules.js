// Shared, pure workflow assistance. The catalog builder copies this module to the browser.
const groupOf = (key, catalog) => Object.entries(catalog.fieldGroups).find(([, fields]) => fields.includes(key))?.[0] || 'general';
const holdsField = (grants, key, action, catalog) => grants.some(g => g.permission === `fields.${groupOf(key, catalog)}.${action}` && (!g.fields?.length || g.fields.includes(key)));
export function workflowGaps(grants, catalog) {
  return (catalog.workflows || []).filter(rule => (!rule.all || rule.all.every(p => grants.some(g => g.permission === p))) && rule.any.some(p => grants.some(g => g.permission === p))).map(rule => {
    const scopes = [...new Set(grants.filter(g => rule.any.includes(g.permission)).map(g => g.scope))];
    const fields = ['read', 'write'].flatMap(action => (rule[action] || []).filter(key => !holdsField(grants, key, action, catalog)).map(key => ({ key, action, group: groupOf(key, catalog) })));
    const permissions = (rule.permissions || []).flatMap(permission => scopes.filter(scope => !grants.some(g => g.permission === permission && (g.scope === 'all' || g.scope === scope))).map(scope => ({ permission, scope })));
    return { ...rule, fields, permissions };
  }).filter(rule => rule.fields.length || rule.permissions.length);
}
export function completeWorkflowAccess(grants, catalog) {
  const next = grants.map(g => ({ ...g, ...(g.fields ? { fields: [...g.fields] } : {}) }));
  for (const gap of workflowGaps(grants, catalog)) {
    for (const field of gap.fields) {
      const permission = `fields.${field.group}.${field.action}`;
      const existing = next.find(g => g.permission === permission);
      if (existing) { if (existing.fields?.length && !existing.fields.includes(field.key)) existing.fields.push(field.key); }
      else next.push({ permission, scope: 'all', fields: [field.key] });
    }
    for (const grant of gap.permissions) if (!next.some(g => g.permission === grant.permission && (g.scope === 'all' || g.scope === grant.scope))) next.push(grant);
  }
  return next;
}
