import { createBridgeServer } from './server.js';

const bridge = createBridgeServer();

try {
  const address = await bridge.listen();
  const host = typeof address === 'object' && address ? address.address : bridge.config.host;
  const port = typeof address === 'object' && address ? address.port : bridge.config.port;

  process.stdout.write(`snapclip bridge listening on http://${host}:${port}\n`);

  const stop = async () => {
    await bridge.close();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
