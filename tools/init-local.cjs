'use strict';
const fs = require('node:fs');
const path = require('node:path');

// 独立于调用者 cwd，且永不覆盖已有个人资料或已确认授权。
function initialize(root = path.resolve(__dirname, '..')) {
  const pairs = [['profile.example.md', 'profile.md'], ['personal-workflow.example.md', 'personal-workflow.md']];
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  return pairs.map(([source, destination]) => {
    const target = path.join(root, 'data', destination);
    try {
      fs.writeFileSync(target, fs.readFileSync(path.join(root, 'examples', source)), { flag: 'wx' });
      return { file: `data/${destination}`, action: 'created_from_example' };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      return { file: `data/${destination}`, action: 'preserved_existing' };
    }
  });
}
if (require.main === module) console.log(JSON.stringify(initialize(), null, 2));
module.exports = { initialize };
