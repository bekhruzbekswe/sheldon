/**
 * CLI: bun run dashboard [--port N]
 *
 * Starts the local read-only dashboard at 127.0.0.1:<port>.
 */

import { createApp } from './server.ts';

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

let port = 4000;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = argv[i + 1];
  if (a === '--port' && next !== undefined) {
    port = Number(next);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) {
      console.error(`Invalid --port: ${next}`);
      process.exit(1);
    }
    i++;
  } else if (a === '--help' || a === '-h') {
    console.log('Usage: bun run dashboard [--port 4000]');
    process.exit(0);
  }
}

const app = createApp();
const server = Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch: app.fetch,
  idleTimeout: 0,
});

console.error(
  bold(`Sheldon dashboard at ${cyan(`http://127.0.0.1:${server.port}`)}`),
);
console.error(dim('Read-only · Ctrl-C to stop'));

process.on('SIGINT', () => {
  console.error(dim('\nshutting down...'));
  server.stop();
  process.exit(0);
});
