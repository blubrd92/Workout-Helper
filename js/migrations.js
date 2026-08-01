/**
 * Schema migration scaffold.
 *
 * Every user document carries a `schemaVersion`. On sign-in, the app compares it
 * to SCHEMA_VERSION from config.js and runs each migration in between, in order.
 * Old data gets upgraded; it never gets read with the wrong assumptions and it
 * never gets dropped.
 *
 * To add a migration:
 *   1. Bump SCHEMA_VERSION in js/config.js (say, 1 -> 2).
 *   2. Add an entry `2: async (ctx) => { ... }` below. It runs on data that is at
 *      version 1 and leaves it at version 2.
 *   3. Keep it idempotent where you can — a migration interrupted by a closed tab
 *      will run again next sign-in.
 *
 * Migrations receive a context object:
 *   { uid, userDoc, db, refs, getDocs, setDoc, updateDoc, doc, collection, writeBatch }
 * so they can rewrite documents without importing the store (which would create a
 * circular import).
 */

import { SCHEMA_VERSION } from './config.js';

export const MIGRATIONS = {
  // Version 1 is the initial schema, so there is nothing to migrate to it.
  // The first real migration will be `2: async (ctx) => { ... }`.
};

/**
 * Bring a user document up to the current schema version.
 * Returns the version it ended at.
 */
export async function runMigrations(ctx) {
  let version = Number(ctx.userDoc?.schemaVersion) || 0;

  // A brand new account starts at the current version; there is no history to
  // upgrade, so no migration should run against it.
  if (version === 0) return SCHEMA_VERSION;

  while (version < SCHEMA_VERSION) {
    const next = version + 1;
    const migrate = MIGRATIONS[next];
    if (!migrate) {
      // A gap means someone bumped SCHEMA_VERSION without writing the migration.
      // Failing loudly beats silently marking the data as upgraded.
      throw new Error(`No migration defined for schema version ${next}. Data left at version ${version}.`);
    }
    console.info(`Migrating user data ${version} -> ${next}`);
    await migrate(ctx);
    version = next;
  }

  if (version > SCHEMA_VERSION) {
    // The account was used with a newer build of the app. Writing with older
    // assumptions could corrupt it, so tell the caller rather than continuing.
    throw new Error(
      `This data was written by a newer version of Ledger (schema ${version}, this build understands ${SCHEMA_VERSION}). Reload the page to pick up the latest app version.`,
    );
  }

  return version;
}
