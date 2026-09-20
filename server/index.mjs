// Note Haven reference sync server — entry point.
//
//   node server/index.mjs --port 8080
//
// Zero third-party dependencies: Node stdlib only. See server/README.md.
import http from 'node:http';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { buildConfig } from './config.mjs';
import { Store } from './store.mjs';
import { DEV_USERS } from './seed.mjs';
import { SessionManager, hashPassword } from './authn.mjs';
import { OidcService } from './oidc.mjs';
import { loadOrCreateKeys } from './keys.mjs';
import { createRouter } from './routes.mjs';

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string', short: 'p' },
      host: { type: 'string', short: 'H' },
      'data-dir': { type: 'string' },
      'issuer': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    allowNegative: false,
  });
  if (values.help) {
    console.log(`Note Haven sync server

Options:
  --port <n>        TCP port (default 8080, env PORT)
  --host <name>     bind address (default localhost, env HOST)
  --data-dir <dir>  where state lives (default server/data, env NOTEHAVEN_DATA_DIR)
  --issuer <url>    override the issuer URL (env NOTEHAVEN_ISSUER)
  -h, --help        this help
`);
    process.exit(0);
  }
  const args = {};
  if (values.port) args.port = Number.parseInt(values.port, 10);
  if (values.host) args.host = values.host;
  if (values['data-dir']) args.dataDir = path.resolve(values['data-dir']);
  if (values.issuer) args.issuer = values.issuer;
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const config = buildConfig({ args });

  const store = new Store(config.dataDir);
  await store.load();

  // Seed dev users (idempotent): scrypt hash only if the user is new.
  for (const seed of DEV_USERS) {
    if (!store.findUserByUsername(seed.username)) {
      const { salt, hash } = hashPassword(seed.password);
      store.upsertUser({
        sub: crypto.randomUUID(),
        username: seed.username,
        email: seed.email,
        name: seed.name,
        salt,
        hash,
        created_at: new Date().toISOString(),
      });
      console.log(`[seed] created dev user ${seed.email}`);
    }
  }

  const keys = await loadOrCreateKeys(config.dataDir);
  const sessions = new SessionManager({ secret: keys.privatePem, ttlSeconds: config.sessionTtlSeconds });
  const oidc = new OidcService({ issuer: config.issuer, store, keys, sessions, config });

  // Small adapters so routes.mjs can ask the service for the discovery/JWKS
  // documents without importing keys.mjs.
  if (!oidc.discoveryDocumentPublic) {
    const { discoveryDocument } = await import('./oidc.mjs');
    oidc.discoveryDocumentPublic = () => discoveryDocument(config.issuer);
  }
  if (!oidc.publicJwk) {
    const { publicJwkFromPem } = await import('./keys.mjs');
    oidc.publicJwk = () => publicJwkFromPem(keys.publicPem, keys.kid);
  }

  const router = createRouter({ config, store, oidc, keys, sessions });
  const server = http.createServer(router);

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${signal}] flushing state and shutting down…`);
    try {
      store.flushAllSync();
    } catch (err) {
      console.error('[shutdown] flush failed:', err.message);
    }
    server.close(() => process.exit(0));
    // Hard exit if connections linger.
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  console.log(`Note Haven sync server listening on http://${config.host}:${config.port}`);
  console.log(`Issuer: ${config.issuer}`);
  console.log(`Dev users: ${DEV_USERS.map((u) => `${u.email} / ${u.password}`).join(', ')}`);
  console.log(`Dev client: client_id=note-haven-dev client_secret=dev-secret-not-for-prod`);
  console.log(`Data dir: ${config.dataDir}`);
  console.log(`Signing key: kid=${keys.kid}${keys.persisted ? ' (loaded from data/keys.json)' : ' (newly generated)'}`);
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});