#!/usr/bin/env node
// Minimal App Store Connect API client: signs an ES256 JWT with the team API key and GETs a path.
// Usage: ASC_KEY_ID=.. ASC_ISSUER_ID=.. node Scripts/asc-api.mjs /v1/apps?limit=200
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

const path = process.argv[2] || '/v1/apps?limit=200';
const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, { headers: { Authorization: `Bearer ${jwt}` } });
const body = await res.json();
if (!res.ok) { console.error(res.status, JSON.stringify(body.errors ?? body)); process.exit(1); }
console.log(JSON.stringify(body, null, 1));
