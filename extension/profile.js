/* MD 只作为资料处理，绝不执行其中的脚本、指令或链接。 */
globalThis.JobfillProfile = (() => {
  const Fields = globalThis.JobfillFields || (typeof require === 'function' ? require('./field-schema.js') : null);
  const groups = ['education', 'work', 'project', 'campus', 'award', 'language', 'family'];
  function validate(raw) {
    if (!raw || raw.jobfill !== 1 || !raw.basic || typeof raw.basic !== 'object' || Array.isArray(raw.basic)) throw new Error('缺少 jobfill: 1 或 basic 资料。');
    const result = { jobfill: 1, basic: cleanRecord(raw.basic) };
    for (const group of groups) {
      const rows = raw[group] ?? [];
      if (!Array.isArray(rows) || rows.length > 50) throw new Error(`${group} 必须是最多 50 条记录的数组。`);
      result[group] = rows.map(cleanRecord);
      const ids = result[group].map(x => x.identity).filter(Boolean);
      if (ids.length !== rows.length || new Set(ids).size !== ids.length) throw new Error(`${group} 每条记录都需要唯一的 identity。`);
    }
    if (raw.preferences !== undefined) {
      if (!Fields || !Array.isArray(raw.preferences)) throw new Error('偏好解析依赖或数据无效');
      result.preferences = raw.preferences.map(Fields.preference);
      const ids = result.preferences.map(x => JSON.stringify([x.scope,x.applicationId,x.key]));
      if (new Set(ids).size !== ids.length) throw new Error('同范围偏好重复');
    }
    return result;
  }
  function cleanRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('资料记录必须是对象。');
    const clean = {};
    for (const [key, value] of Object.entries(record)) {
      if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(key) || ['constructor', 'prototype'].includes(key)) throw new Error('资料字段名不合法。');
      if (value === null) continue;
      if (key === 'projectLinks') {
        if (!Array.isArray(value) || value.length > 10) throw new Error('projectLinks 必须是最多 10 个链接的数组。');
        const links = value.map(link => {
          if (!link || typeof link.label !== 'string' || link.label.length > 80 || typeof link.url !== 'string' || link.url.length > 2048) throw new Error('项目链接需要 label 和 url 文本。');
          let url;
          try { url = new URL(link.url); } catch { throw new Error('项目链接 URL 格式无效。'); }
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('项目链接只能是无内嵌凭据的 HTTP(S) 地址。');
          return { label: link.label.trim() || '项目链接', url: url.href };
        });
        clean[key] = Array.from(new Map(links.map(link => [link.url, link])).values());
        continue;
      }
      if (typeof value !== 'string' || value.length > 12000) throw new Error(`${key} 必须是文本，且不超过 12000 字。`);
      if (value.trim()) clean[key] = value.trim();
    }
    return clean;
  }
  function parse(md) {
    if (typeof md !== 'string' || md.length > 500000) throw new Error('请导入小于 500 KB 的 MD 文本。');
    const blocks = Array.from(md.matchAll(/```json\s*\r?\n([\s\S]*?)```/g));
    const profiles = [], preferenceBlocks = [];
    for (const [, body] of blocks) {
      let value;
      try { value = JSON.parse(body); } catch (error) {
        // 含标记的资料块解析失败必须报错，避免悄悄使用另一份旧资料。
        if (/"(?:jobfill|jobfillPreferences)"\s*:/.test(body)) throw new Error(`网申字段 JSON 格式错误：${error.message}`);
        continue;
      }
      if (value?.jobfillPreferences === 1) preferenceBlocks.push(value);
      if (value?.jobfill !== undefined) profiles.push(validate(value));
    }
    if (profiles.length !== 1) throw new Error('MD 需要且只能包含一个 jobfill: 1 的 JSON 资料块，请参照字段模板。');
    const profile = profiles[0];
    if (preferenceBlocks.length > 1) throw new Error('偏好块不能多于一个');
    if (preferenceBlocks.length) {
      if (!Array.isArray(preferenceBlocks[0].entries)) throw new Error('偏好 entries 无效');
      // 旧未定义范围条目不自动提升为通用；只消费已明确确认的新范围。
      profile.preferences = preferenceBlocks[0].entries.filter(x => ['global','application'].includes(x?.scope));
    }
    // 经历长文直接取同一 MD 的对应章节，避免维护第二份正文而产生漂移。
    const sections = Array.from(md.matchAll(/^### (.+)\r?\n([\s\S]*?)(?=^#{1,3} |$(?![\s\S]))/gm));
    for (const group of ['work', 'project', 'campus']) {
      for (const record of profile[group]) {
        const matches = sections.filter(([, title]) => title.startsWith(record.identity));
        if (matches.length !== 1) continue;
        const body = matches[0][2];
        if (group === 'project') {
          // 仅从该项目章节提取，避免把别的项目、证书或通用能力的链接挂过来。
          const extracted = Array.from((matches[0][1] + '\n' + body).matchAll(/(?<!!)\[([^\]\r\n]{1,80})\]\(<?(https?:\/\/[^\s<>)]*)>?\)/g)).map(([,label,url]) => ({label,url}));
          record.projectLinks = [...(record.projectLinks || []), ...extracted];
        }
        if (!record.description) record.description = body.split(/\r?\n/).filter(line => !/^\*\*\d{4}/.test(line) && !/^[-*] \*\*担任角色/.test(line)).join('\n').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/\*\*/g, '').replace(/^#### /gm, '').trim();
      }
    }
    return validate(profile);
  }
  function forApplication(input, applicationId) {
    const profile = validate(input);
    if (!Fields) return profile;
    // 旧 basic 偏好未经范围选择不得在新链路里静默跨申请复用。
    for (const key of Fields.preferences) {
      delete profile.basic[key];
      const entries = profile.preferences || [];
      const found = entries.find(x => x.key === key && x.scope === 'application' && x.applicationId === applicationId)
        || entries.find(x => x.key === key && x.scope === 'global');
      if (found) profile.basic[key] = found.value;
    }
    return profile;
  }
  return { parse, validate, forApplication };
})();

if (typeof module !== "undefined" && module.exports) module.exports = globalThis.JobfillProfile;
