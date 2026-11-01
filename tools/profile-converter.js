/*
 * Convert the user's Markdown profile into the validated JSON contract used by
 * the fill-job-application skill.  Parsing and validation stay in
 * extension/profile.js; this module only provides file I/O and a small CLI.
 */
const fs = require('node:fs');
const path = require('node:path');

const profile = require(path.join(__dirname, '..', 'extension', 'profile.js'));

function convertMdToJson(mdPath, outPath) {
  if (typeof mdPath !== 'string' || !mdPath.trim()) throw new TypeError('mdPath 必须是 Markdown 文件路径');
  const sourcePath = path.resolve(mdPath);
  const markdown = fs.readFileSync(sourcePath, 'utf8');
  const parsed = profile.parse(markdown);
  const destination = outPath ? path.resolve(outPath) : sourcePath.replace(/\.md$/i, '.profile.json');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return { path: destination, profile: parsed };
}

if (require.main === module) {
  const [mdPath, outPath] = process.argv.slice(2);
  if (!mdPath) {
    console.error('用法: node tools/profile-converter.js <资料.md> [profile.json]');
    process.exitCode = 2;
  } else {
    try {
      const result = convertMdToJson(mdPath, outPath);
      console.log(JSON.stringify({ path: result.path, groups: Object.fromEntries(Object.entries(result.profile).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])) }, null, 2));
    } catch (error) {
      console.error(error?.message || error);
      process.exitCode = 1;
    }
  }
}

module.exports = { convertMdToJson };
