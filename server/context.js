// Who the current request is for, carried without threading a parameter through
// every function that might one day need it.
//
// The alternative was passing a user id from the route down to
// sources/spotify.js, which calls getAccessToken() four levels below any
// handler. One missed parameter there does not fail — it silently reaches for
// whatever token is lying around, which in a multi-tenant server is somebody
// else's Spotify account. Reading the current user from an async-scoped store
// cannot be forgotten: outside a scope there is no user at all and the call
// throws.
//
// AsyncLocalStorage keeps a store per async call chain, so two requests in
// flight at once never see each other's user. This is the piece that makes
// "a database per user" enforceable rather than merely intended.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * Run `fn` as `user`, with `db` as the only database anything inside can reach.
 *
 * @param {{userId: string, db: import('node:sqlite').DatabaseSync}} ctx
 */
export function runAsUser(ctx, fn) {
  if (!ctx?.userId || !ctx?.db) throw new Error('runAsUser needs a user id and a database');
  return storage.run(ctx, fn);
}

/** The current context, or null outside a request — never a default user. */
export function currentContext() {
  return storage.getStore() ?? null;
}

/**
 * The current user's database. Throws rather than falling back, because every
 * fallback here is a way to read the wrong person's library.
 */
export function currentDb() {
  const ctx = storage.getStore();
  if (!ctx) {
    throw new Error(
      'No user in scope. Every database read on the server happens inside ' +
        'runAsUser(); reaching this means a code path skipped the session check.'
    );
  }
  return ctx.db;
}

export function currentUserId() {
  return storage.getStore()?.userId ?? null;
}
