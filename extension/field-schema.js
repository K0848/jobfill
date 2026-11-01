/* 保存与复用共用语义登记；合法字符串键不代表允许保存的个人资料。 */
(function(root) {
  const groups = {
    basic: 'name phone email gender birthday heightCm weightKg ethnicity nativePlace city country idType idNumber wechat hobby currentLocation qq emergencyContactName emergencyContactPhone homepage referenceName referenceRole referencePhone supplementaryInfo aiTools aiCollaboration aiWorkLinks developmentLanguages',
    education: 'school college major majorCategory degree academicDegree studyForm highest doubleDegree rank start end research mentor lab studyLocation gpa gpaScale papers',
    work: 'company department role start end description responsibilities achievements',
    project: 'projectName role start end description responsibilities achievements projectLinks',
    campus: 'activityName role start end description responsibilities achievements',
    award: 'awardName awardDate awardType awardLevel awardDescription',
    language: 'language exam score languageResult skillType',
    // 工行员工标记只适用于明确询问工商银行员工关系的页面，不跨公司复用。
    family: 'name relation phone company duty icbcEmployee'
  };
  const preferences = ['preferredWorkCity','acceptLocationTransfer','acceptDepartmentTransfer','recruitmentSource','expectedSalary','availability','preferredBusinessGroup','preferredDepartment','interviewCity'];
  const keys = [...new Set(Object.values(groups).flatMap(x => x.split(' ')).concat(preferences))];
  function allows(group,key) { return (groups[group] || '').split(' ').includes(key) || (group === 'basic' && preferences.includes(key)); }
  function preference(entry) {
    if (!entry || typeof entry !== 'object' || !preferences.includes(entry.key) || !['global','application'].includes(entry.scope)) throw new Error('偏好含义或范围无效');
    if (entry.scope === 'application' && (typeof entry.applicationId !== 'string' || !entry.applicationId)) throw new Error('仅本次偏好缺少可靠申请身份');
    if (entry.scope === 'global' && entry.applicationId) throw new Error('通用偏好不能绑定特定申请');
    if (typeof entry.value !== 'string' || !entry.value.trim() || entry.value.length > 12000 || typeof entry.confirmedAt !== 'string') throw new Error('偏好值无效');
    const context = entry.context || {};
    if (!context || typeof context !== 'object' || Array.isArray(context) || Object.entries(context).some(([k,v]) => !['unit','currency','basis'].includes(k) || typeof v !== 'string' || v.length > 100)) throw new Error('偏好单位或时间语境无效');
    if (entry.key === 'expectedSalary' && (!context.unit || !context.currency || !context.basis)) throw new Error('薪资缺少单位、币种或周期');
    if (entry.key === 'availability' && !context.basis) throw new Error('到岗时间缺少起算语境');
    return {key:entry.key,scope:entry.scope,applicationId:entry.scope === 'global' ? '' : entry.applicationId,value:entry.value.trim(),context:{...context},confirmedAt:entry.confirmedAt};
  }
  const api = { groups, keys, preferences, allows, preference };
  root.JobfillFields = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
