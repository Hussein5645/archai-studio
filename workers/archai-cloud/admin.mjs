#!/usr/bin/env node
/**
 * ArchAI accounts are by invitation: the owner of the Cloudflare account creates them here.
 * It talks to the D1 database through wrangler (your own `wrangler login`), so it needs no
 * admin key and works only for whoever controls the Cloudflare account.
 *
 *   node admin.mjs add <email> "<name>" [password]   create an account (a password is generated
 *                                                     when none is given; send it to the person)
 *   node admin.mjs reset <email> [password]          new password, signs them out everywhere
 *   node admin.mjs list                               all accounts
 *   node admin.mjs remove <email>                     delete the account (their projects too)
 *
 * Add --local to work on the `wrangler dev` database instead of the deployed one.
 * Run from workers/archai-cloud. Passwords are hashed exactly like src/index.js (PBKDF2-SHA-256,
 * 100 000 rounds, 16-byte salt).
 */
import { execFileSync } from 'node:child_process';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// wrangler from the repository's node_modules, run by node itself: no shell, so arguments stay whole.
const wrangler = join(dirname(createRequire(import.meta.url).resolve('wrangler')), '..', 'bin', 'wrangler.js');

const args = process.argv.slice(2).filter((arg) => arg !== '--local');
const where = process.argv.includes('--local') ? '--local' : '--remote';
const [command, email = '', ...rest] = args;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const randomId = (n) => Array.from(randomBytes(n), (b) => ALPHABET[b % ALPHABET.length]).join('');
const sql = (value) => `'${String(value).replace(/'/g, "''")}'`;

function hash(password) {
  const salt = randomBytes(16).toString('base64url');
  const digest = pbkdf2Sync(password, Buffer.from(salt, 'base64url'), 100000, 32, 'sha256').toString('base64url');
  return { salt, digest };
}

function newPassword() {
  // 16 characters without look-alikes, easy to type from an email.
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(randomBytes(16), (b) => chars[b % chars.length]).join('');
}

function d1(statement) {
  const out = execFileSync(process.execPath, [wrangler, 'd1', 'execute', 'archai', where, '--json', '--command', statement], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return JSON.parse(out)[0];
}

function normalEmail(text) {
  const value = text.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error(`Not an email address: ${text}`);
  return value;
}

function checkPassword(password) {
  if (password.length < 8) throw new Error('The password needs at least 8 characters');
  return password;
}

try {
  switch (command) {
    case 'add': {
      const address = normalEmail(email);
      const name = (rest[0] ?? '').trim() || address.split('@')[0];
      const password = checkPassword(rest[1] ?? newPassword());
      if (d1(`SELECT id FROM users WHERE email = ${sql(address)}`).results.length) throw new Error(`${address} already has an account (use reset for a new password)`);
      const { salt, digest } = hash(password);
      d1(`INSERT INTO users (id, email, name, password_hash, password_salt, created_at) VALUES (${sql(`u_${randomId(20)}`)}, ${sql(address)}, ${sql(name.slice(0, 80))}, ${sql(digest)}, ${sql(salt)}, ${sql(new Date().toISOString())})`);
      console.log(`Account created (${where.slice(2)}):\n  email:    ${address}\n  name:     ${name}\n  password: ${password}\nSend them the email and password; they can change the password in ArchAI (account menu).`);
      break;
    }
    case 'reset': {
      const address = normalEmail(email);
      const password = checkPassword(rest[0] ?? newPassword());
      const { salt, digest } = hash(password);
      const user = d1(`SELECT id FROM users WHERE email = ${sql(address)}`).results[0];
      if (!user) throw new Error(`No account for ${address}`);
      d1(`UPDATE users SET password_hash = ${sql(digest)}, password_salt = ${sql(salt)} WHERE id = ${sql(user.id)}; DELETE FROM sessions WHERE user_id = ${sql(user.id)}`);
      console.log(`New password for ${address}: ${password}\n(they were signed out on every device)`);
      break;
    }
    case 'list': {
      const { results } = d1('SELECT users.email, users.name, users.created_at, (SELECT COUNT(*) FROM projects WHERE owner_id = users.id) AS projects FROM users ORDER BY users.created_at');
      for (const row of results) console.log(`${row.created_at.slice(0, 10)}  ${row.email}  ${row.name}  (${row.projects} projects)`);
      console.log(`${results.length} account(s)`);
      break;
    }
    case 'remove': {
      const address = normalEmail(email);
      const user = d1(`SELECT id FROM users WHERE email = ${sql(address)}`).results[0];
      if (!user) throw new Error(`No account for ${address}`);
      const id = sql(user.id);
      d1(
        [
          `DELETE FROM invites WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ${id})`,
          `DELETE FROM members WHERE project_id IN (SELECT id FROM projects WHERE owner_id = ${id})`,
          `DELETE FROM projects WHERE owner_id = ${id}`,
          `DELETE FROM members WHERE user_id = ${id}`,
          `DELETE FROM invites WHERE created_by = ${id}`,
          `DELETE FROM sessions WHERE user_id = ${id}`,
          `DELETE FROM vr_tours WHERE user_id = ${id}`,
          `DELETE FROM users WHERE id = ${id}`,
        ].join('; '),
      );
      console.log(`Removed ${address} and the projects they owned (their files in R2 stay until you delete them).`);
      break;
    }
    default:
      console.log('Usage: node admin.mjs add <email> "<name>" [password] | reset <email> [password] | list | remove <email>   [--local]');
      process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
