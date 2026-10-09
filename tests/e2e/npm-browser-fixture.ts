import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const uRL = new URL('../fixtures/npm-browser/index.html', import.meta.url);
const html = readFileSync(uRL, 'utf8');
const uRL2 = new URL('../fixtures/npm-browser/frame.html', import.meta.url);
const frameHtml = readFileSync(uRL2, 'utf8');
export async function startNpmBrowserFixture(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if (request.url === '/api') {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"fixture":true}');
    } else {
      response.setHeader('Content-Type', 'text/html');
      const argumentValue = request.url === '/frame' ? frameHtml : html;
      response.end(argumentValue);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind a TCP port');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        server.closeAllConnections();
      }),
  };
}
