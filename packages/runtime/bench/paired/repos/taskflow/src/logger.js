const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({ level = 'info', sink = console.log } = {}) {
  const min = LEVELS[level];
  const write = (lvl) => (message, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    sink(`${lvl.toUpperCase()} ${message}${Object.keys(fields).length ? ' ' + JSON.stringify(fields) : ''}`);
  };
  return { debug: write('debug'), info: write('info'), warn: write('warn'), error: write('error') };
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
