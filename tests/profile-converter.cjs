const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { convertMdToJson } = require('../tools/profile-converter.js');

const source = path.join(__dirname, '..', 'examples', 'profile.example.md');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobfill-example-'));
try {
  const output = path.join(tempDir, 'profile.json');
  const result = convertMdToJson(source, output);
  const parsed = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(result.path, output);
  assert.equal(parsed.jobfill, 1);
  assert.equal(parsed.basic.name, '示例姓名');
  assert.equal(parsed.education[0].identity, '示例大学');
  assert.match(parsed.project[0].description, /示例项目的具体工作内容/);
  assert.equal(parsed.project[0].projectLinks[0].url, 'https://example.com/project');
  console.log('PASS profile-converter 使用虚构资料解析基本信息与项目章节');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
