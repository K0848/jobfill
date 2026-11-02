const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {initialize} = require('../tools/init-local.cjs');
test('fresh setup creates parseable examples; rerun preserves personal edits', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jobfill-init-'));
  try {
    fs.cpSync(path.resolve(__dirname, '../examples'), path.join(root, 'examples'), {recursive:true});
    assert.ok(initialize(root).every(r=>r.action==='created_from_example'));
    require('../extension/profile.js').parse(fs.readFileSync(path.join(root,'data/profile.md'),'utf8'));
    fs.writeFileSync(path.join(root,'data/profile.md'),'personal sentinel');
    assert.ok(initialize(root).every(r=>r.action==='preserved_existing'));
    assert.equal(fs.readFileSync(path.join(root,'data/profile.md'),'utf8'),'personal sentinel');
  } finally { fs.rmSync(root,{recursive:true}); }
});
