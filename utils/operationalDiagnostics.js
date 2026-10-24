import { DEFAULT_STUDENT_PASSWORD, DEFAULT_STAFF_PASSWORD } from './creationDefaults.js';

// Persist useful diagnostics, never raw request bodies, provider responses or credentials.
export function redactDiagnostic(value, limit = 3000) {
  let text = String(value || '');
  for (const secret of [DEFAULT_STUDENT_PASSWORD, DEFAULT_STAFF_PASSWORD]) text = text.split(secret).join('[REDACTED]');
  for (const [name, secret] of Object.entries(process.env)) {
    if (/PASS|SECRET|TOKEN|API_KEY|ACCESS_KEY|MONGO_URI/i.test(name) && secret?.length >= 4) text = text.split(secret).join('[REDACTED]');
  }
  return text.replace(/(?:https?|mongodb(?:\+srv)?):\/\/[^\s<>"']+/gi, '[URL REDACTED]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/((?:password|token|secret|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(?:eyJ[\w-]+\.[\w-]+\.[\w-]+|owa_[\w-]+|github_pat_[\w]+)\b/g, '[REDACTED]')
    .slice(0, limit);
}

export function errorDiagnostic(error) {
  return {
    at: new Date(), name: redactDiagnostic(error?.name || 'Error', 100),
    message: redactDiagnostic(error?.message || 'Unknown error'),
    code: redactDiagnostic(error?.code || error?.cause?.code || '', 100),
    status: Number(error?.status || error?.$metadata?.httpStatusCode) || undefined,
    providerRequestId: redactDiagnostic(error?.$metadata?.requestId || '', 200),
    stack: redactDiagnostic(error?.stack, 4000),
    cause: redactDiagnostic(error?.cause?.message, 1000),
  };
}
