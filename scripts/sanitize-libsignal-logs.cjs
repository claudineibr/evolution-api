const { readFileSync, writeFileSync } = require('node:fs');

const sourcePath = require.resolve('libsignal/src/session_record');
const replacements = [
  ['console.warn("Session already closed", session);', 'console.warn("Session already closed");'],
  ['console.info("Closing session:", session);', 'console.info("Closing session");'],
  ['console.info("Opening session:", session);', 'console.info("Opening session");'],
  ['console.info("Removing old closed session:", oldestSession);', 'console.info("Removing old closed session");'],
];
const source = readFileSync(sourcePath, 'utf8');
let sanitized = source;

for (const [unsafeLog, safeLog] of replacements) {
  if (sanitized.includes(unsafeLog)) {
    if (sanitized.split(unsafeLog).length !== 2) {
      throw new Error('[LibsignalLogs] Unexpected duplicate session log; review the installed dependency');
    }
    sanitized = sanitized.replace(unsafeLog, safeLog);
  } else if (!sanitized.includes(safeLog)) {
    throw new Error('[LibsignalLogs] Unexpected session log format; review the installed dependency');
  }
}

if (sanitized !== source) {
  writeFileSync(sourcePath, sanitized);
}

console.info('[LibsignalLogs] Session key dumps removed');
