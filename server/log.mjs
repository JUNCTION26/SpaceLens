/**
 * One JSON object per line, ready for the platform's log viewer. Callers pass only safe,
 * whitelisted fields; request bodies, keys and client addresses are never logged.
 */
const RANK = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger({ level = 'info', write = (line) => process.stdout.write(line), now = () => new Date() } = {}) {
  const min = RANK[level] ?? RANK.info;
  const emit = (lvl, msg, fields) => {
    if (RANK[lvl] < min) return;
    write(`${JSON.stringify({ time: now().toISOString(), level: lvl, msg, ...fields })}\n`);
  };
  return {
    debug: (msg, fields = {}) => emit('debug', msg, fields),
    info: (msg, fields = {}) => emit('info', msg, fields),
    warn: (msg, fields = {}) => emit('warn', msg, fields),
    error: (msg, fields = {}) => emit('error', msg, fields),
  };
}
