// Seeded dev users + OAuth client. These are reference credentials for local
// development and tests ONLY — they are also printed in the startup log and
// documented in server/README.md.

export const DEV_USERS = Object.freeze([
  {
    username: 'alice',
    email: 'alice@example.com',
    name: 'Alice Liddell',
    password: 'correct-horse-battery-staples',
  },
  {
    username: 'bob',
    email: 'bob@example.com',
    name: 'Bob Example',
    password: 'correct-horse-staple',
  },
]);

// Default dev OAuth client used by the curl walkthrough in the README.
export const DEV_CLIENT = Object.freeze({
  client_id: 'note-haven-dev',
  client_secret: 'dev-secret-not-for-prod',
  client_name: 'Note Haven (dev)',
  redirect_uris: ['http://localhost:4173/auth/callback'],
  token_endpoint_auth_method: 'client_secret_post',
  public: false,
});

export const DEV_CLIENT_PUBLIC = Object.freeze({
  client_id: 'note-haven-pkce',
  client_name: 'Note Haven SPA (public, PKCE only)',
  redirect_uris: ['http://localhost:4173/auth/callback'],
  token_endpoint_auth_method: 'none',
  public: true,
});