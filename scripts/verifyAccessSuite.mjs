import { spawnSync } from 'node:child_process';
const commands = [
  ['scripts/buildAccessCatalog.mjs', '--check'], ['--test'],
  ['scripts/verifyAccessHttp.mjs'], ['scripts/verifyAccessAdminHttp.mjs'], ['scripts/verifyApprovedAccess.mjs'], ['scripts/verifyCreation.mjs'], ['scripts/verifyCreationHttp.mjs'], ['scripts/verifyAccountWorkflows.mjs'],
];
for (const command of commands) {
  const result = spawnSync(process.execPath, command, { stdio: 'inherit', timeout: 600000, windowsHide: true });
  if (result.error || result.status !== 0) {
    console.error(result.error?.message || `Verification failed: ${command.join(' ')}`);
    process.exit(result.status || 1);
  }
}
