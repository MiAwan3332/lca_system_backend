import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

export const creationContext = new AsyncLocalStorage();
let writes = Promise.resolve();
let cleanedDay = '';
let pendingWrites = 0;

export function creationAudit(event, values = {}) {
  const entry = { time: new Date().toISOString(), event, ...creationContext.getStore(), ...values };
  const line = JSON.stringify(entry);
  console.log(line);
  const directory = process.env.CREATION_LOG_DIR;
  if (!directory) return;
  if (pendingWrites >= 500) return; // Keep a logging outage from exhausting application memory.
  pendingWrites++;
  // A persistent daily log survives container replacement, unlike Docker logs.
  writes = writes.then(async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const day = entry.time.slice(0, 10);
    const current = path.join(directory, `${day}.jsonl`);
    const size = await fs.stat(current).then((stat) => stat.size).catch(() => 0);
    if (size > 10 * 1024 * 1024) {
      await fs.unlink(`${current}.1`).catch(() => {});
      await fs.rename(current, `${current}.1`);
    }
    await fs.appendFile(current, `${line}\n`, { mode: 0o600 });
    if (cleanedDay !== day) {
      cleanedDay = day;
      const cutoff = Date.now() - 30 * 86400000;
      for (const file of await fs.readdir(directory)) {
        if (/^\d{4}-\d{2}-\d{2}\.jsonl(?:\.1)?$/.test(file) && Date.parse(file.slice(0, 10)) < cutoff) {
          await fs.unlink(path.join(directory, file));
        }
      }
    }
  }).catch(() => console.error('creation_audit_write_failed')).finally(() => { pendingWrites--; });
}

export async function creationStep(step, run) {
  const started = Date.now();
  try {
    const result = await run();
    creationAudit('creation_step', { step, durationMs: Date.now() - started, outcome: 'complete' });
    return result;
  } catch (error) {
    // Do not persist provider responses, phone numbers, credentials, or request bodies.
    creationAudit('creation_step', { step, durationMs: Date.now() - started, outcome: 'failed', errorType: error.name });
    throw error;
  }
}

export async function flushCreationAudit() {
  let timer;
  try { await Promise.race([writes, new Promise((resolve) => { timer = setTimeout(resolve, 1500); })]); }
  finally { clearTimeout(timer); }
}
