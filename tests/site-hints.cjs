const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', 'site-hints');
const files = ['generic.json', 'app.mokahr.com.json', 'feishu.cn.json', 'join.qq.com.json'];
const hints = Object.fromEntries(files.map(file => [file, JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'))]));

assert.ok(Object.keys(hints['generic.json'].aliases).length >= 15);
const preventMix = hints['generic.json'].preventMix;
for (const label of ['学历', '学历类型', '学校所在地', '工作职责', '身高', '体重']) assert.ok(preventMix.some(rule => rule.from === label), `缺少防混淆规则: ${label}`);
assert.deepEqual(hints['app.mokahr.com.json'].aliases.birthday, ['出生日期 (年龄)']);
assert.ok(hints['feishu.cn.json'].playbooks['ud-select-popup']);
assert.ok(hints['join.qq.com.json'].playbooks['phoenix-select']);
for (const hint of Object.values(hints)) assert.equal(hint.schemaVersion, 1);
console.log('site-hints: ok');
