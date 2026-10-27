import fs from 'node:fs/promises';
import { approvedMigrationPlan } from '../utils/accessBlueprints.js';
import { validateMigrationPlan } from '../utils/accessMigrationPlan.js';
import { accessCatalog } from '../utils/accessCatalog.js';

const arg = (key) => process.argv.find((value) => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const source = arg('snapshot'), destination = arg('plan');
if (!source || !destination) throw new Error('Supply an offline --snapshot=PATH and new --plan=PATH');
let snapshot;
try { snapshot = JSON.parse((await fs.readFile(source, 'utf8')).replace(/^\uFEFF/, '')); }
catch { throw new Error('Invalid snapshot JSON; no plan was written'); }
if (snapshot.assignments?.some((assignment) => !assignment.revokedAt)) throw new Error('Existing live assignments need explicit reconciliation before baseline migration');
const plan = approvedMigrationPlan(snapshot.users);
const report = validateMigrationPlan(plan, snapshot.users, accessCatalog, { applying: true });
if (!report.readyToActivate) throw new Error(`Activation preflight failed: ${report.errors.join('; ')} ${report.warnings.join('; ')}`);
await fs.writeFile(destination, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ users: report.accounts, roles: plan.roles.length, owners: plan.ownerUserIds.length, readyToActivate: true, databaseWrites: 0 }));
