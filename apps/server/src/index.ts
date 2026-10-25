import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildApp } from './app';

const port = Number(process.env.PORT ?? 8787);
// Local tool: listen on loopback only, so the proxy is not exposed to the network. Hosted (Render): HOST=0.0.0.0.
const onRender = process.env.RENDER === 'true'; // Render sets this itself
const host = process.env.HOST ?? (onRender ? '0.0.0.0' : '127.0.0.1');

const app = buildApp(); // data/auditor.db unless DB_PATH is set

// Hosted: serve the built web app from the same origin so /api needs no CORS or proxy (and SSE passes through).
const webDist = process.env.WEB_DIST ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if ((process.env.SERVE_WEB === '1' || onRender) && existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'),
  );
}

app.listen({ port, host }).then(
  () => {
    console.log(`Zoning Map Date Auditor server on http://${host}:${port}`);
    if (process.env.UPSTREAM_PROXY) console.log(`Using upstream proxy ${process.env.UPSTREAM_PROXY}`);
  },
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
