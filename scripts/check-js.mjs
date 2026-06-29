import { readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const ignoredDirs = new Set(['.git', 'node_modules']);

const walk = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) {
        files.push(...await walk(join(dir, entry.name)));
      }
      continue;
    }

    if (entry.isFile() && extname(entry.name) === '.js') {
      files.push(join(dir, entry.name));
    }
  }

  return files;
};

const files = await walk(root);

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

console.log(`Checked ${files.length} JavaScript files.`);
