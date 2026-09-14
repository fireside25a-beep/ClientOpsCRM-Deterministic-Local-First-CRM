import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await markdownFiles(path));
    else if (extname(entry.name) === '.md') files.push(path);
  }
  return files;
}

const files = await markdownFiles(root);
let links = 0;
for (const file of files) {
  const text = await readFile(file, 'utf8');
  for (const match of text.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    const destination = match[1].trim().replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#)/.test(destination)) continue;
    const localPath = destination.split('#', 1)[0];
    if (!localPath) continue;
    links += 1;
    const target = resolve(dirname(file), localPath);
    assert(target === root || target.startsWith(root + '/'), `${file}: link escapes repository: ${destination}`);
    await assert.doesNotReject(access(target), `${file}: broken link ${destination}`);
  }
}

process.stdout.write(JSON.stringify({
  status: 'PASS',
  contract: 'docs',
  markdownFiles: files.length,
  localLinks: links,
}, null, 2) + '\n');
