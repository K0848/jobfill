/*
 * 页面标签到统一资料键的确定性映射表。
 * 只做精确归一化匹配；站点短标题通过 adapter 作用域注册，避免把模糊标签
 * 全局解释成同一个事实。新适配器可在加载引擎前注册自己的标签，不修改核心流程。
 */
(() => {
  if (globalThis.JobfillSemanticMapper?.version === 5) return;

  const normalize = value => String(value ?? '').toLowerCase().replace(/[\s*＊：:()（）·、]/g, '');
  const entries = [];
  const overlaps = (left, right) => !left || !right || [...left].some(id => right.has(id));
  const add = (labels, sourceKey, adapters = null) => {
    const allowed = adapters == null ? null : new Set(Array.isArray(adapters) ? adapters : [adapters]);
    for (const label of labels) {
      const normalized = normalize(label);
      if (!normalized) throw new TypeError('语义标签不能为空');
      const conflict = entries.find(entry => entry.normalized === normalized && overlaps(entry.adapters, allowed));
      if (conflict && conflict.sourceKey !== sourceKey) {
        throw new Error(`语义标签存在冲突：${label}`);
      }
      if (conflict) throw new Error(`语义标签重复注册：${label}`);
      entries.push({ normalized, label, sourceKey, adapters: allowed });
    }
  };

  const aliases = {
    name: ['姓名', '真实姓名', '中文姓名', 'full name'],
    phone: ['电话', '手机号', '手机号码', '联系电话', '手机', 'phone', 'mobile'],
    email: ['邮箱', '电子邮箱', '电子邮件', 'email'],
    gender: ['性别', 'gender', 'sex'], birthday: ['出生日期', '出生年月', '生日'],
    // 单位属于事实含义；只有页面明确厘米/公斤时才复用相应资料，不推算无单位或英制值。
    heightCm: ['身高（厘米）', '身高（cm）', 'height (cm)'],
    weightKg: ['体重（公斤）', '体重（千克）', '体重（kg）', 'weight (kg)'],
    ethnicity: ['民族'], nativePlace: ['籍贯'], city: ['所在城市', '当前城市', '现居城市', '现居住地', '当前居住地', '居住城市', '目前所在地'],
    country: ['国家/地区', '国家地区', '国家或地区'], idType: ['证件类型'], idNumber: ['证件号码', '身份证号', '身份证号码', '证件号码（用于实名认证）'],
    wechat: ['微信号'], hobby: ['兴趣爱好'], school: ['学校', '学校名称', '院校名称', '毕业院校'],
    college: ['学院名称', '学院', '院系', '院系名称', '所在院系/研究所', '院系/研究所'], major: ['专业名称', '所学专业', '专业'],
    // 学历层次不能证明已获得的学位；分别取值，避免把“本科”填入“学士”字段。
    majorCategory: ['专业类别'], degree: ['学历层次', '学历'], academicDegree: ['学位', '获得学位', '所获学位'],
    // 部分招聘站点把“全日制／非全日制”下拉标为“学历类型”；它表达的是修读形式，
    // 与“学历／学历层次”不同，必须复用 studyForm，不能把全日制误写成 degree。
    studyForm: ['学习形式', '培养方式', '受教育类型', '学历类型'], studyLocation: ['学校所在地', '学校所在地区'],
    highest: ['是否最高学历'], doubleDegree: ['是否双学位'], rank: ['专业成绩排名', '成绩排名', '专业排名', 'gpa排名'],
    company: ['公司名称', '公司', '企业名称', '实习单位'], role: ['职位名称', '岗位名称', '担任角色', '项目角色', '担任职务', '职务'],
    department: ['部门', '所在部门', '所属部门', '部门名称', '实习部门'],
    projectName: ['项目名称', '课题名称'], activityName: ['活动名称'],
    projectLink: ['项目链接', '项目地址', '项目网址', '作品链接', '作品地址', '开源链接', '开源地址', '仓库地址', 'github', 'github地址', 'github链接', 'project url', 'project link'],
    responsibilities: ['个人职责', '项目职责', '项目中职责', '主要职责', '工作职责', '实习职责', '职责描述'], achievements: ['项目成果', '工作成果', '主要成果'],
    preferredWorkCity: ['意向工作城市', '期望工作城市'], acceptLocationTransfer: ['是否接受地点调剂'], acceptDepartmentTransfer: ['是否接受部门调剂'],
    recruitmentSource: ['获取信息渠道'], expectedSalary: ['期望薪资', '期望月薪（元）', '期望年薪（万元）'], availability: ['到岗时间', '可到岗日期'],
    description: ['工作描述', '工作内容', '实习描述', '项目描述', '项目内容', '项目简介', '经历描述'],
    start: ['开始时间', '起始时间', '入学时间', '入职时间', '开始日期', '入学日期'], end: ['结束时间', '毕业时间', '离职时间', '结束日期', '毕业日期'],
    awardName: ['奖项名称', '评优表彰名称', '奖励名称'], awardDate: ['获奖时间', '获奖日期'], awardType: ['奖项类型'], awardLevel: ['评优表彰级别', '奖项级别'],
    language: ['外语语种', '语言类型'], exam: ['考试名称', '语言考试类型'], score: ['考试成绩', '六级成绩'],
    languageResult: ['语言考试成绩'], skillType: ['技能类型'], research: ['研究方向'], mentor: ['导师'], lab: ['实验室'],
  };
  for (const [sourceKey, labels] of Object.entries(aliases)) add(labels, sourceKey);
  // 北森/Phoenix 页面把 CET-6 这一类考试等级拆成“英语等级”和成绩两项；
  // 只在 generic 适配器注册，避免把其他站点的“等级”字段泛化成考试记录。
  add(['英语等级'], 'exam', 'generic');
  add(['英语等级成绩'], 'score', 'generic');
  add(['二级学院全称'], 'college', 'feishu');
  add(['绩点'], 'gpa', 'feishu');
  add(['获奖名称'], 'awardName', 'feishu');
  add(['职位', '在项目中担任的角色'], 'role', 'tencent');
  add(['描述'], 'description', 'tencent');
  add(['获奖类型'], 'awardType', 'tencent');
  add(['出生日期 (年龄)'], 'birthday', 'moka');

  function register({ labels, sourceKey, adapters = null } = {}) {
    if (!Array.isArray(labels) || !labels.length || typeof sourceKey !== 'string' || !sourceKey) throw new TypeError('语义映射需要 labels 和 sourceKey');
    add(labels, sourceKey, adapters);
    return { labels: labels.slice(), sourceKey, adapters };
  }
  function resolve(label, { adapter = 'generic' } = {}) {
    const normalized = normalize(label);
    const scoped = entries.filter(entry => entry.normalized === normalized && entry.adapters?.has(adapter));
    if (scoped.length === 1) return scoped[0].sourceKey;
    if (scoped.length > 1) return null;
    const universal = entries.filter(entry => entry.normalized === normalized && !entry.adapters);
    return universal.length === 1 ? universal[0].sourceKey : null;
  }
  // 明确的双语学历展示，不移除“非全日制”等会改变事实的限定语。
  const degreeDisplay = Object.fromEntries([
    ['博士','博士（Doctorate/PHD）'], ['硕士','硕士（Master）'], ['本科','本科（Bachelor）'],
    ['专科','专科（Associate）'], ['高中','高中（Senior high school）'], ['初中','初中（Junior high school）'], ['其他','其他（Others）']
  ].flatMap(([key,label]) => [[normalize(key),normalize(key)],[normalize(label),normalize(key)]]));
  // 同一学历层次的明确展示别名，仅用于学历；不推算学位、修读形式或毕业状态。
  degreeDisplay[normalize('硕士研究生')] = normalize('硕士');
  degreeDisplay[normalize('博士研究生')] = normalize('博士');
  function optionMatches(key, expected, actual) {
    const left=normalize(expected),right=normalize(actual);
    if (left===right) return true;
    // 部分 Moka 表单把长期资料的“全日制”显示为“统招全日制”；只放宽这一明确枚举别名，不把非全日制混入。
    if (key==='studyForm' && left==='全日制' && ['统招全日制','全日制普通高等教育'].includes(right)) return true;
    return key==='degree' && !!degreeDisplay[left] && degreeDisplay[left]===degreeDisplay[right];
  }

  globalThis.JobfillSemanticMapper = { version: 5, normalize, register, resolve, optionMatches, list: () => entries.map(entry => ({ label: entry.label, sourceKey: entry.sourceKey, adapters: entry.adapters ? [...entry.adapters] : null })) };
})();
