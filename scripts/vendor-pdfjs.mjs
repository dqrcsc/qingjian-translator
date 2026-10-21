#!/usr/bin/env node
// Reproducible vendoring: download is separate; no npm install scripts are executed.
// curl -fsSL https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz -o /tmp/pdfjs.tgz
// node scripts/vendor-pdfjs.mjs /tmp/pdfjs.tgz
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const version = '6.4.299';
const integrity = 'sha512-AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==';
const archive = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('Usage: node scripts/vendor-pdfjs.mjs /path/to/pdfjs.tgz');
const digest = (algorithm, data, encoding = 'hex') => createHash(algorithm).update(data).digest(encoding);
if (`sha512-${digest('sha512', fs.readFileSync(archive), 'base64')}` !== integrity) throw new Error('Tarball integrity mismatch');
const root = fileURLToPath(new URL('../studio/vendor/pdfjs/', import.meta.url));
const members = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
const files = {};
for (const member of members) {
  let name;
  if (/^package\/legacy\/build\/pdf(?:\.worker)?\.mjs$/.test(member)) name = path.basename(member);
  else if (/^package\/(cmaps|standard_fonts|iccs)\/[\w.-]+$/.test(member)) name = member.slice(8);
  else if (/^package\/wasm\/(?!quickjs)[\w.-]+$/.test(member)) name = member.slice(8);
  else if (member === 'package/LICENSE') name = 'LICENSE';
  else continue;
  const bytes = execFileSync('tar', ['-xOf', archive, member], { maxBuffer: 16 * 1024 * 1024 });
  const target = path.join(root, name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  files[name] = { source: member, sha256: digest('sha256', bytes) };
}
fs.writeFileSync(path.join(root, 'provenance.json'), JSON.stringify({ version,
  source: `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${version}.tgz`, integrity,
  build: 'legacy ES modules (unmodified)', files }, null, 2) + '\n');
console.log(`Vendored PDF.js ${version}: ${Object.keys(files).length} verified upstream files`);
