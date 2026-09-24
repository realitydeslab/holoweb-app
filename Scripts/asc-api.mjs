#!/usr/bin/env node
// Minimal App Store Connect API client: signs an ES256 JWT with the team API key and calls a path.
// Usage: ASC_KEY_ID=.. ASC_ISSUER_ID=.. node Scripts/asc-api.mjs [/v1/apps?limit=200]
//        node Scripts/asc-api.mjs PATCH /v1/appInfoLocalizations/<id> '<json body>'
// The key is read from ~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8 (never in the repo).
import { createPrivateKey, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const { ASC_KEY_ID: kid, ASC_ISSUER_ID: iss } = process.env;
if (!kid || !iss) throw new Error('set ASC_KEY_ID and ASC_ISSUER_ID');
const key = createPrivateKey(readFileSync(process.env.ASC_KEY_PATH || `${homedir()}/.appstoreconnect/private_keys/AuthKey_${kid}.p8`));
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = `${b64({ alg: 'ES256', kid, typ: 'JWT' })}.${b64({ iss, iat: now, exp: now + 600, aud: 'appstoreconnect-v1' })}`;
const jwt = `${head}.${sign('sha256', Buffer.from(head), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;

const args = process.argv.slice(2);
const method = /^(GET|POST|PATCH|DELETE)$/.test(args[0] ?? '') ? args.shift() : 'GET';
const [path = '/v1/apps?limit=200', body] = args;
const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
  method,
  headers: { Authorization: `Bearer ${jwt}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
  ...(body ? { body } : {}),
});
if (res.status === 204) process.exit(0);
const json = await res.json();
if (!res.ok) { console.error(res.status, JSON.stringify(json.errors ?? json)); process.exit(1); }
console.log(JSON.stringify(json, null, 1));
