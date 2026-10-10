// CI sanity checks: JSON shape, duplicate slugs, JS syntax. Run: node scripts/validate.mjs
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

let failed = false;
const fail = msg => { console.error('✗ ' + msg); failed = true; };

const data = JSON.parse(readFileSync('problems.json', 'utf8'));
const seen = new Map();
let total = 0;
for (const stage of data.sections ?? []) {
  for (const cat of stage.cats ?? []) {
    for (const item of cat.items ?? []) {
      const [slug, title, diff] = item;
      total++;
      if (!/^[a-z0-9-]{1,100}$/.test(slug ?? '')) fail(`bad slug "${slug}" in ${cat.name} (must match Firestore rules)`);
      if (!title) fail(`missing title for ${slug}`);
      if (!['E', 'M', 'H'].includes(diff)) fail(`bad difficulty for ${slug}: ${diff}`);
      if (seen.has(slug)) fail(`duplicate slug "${slug}" (${seen.get(slug)} and ${stage.title}/${cat.name})`);
      seen.set(slug, `${stage.title}/${cat.name}`);
    }
  }
}
if (!total) fail('problems.json has no problems');
console.log(`problems.json: ${total} problems, ${seen.size} unique`);

for (const f of ['app.js', 'cloud.js', 'firebase-config.js', 'service-worker.js']) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); console.log(`✓ ${f} parses`); }
  catch (e) { fail(`${f}: ${e.stderr}`); }
}
process.exit(failed ? 1 : 0);
