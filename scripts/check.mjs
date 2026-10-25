// Syntax-checks every backend module (cross-platform; npm uses cmd.exe on Windows).
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const files = ['main.mjs', 'proxy-entry.mjs', 'deployment.config.mjs', ...['lib', 'scripts', 'functions', 'api'].flatMap(d => readdirSync(d).filter(f => f.endsWith('.mjs')).map(f => `${d}/${f}`))];
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`Syntax OK: ${files.length} files`);
