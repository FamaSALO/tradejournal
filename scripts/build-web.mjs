import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await cp(path.join(root, 'css'), path.join(dist, 'css'), { recursive: true });
await cp(path.join(root, 'js'), path.join(dist, 'js'), { recursive: true });

let html = await readFile(path.join(root, 'index.html'), 'utf8');
html = html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>\s*/i, '\n');
await writeFile(path.join(dist, 'index.html'), html, 'utf8');

console.log('TradeJournal web assets copied to dist/');
