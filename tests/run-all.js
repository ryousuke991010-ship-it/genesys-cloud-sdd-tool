#!/usr/bin/env node
/* 使い方: NODE_PATH=/opt/node22/lib/node_modules node tests/run-all.js [名前の一部…] */
const fs = require('fs');
const path = require('path');

const filters = process.argv.slice(2);
const specs = fs.readdirSync(__dirname).filter(f => f.endsWith('.spec.js'))
  .filter(f => !filters.length || filters.some(k => f.includes(k))).sort();

(async () => {
  let failed = 0;
  for (const f of specs) {
    const mod = require(path.join(__dirname, f));
    const t = Date.now();
    try {
      await mod.run();
      console.log(`✓ ${mod.name || f} (${Date.now() - t}ms)`);
    } catch (e) {
      failed++;
      console.log(`✕ ${mod.name || f}\n  ${e.stack || e.message}`);
    }
  }
  console.log(`\n${specs.length - failed}/${specs.length} 件成功`);
  process.exit(failed ? 1 : 0);
})();
