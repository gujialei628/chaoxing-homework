'use strict';
/**
 * 学习通作业总览 · 本地版
 * 零依赖：只用 Node 内置模块。
 * 负责：密码登录学习通 → 抓作业聚合页 → 解析 → 以 JSON 提供给前端。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

const DIR = __dirname;
const PORT = Number(process.env.PORT || 7788);
const SESSION_FILE = path.join(DIR, '.session.json');
const CACHE_TTL = 5 * 60 * 1000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const WORK_URL = 'https://mooc1-api.chaoxing.com/work/stu-work';
const COURSE_URL = 'https://mooc1-api.chaoxing.com/mycourse/backclazzdata?view=json&mcode=';

/* ------------------------------------------------------------------ *
 * cookie 罐
 * ------------------------------------------------------------------ */
const jar = new Map();

function loadSession() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    Object.entries(data.cookies || {}).forEach(([k, v]) => jar.set(k, v));
    return data;
  } catch (e) { return {}; }
}

function saveSession(extra) {
  const data = Object.assign({}, extra || {}, {
    cookies: Object.fromEntries(jar),
    savedAt: Date.now()
  });
  try { fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf8'); } catch (e) {}
}

function cookieHeader() {
  return [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
}

function absorbCookies(setCookie) {
  (setCookie || []).forEach(line => {
    const m = String(line).match(/^\s*([^=;]+)=([^;]*)/);
    if (m) jar.set(m[1].trim(), m[2]);
  });
}

/* ------------------------------------------------------------------ *
 * HTTP 封装（手动处理跳转与 cookie）
 * ------------------------------------------------------------------ */
function request(url, opts = {}, depth = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('URL 非法')); }

    const mod = u.protocol === 'http:' ? http : https;
    const headers = Object.assign({
      'User-Agent': UA,
      'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Cookie': cookieHeader()
    }, opts.headers || {});

    const req = mod.request({
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers,
      timeout: 20000
    }, res => {
      absorbCookies(res.headers['set-cookie']);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const loc = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && loc && depth < 5) {
          const next = new URL(loc, url).toString();
          return resolve(request(next, Object.assign({}, opts, { method: 'GET', body: null }), depth + 1));
        }
        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });

    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * 登录
 * ------------------------------------------------------------------ */
const AES_KEY = Buffer.from('u2oh6Vu^HWe4_AES', 'utf8');

function aesEncrypt(text) {
  const cipher = crypto.createCipheriv('aes-128-cbc', AES_KEY, AES_KEY);
  return Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]).toString('base64');
}

async function login(phone, password) {
  jar.clear();
  await request('https://passport2.chaoxing.com/login?fid=-1').catch(() => {});

  const body = new URLSearchParams({
    fid: '-1',
    uname: aesEncrypt(phone),
    password: aesEncrypt(password),
    refer: 'http%3A%2F%2Fi.mooc.chaoxing.com',
    t: 'true',
    forbidotherlogin: '0',
    validate: '',
    doubleFactorLogin: '0',
    independentId: '0',
    independentNameId: '0'
  }).toString();

  const res = await request('https://passport2.chaoxing.com/fanyalogin', {
    method: 'POST',
    body,
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Requested-With': 'XMLHttpRequest',
      'Origin': 'https://passport2.chaoxing.com',
      'Referer': 'https://passport2.chaoxing.com/login?fid=-1'
    }
  });

  let data = {};
  try { data = JSON.parse(res.body); } catch (e) {}

  if (data.status !== true) {
    const msg = data.msg || data.message || '账号或密码不对，或被风控拦了';
    throw new Error('LOGIN_FAILED:' + msg);
  }

  saveSession({ phone });
  return true;
}

/* ------------------------------------------------------------------ *
 * 抓取 + 解析
 * ------------------------------------------------------------------ */
const STATUS_TODO = ['未提交', '未交', '待提交', '未完成', '待重做', '已驳回'];
const STATUS_DONE = ['待批阅', '已完成', '已提交', '已互评', '已通过', '已批阅'];
const STATUS_EXPIRED = ['已过期', '已截止', '已结束'];
const ALL_STATUS = new Set([].concat(STATUS_TODO, STATUS_DONE, STATUS_EXPIRED));

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m));
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function classify(status) {
  if (STATUS_TODO.indexOf(status) >= 0) return 'todo';
  if (STATUS_EXPIRED.indexOf(status) >= 0) return 'todo';
  return 'done';
}

function parseRemain(text) {
  if (!text) return null;
  const t = String(text).replace(/\s+/g, '');
  if (/已(截止|过期|结束)/.test(t)) return -1;
  let ms = 0, hit = false;
  [[/(\d+)\s*天/, 86400000], [/(\d+)\s*(?:小时|时)/, 3600000],
   [/(\d+)\s*分/, 60000], [/(\d+)\s*秒/, 1000]].forEach(([re, unit]) => {
    const m = t.match(re);
    if (m) { ms += Number(m[1]) * unit; hit = true; }
  });
  return hit ? ms : null;
}

function parseWorkPage(html) {
  const items = [];
  const seen = new Set();
  const liRe = /<li\b[^>]*\bdata="([^"]*)"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;

  while ((m = liRe.exec(html))) {
    const url = decodeEntities(m[1]);
    const body = m[2];
    const title = stripTags((body.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i) || [])[1]);
    if (!title) continue;

    let status = '', course = '', remain = '';
    const spanRe = /<span\b[^>]*>([\s\S]*?)<\/span>/gi;
    let s;
    while ((s = spanRe.exec(body))) {
      const t = stripTags(s[1]);
      if (!t) continue;
      if (!status && ALL_STATUS.has(t)) status = t;
      else if (!course && /^《.*》$/.test(t)) course = t;
      else if (!remain && /剩余|已截止|已过期/.test(t)) remain = t;
    }

    const q = queryOf(url);
    const id = q.taskrefId || q.workId || url;
    if (seen.has(id)) continue;
    seen.add(id);

    const expired = STATUS_EXPIRED.indexOf(status) >= 0;
    const remainMs = expired ? -1 : parseRemain(remain);

    items.push({
      id, title,
      status: status || '未知',
      kind: classify(status),
      expired,
      remainMs,
      courseRaw: course.replace(/^《|》$/g, ''),
      courseId: q.courseId || '',
      classId: q.clazzId || '',
      url
    });
  }
  return items;
}

function queryOf(url) {
  const out = {};
  const i = url.indexOf('?');
  if (i < 0) return out;
  url.slice(i + 1).split('#')[0].split('&').forEach(pair => {
    const j = pair.indexOf('=');
    if (j < 0) return;
    try {
      out[decodeURIComponent(pair.slice(0, j))] = decodeURIComponent(pair.slice(j + 1));
    } catch (e) {}
  });
  return out;
}

function parseCourses(text) {
  const map = {};
  let data;
  try { data = JSON.parse(text); } catch (e) { return map; }
  (data.channelList || []).forEach(ch => {
    const content = ch.content || {};
    ((content.course && content.course.data) || []).forEach(co => {
      const id = String(co.courseId || co.id || '');
      const name = co.name || '';
      if (id && name) map[id] = String(name);
    });
  });
  return map;
}

async function fetchHomework() {
  const res = await request(WORK_URL);
  const html = res.body || '';

  // 正常页面一定带「作业列表」标题或至少一条 li[data]；
  // 否则就是被重定向到了登录页（登录页也可能很长，不能只看长度）
  const isWorkPage = /作业列表/.test(html) || /<li\b[^>]*\bdata=/.test(html);
  if (!isWorkPage) throw new Error('NEED_LOGIN');

  const items = parseWorkPage(html);

  let courses = {};
  try {
    const c = await request(COURSE_URL);
    courses = parseCourses(c.body || '');
  } catch (e) { /* 课程名拿不到就用截断名 */ }

  return { items, courses, ts: Date.now() };
}

/* ------------------------------------------------------------------ *
 * 缓存 + 自动重登
 * ------------------------------------------------------------------ */
let cache = null;
let lastError = '';
const session = loadSession();

async function getHomework(force) {
  if (!force && cache && Date.now() - cache.ts < CACHE_TTL) return cache;

  try {
    cache = await fetchHomework();
    lastError = '';
    return cache;
  } catch (e) {
    if (String(e.message) === 'NEED_LOGIN' && session.phone && session.password) {
      await login(session.phone, session.password);
      cache = await fetchHomework();
      lastError = '';
      return cache;
    }
    lastError = String(e.message || e);
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * 题库：把已交作业的题目、正确答案、我的作答抓下来
 * ------------------------------------------------------------------ */
const DATA_DIR = path.join(DIR, 'data');
const BANK_FILE = path.join(DATA_DIR, 'bank.json');
const CFG_FILE = path.join(DIR, 'config.json');

function loadBank() {
  try { return JSON.parse(fs.readFileSync(BANK_FILE, 'utf8')); }
  catch (e) { return { updatedAt: 0, courses: {} }; }
}

function saveBank(bank) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(BANK_FILE, JSON.stringify(bank, null, 1), 'utf8');
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); }
  catch (e) { return null; }
}

function llmReady() {
  const c = loadConfig();
  return !!(c && c.apiKey && c.baseUrl && c.model);
}

/** 作业详情页地址就写在内联 JS 里，带 enc 签名；补上 isReport=false 一次拿全部题目 */
function extractLookUrl(html) {
  const m = html.match(/['"](\/work\/phone\/selectWorkQuestionYiPiYue\?[^'"]+)['"]/);
  if (!m) return '';
  const base = 'https://mooc1-api.chaoxing.com/mooc-ans' + m[1].replace(/&amp;/g, '&');
  return base.replace(/&times=\d+/, '') + '&isReport=false&times=0';
}

function parseQuestions(html) {
  const marks = [...html.matchAll(/<div[^>]*id="questionBlock(\d+)"[^>]*>/g)];
  const out = [];

  marks.forEach((mk, i) => {
    const block = html.slice(mk.index, i + 1 < marks.length ? marks[i + 1].index : html.length);
    const meta = stripTags((block.match(/<span class="stemGray">([\s\S]*?)<\/span>/) || [])[1] || '');
    const stem = stripTags((block.match(/<div[^>]*class="[^"]*qtContent[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '');
    if (!stem) return;

    const options = block.split('<div class="optionCon">').slice(1).map(part => ({
      // 正确答案的选项前面会带 right_v1.png
      correct: /right_v1\.png/.test(part.slice(0, 400)),
      // 选项文本自带 "A." 前缀，去掉避免渲染成 "A. A. xxx"
      text: stripTags((part.match(/<div[^>]*class="[^"]*qtDetail[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1] || '')
        .replace(/^[A-Da-dＡ-Ｄ][.．、)）:：]\s*/, '')
    })).filter(o => o.text);

    const plain = stripTags(block);
    const at = plain.indexOf('我的答案');
    const myAnswer = at >= 0
      ? plain.slice(at + 4).replace(/^[：:\s]+/, '').split(/得\s*[\d.]+\s*分|教师批阅|正确答案/)[0].trim()
      : '';

    out.push({
      qid: mk[1],
      type: (meta.match(/[（(]([^，,）)]+)/) || [])[1] || '',
      score: (meta.match(/([\d.]+)\s*分/) || [])[1] || '',
      stem,
      options,
      myAnswer,
      analysis: '',
      points: []
    });
  });

  return out;
}

async function crawlBank(onProgress) {
  const listRes = await request(WORK_URL);
  if (!/作业列表/.test(listRes.body)) throw new Error('NEED_LOGIN');

  const items = parseWorkPage(listRes.body).filter(it => it.status !== '未提交');
  let courses = {};
  try { courses = parseCourses((await request(COURSE_URL)).body); } catch (e) {}

  const old = loadBank();
  const bank = { updatedAt: Date.now(), courses: {} };
  let done = 0;

  for (const it of items) {
    done++;
    if (onProgress) onProgress(done, items.length, it.title);
    try {
      const task = await request(it.url);
      const look = extractLookUrl(task.body);
      if (!look) continue;                       // 互评等页面拿不到详情

      const page = await request(look);
      const questions = parseQuestions(page.body);
      if (!questions.length) continue;

      const q = queryOf(look);
      const courseId = q.courseId || it.courseId;
      const workId = q.workId || it.id;

      const course = bank.courses[courseId] || (
        bank.courses[courseId] = { name: courses[courseId] || it.courseRaw || '', summary: '', assignments: {} }
      );

      // 保留旧解析，按 qid 对齐
      const prev = (old.courses[courseId] && old.courses[courseId].assignments[workId]) || {};
      const prevMap = {};
      (prev.questions || []).forEach(p => { prevMap[p.qid] = p; });
      questions.forEach(qq => {
        const p = prevMap[qq.qid];
        if (p) { qq.analysis = p.analysis || ''; qq.points = p.points || []; }
      });

      course.assignments[workId] = {
        workId,
        title: it.title,
        status: it.status,
        url: it.url,
        fetchedAt: Date.now(),
        questions
      };
      if (prev.summary && prev.questions && prev.questions.length === questions.length) course.summary = old.courses[courseId].summary || '';
    } catch (e) { /* 单个作业失败不影响整体 */ }
  }

  saveBank(bank);
  return bank;
}

/* ------------------------------------------------------------------ *
 * 解析 / 知识点：调 OpenAI 兼容接口
 * ------------------------------------------------------------------ */
async function chat(messages) {
  const cfg = loadConfig();
  if (!cfg || !cfg.apiKey || !cfg.baseUrl || !cfg.model) throw new Error('还没配置 API：在 app/config.json 填 baseUrl / apiKey / model');

  const body = JSON.stringify({ model: cfg.model, temperature: 0.2, messages });
  const res = await new Promise((resolve, reject) => {
    const u = new URL(cfg.baseUrl.replace(/\/$/, '') + '/chat/completions');
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.apiKey, 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000
    }, r => {
      let b = ''; r.setEncoding('utf8'); r.on('data', c => b += c);
      r.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('接口返回非 JSON：' + b.slice(0, 120))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('模型接口超时')));
    req.write(body); req.end();
  });

  if (res.error) throw new Error(res.error.message || JSON.stringify(res.error).slice(0, 150));
  return (res.choices && res.choices[0] && res.choices[0].message && res.choices[0].message.content) || '';
}

function parseJsonLoose(text) {
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  const raw = m ? m[1] : text;
  return JSON.parse(raw);
}

async function analyzeCourse(courseId, course, force) {
  const book = ((loadConfig() || {}).textbooks || {})[course.name] || '';
  const todo = [];
  Object.values(course.assignments).forEach(a => a.questions.forEach(q => {
    if (force || !q.analysis) todo.push({ a, q });
  }));
  // 题目解析、课程汇总、教材大纲三样都齐了才算没事可做
  if (!todo.length && course.summary && (!book || (course.outline && !force))) {
    return { analyzed: 0, summary: false, outline: !!course.outline };
  }

  let analyzed = 0;
  for (let i = 0; i < todo.length; i += 6) {
    const batch = todo.slice(i, i + 6);
    const payload = batch.map((x, k) => ({
      i: k,
      course: course.name,
      type: x.q.type,
      stem: x.q.stem,
      options: x.q.options.map((o, n) => String.fromCharCode(65 + n) + '. ' + o.text),
      correct: x.q.options.filter(o => o.correct).map((o, n) => o.text),
      myAnswer: x.q.myAnswer
    }));

    const content = await chat([
      { role: 'system', content: '你是大学课程助教。针对每道题给出简明的解析和知识点标签。只输出 JSON 数组，不要解释。格式：[{"i":0,"analysis":"2-4 句，讲清为什么","points":["知识点1","知识点2"]}]。所有公式必须写成 LaTeX：行内用 $...$，不要用纯文本下划线/波浪号/上标数字。' },
      { role: 'user', content: JSON.stringify(payload) }
    ]);

    let arr;
    try { arr = parseJsonLoose(content); } catch (e) { continue; }
    if (!Array.isArray(arr)) continue;
    arr.forEach(r => {
      const item = batch[r.i];
      if (!item || typeof r.analysis !== 'string') return;
      item.q.analysis = r.analysis.trim();
      item.q.points = Array.isArray(r.points) ? r.points.filter(p => typeof p === 'string').slice(0, 4) : [];
      analyzed++;
    });
  }

  // 课程级知识点汇总
  const allPoints = [];
  Object.values(course.assignments).forEach(a => a.questions.forEach(q => (q.points || []).forEach(p => allPoints.push(p))));
  if (allPoints.length) {
    const text = await chat([
      { role: 'system', content: '你是课程助教。把题目涉及的知识点归纳成一份复习提纲，Markdown，二级标题分块，每块 2-5 条要点，不要客套话。所有公式必须写成 LaTeX：行内用 $...$，独立成行用 $$...$$，不要用纯文本下划线/波浪号/上标数字。' },
      { role: 'user', content: `课程：${course.name}\n知识点标签：${[...new Set(allPoints)].join('、')}\n请输出这份课程的知识点梳理。` }
    ]);
    if (text && text.trim()) course.summary = text.trim();
  }

  // 教材维度的大纲：老师不布置作业的课，按教材章节梳理知识点和重难点
  if (book && (force || !course.outline)) {
    const text = await chat([
      { role: 'system', content: '你是大学工科课程助教。参考指定教材的章节体系，输出一份期末复习用的知识点梳理：按章组织，二级标题为章名；每章分「核心知识点」「重点」「难点」「常见题型」四块；公式一律用 LaTeX（行内 $...$，独立成行 $$...$$）；不要客套话，不要编造页码、习题编号或具体例题。' },
      { role: 'user', content: `课程：${course.name}\n教材：${book}\n请输出这份教材的知识点与重难点梳理。` }
    ]);
    if (text && text.trim()) course.outline = { book, text: text.trim(), ts: Date.now() };
  }

  return { analyzed, summary: !!course.summary, outline: !!course.outline };
}

async function analyzeAll(force, onlyId) {
  const bank = loadBank();
  const result = [];
  for (const [id, course] of Object.entries(bank.courses)) {
    if (onlyId && id !== onlyId) continue;
    try { result.push(Object.assign({ course: course.name }, await analyzeCourse(id, course, force))); }
    catch (e) { result.push({ course: course.name, error: String(e.message || e) }); }
  }
  bank.updatedAt = Date.now();
  saveBank(bank);
  return result;
}

/* ------------------------------------------------------------------ *
 * Markdown 导出
 * ------------------------------------------------------------------ */
function bankMarkdown(courseId, skipTitle) {
  const bank = loadBank();
  const list = courseId ? [[courseId, bank.courses[courseId]]] : Object.entries(bank.courses);
  const out = [];

  list.forEach(([id, course]) => {
    if (!course) return;
    if (!skipTitle) out.push(`# ${course.name || id}\n`);
    if (course.outline) out.push(`## 教材知识点梳理（${course.outline.book}）\n\n${course.outline.text.replace(/^(#+)\s/gm, '##$1 ')}\n`);
    if (course.summary) out.push(`## 知识点梳理\n\n${course.summary.replace(/^(#+)\s/gm, '#$1 ')}\n`);
    Object.values(course.assignments).forEach(a => {
      out.push(`### ${a.title}（${a.status}）\n`);
      a.questions.forEach((q, i) => {
        out.push(`**${i + 1}. ${q.stem}**${q.type ? `（${q.type}${q.score ? '，' + q.score + ' 分' : ''}）` : ''}\n`);
        if (q.options.length) {
          q.options.forEach((o, n) => out.push(`- ${String.fromCharCode(65 + n)}. ${o.text}${o.correct ? ' ✅' : ''}`));
          out.push('');
        }
        if (q.myAnswer) out.push(`> 我的答案：${q.myAnswer}\n`);
        if (q.analysis) out.push(`**解析**：${q.analysis}\n`);
        if (q.points.length) out.push(`**知识点**：${q.points.join('、')}\n`);
      });
    });
  });

  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * HTML 导出：公式在导出时转成 MathML，文件本身自带排版
 * ------------------------------------------------------------------ */
let katex = null;
try { katex = require(path.join(DIR, 'public', 'vendor', 'katex', 'katex.min.js')); } catch (e) {}

function texToMathML(tex, display) {
  if (!katex) return '<code>$' + tex + '$</code>';
  try {
    return katex.renderToString(tex, { output: 'mathml', displayMode: !!display, throwOnError: false });
  } catch (e) {
    return '<code>' + tex.replace(/</g, '&lt;') + '</code>';
  }
}

function mdToHtml(md) {
  // 先把公式挖出来占位，避免被 HTML 转义破坏
  const math = [];
  const hold = (tex, display) => `\u0000${math.push({ tex, display }) - 1}\u0000`;
  let text = String(md)
    .replace(/\$\$([\s\S]+?)\$\$/g, (m, t) => hold(t, true))
    .replace(/\$([^$\n]+?)\$/g, (m, t) => hold(t, false));

  const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  const out = [];
  let list = null;
  const flush = () => { if (list) { out.push('<ul>' + list.join('') + '</ul>'); list = null; } };

  text.split('\n').forEach(raw => {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); return; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flush();
      const lv = m[1].length;
      const txt = m[2];
      // 四类板块各给一个颜色标记
      const cls = /^核心知识点/.test(txt) ? ' class="k-core"'
        : /^重点/.test(txt) ? ' class="k-key"'
          : /^难点/.test(txt) ? ' class="k-hard"'
            : /^常见题型/.test(txt) ? ' class="k-exam"' : '';
      out.push(`<h${lv}${cls}>${inline(txt)}</h${lv}>`);
    } else if ((m = line.match(/^[-*]\s+(.*)$/))) {
      (list = list || []).push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      flush();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else {
      flush();
      out.push(`<p>${inline(line)}</p>`);
    }
  });
  flush();

  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (m, i) => {
    const item = math[Number(i)];
    if (!item) return '';
    const html = texToMathML(item.tex.trim(), item.display);
    return item.display ? `<div class="math-block">${html}</div>` : html;
  });
}

function bankHtml(courseId) {
  const bank = loadBank();
  const ids = courseId ? [courseId] : Object.keys(bank.courses);
  const multi = ids.length > 1;
  const title = courseId && bank.courses[courseId] ? bank.courses[courseId].name : '学习通作业题库';
  const date = new Date().toLocaleString('zh-CN', { hour12: false });
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const sections = ids.map(id => {
    const course = bank.courses[id];
    if (!course) return '';
    const n = Object.keys(course.assignments).length;
    return `<section class="course" data-id="${esc(id)}" data-name="${esc(course.name)}">
  <h1>${esc(course.name || id)}</h1>
  <div class="meta">${n} 个已交作业</div>
${mdToHtml(bankMarkdown(id, true))}
</section>`;
  }).join('\n');

  const nav = multi ? `<nav class="nav">
  <button class="chip on" data-id="all">全部<span>${ids.length}</span></button>
${ids.map(id => {
    const c = bank.courses[id];
    return `  <button class="chip" data-id="${esc(id)}">${esc(c.name || id)}<span>${Object.keys(c.assignments).length}</span></button>`;
  }).join('\n')}
</nav>` : '';

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · 作业题库</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; background: #f5f6f8; color: #202632;
    font: 15px/1.9 -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased; }
  .page { max-width: 900px; margin: 0 auto; padding: 0 30px 90px; background: #fff;
    box-shadow: 0 0 50px rgba(16,24,40,.07); min-height: 100vh; }

  .nav { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 8px;
    padding: 14px 0 12px; margin-bottom: 6px;
    background: rgba(255,255,255,.96); border-bottom: 1px solid #eef1f6; }
  .chip { display: inline-flex; align-items: center; gap: 5px;
    padding: 6px 13px; border: 1px solid #e3e7ee; border-radius: 999px;
    background: #fff; font: inherit; font-size: 13px; color: #4b5262; cursor: pointer;
    transition: all .14s ease; }
  .chip:hover { border-color: #c3cfe8; color: #1f2430; }
  .chip span { font-size: 11.5px; color: #a3a9b6; }
  .chip.on { background: #2f6bff; border-color: #2f6bff; color: #fff; box-shadow: 0 2px 10px rgba(47,107,255,.28); }
  .chip.on span { color: rgba(255,255,255,.78); }

  section.course > h1 { font-size: 25px; margin: 30px 0 2px; letter-spacing: .3px; }
  section.course > .meta { color: #9aa0ae; font-size: 12.5px; margin-bottom: 22px; }

  h2 { font-size: 18px; margin: 36px 0 12px; padding: 0 0 8px 10px;
    border-left: 4px solid #2f6bff; border-bottom: 1px solid #eef1f6; }
  h3 { font-size: 16.5px; font-weight: 650; color: #10151f; margin: 34px 0 12px;
    padding-bottom: 7px; border-bottom: 1px dashed #e8ecf3; }
  h3::before { content: ""; display: inline-block; width: 8px; height: 8px; margin-right: 10px;
    border-radius: 2px; background: #2f6bff; vertical-align: 2px; }

  h4[class^="k-"] { display: flex; align-items: center; gap: 8px;
    font-size: 14px; margin: 20px 0 7px; padding-left: 10px; border-left: 3px solid currentColor; }
  h4.k-core { color: #1a4fd6; }
  h4.k-key  { color: #c0392b; }
  h4.k-hard { color: #7b3fa0; }
  h4.k-exam { color: #0a7a48; }

  p { margin: 0 0 9px; }
  ul { margin: 4px 0 14px 24px; padding: 0; }
  li { margin: 5px 0; }
  li::marker { color: #b9c1d1; }
  blockquote { margin: 10px 0; padding: 8px 14px; border-left: 3px solid #c9d6ff;
    background: #f7f9ff; color: #4b5262; border-radius: 0 6px 6px 0; }
  strong { font-weight: 650; }
  .math-block { margin: 12px 0 16px; overflow-x: auto; }
  math { font-size: 1.06em; }
  .foot { margin-top: 44px; padding-top: 16px; border-top: 1px solid #eef1f6;
    color: #a8aebc; font-size: 12px; text-align: center; }

  @media print {
    body { background: #fff; }
    .nav { display: none; }
    .page { box-shadow: none; padding: 0; max-width: none; }
    section.course > h1 { margin-top: 0; }
    section.course { page-break-before: always; }
    section.course:first-of-type { page-break-before: auto; }
    h2, h3, h4 { page-break-after: avoid; }
    li, p, blockquote { page-break-inside: avoid; }
  }
  @media (max-width: 640px) {
    .page { padding: 0 16px 60px; }
    section.course > h1 { font-size: 21px; }
  }
</style></head>
<body><div class="page">
${nav}
${sections}
<div class="foot">导出于 ${esc(date)} · 由学习通作业总览生成</div>
</div>
<script>
document.querySelectorAll('.chip').forEach(function (chip) {
  chip.addEventListener('click', function () {
    document.querySelectorAll('.chip').forEach(function (c) { c.classList.toggle('on', c === chip); });
    var id = chip.getAttribute('data-id');
    document.querySelectorAll('section.course').forEach(function (s) {
      s.hidden = id !== 'all' && s.getAttribute('data-id') !== id;
    });
    window.scrollTo(0, 0);
  });
});
</script>
</body></html>`;
}

/* ------------------------------------------------------------------ *
 * HTTP 服务
 * ------------------------------------------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.pdf': 'application/pdf' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(data));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathname = url.pathname;

  try {
    if (pathname === '/api/state') {
      let data;
      try {
        data = await getHomework(url.searchParams.get('force') === '1');
      } catch (e) {
        return sendJson(res, 200, {
          ok: false,
          needLogin: String(e.message) === 'NEED_LOGIN',
          error: String(e.message || e),
          phone: session.phone || '',
          items: [], courses: {}, ts: 0
        });
      }
      return sendJson(res, 200, {
        ok: true, needLogin: false, error: '',
        phone: session.phone || '',
        items: data.items, courses: data.courses, ts: data.ts
      });
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const raw = await readBody(req);
      let payload = {};
      try { payload = JSON.parse(raw || '{}'); } catch (e) {}
      const phone = String(payload.phone || '').trim();
      const password = String(payload.password || '');
      if (!phone || !password) return sendJson(res, 400, { ok: false, error: '手机号和密码都要填' });

      try {
        await login(phone, password);
        // 记住手机号；密码只在用户勾选时保存，用于 cookie 过期后自动重登
        session.phone = phone;
        if (payload.remember) {
          session.password = password;
          saveSession(session);
        } else {
          delete session.password;
          saveSession(session);
        }
        cache = null;
        const data = await getHomework(true);
        return sendJson(res, 200, { ok: true, items: data.items, courses: data.courses, ts: data.ts });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e.message || e).replace('LOGIN_FAILED:', '') });
      }
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
      jar.clear();
      cache = null;
      delete session.password;
      try { fs.unlinkSync(SESSION_FILE); } catch (e) {}
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/bank') {
      return sendJson(res, 200, { ok: true, bank: loadBank(), hasConfig: llmReady() });
    }

    if (pathname === '/api/bank/refresh' && req.method === 'POST') {
      try {
        const bank = await crawlBank();
        const assignments = Object.values(bank.courses).reduce((s, c) => s + Object.keys(c.assignments).length, 0);
        const questions = Object.values(bank.courses).reduce((s, c) => s + Object.values(c.assignments).reduce((t, a) => t + a.questions.length, 0), 0);
        return sendJson(res, 200, { ok: true, courses: Object.keys(bank.courses).length, assignments, questions, updatedAt: bank.updatedAt });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e.message || e) });
      }
    }

    if (pathname === '/api/analyze' && req.method === 'POST') {
      try {
        return sendJson(res, 200, { ok: true, result: await analyzeAll(url.searchParams.get('force') === '1', url.searchParams.get('course') || '') });
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: String(e.message || e) });
      }
    }

    if (pathname === '/api/export') {
      const md = bankMarkdown(url.searchParams.get('course') || '');
      res.writeHead(200, {
        'Content-Type': 'text/markdown; charset=utf-8',
        'Content-Disposition': 'attachment; filename="homework-bank.md"'
      });
      return res.end(md);
    }

    if (pathname === '/api/export.html') {
      const courseId = url.searchParams.get('course') || '';
      const bank = loadBank();
      // 题库为空时别给用户一个空白文件
      if (!Object.keys(bank.courses).length) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end('<!doctype html><meta charset="utf-8"><title>题库为空</title>' +
          '<body style="font:16px/1.9 system-ui,sans-serif;padding:48px 32px;color:#1f2430">' +
          '<h2 style="margin:0 0 8px">题库还是空的</h2>' +
          '<p style="color:#6b7280;margin:0">先在页面点「更新题库」抓取已交作业，再回来导出。</p></body>');
      }
      const name = (courseId && bank.courses[courseId] ? bank.courses[courseId].name : '作业题库') + '.html';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="bank.html"; filename*=UTF-8''${encodeURIComponent(name)}`
      });
      return res.end(bankHtml(courseId));
    }

    // 静态文件
    const file = pathname === '/' ? '/index.html' : pathname;
    const full = path.normalize(path.join(DIR, 'public', decodeURIComponent(file)));
    if (!full.startsWith(path.join(DIR, 'public'))) {
      res.writeHead(403); return res.end('forbidden');
    }
    fs.readFile(full, (err, data) => {
      if (err) { res.writeHead(404); return res.end('404'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(data);
    });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: String(e.message || e) });
  }
});

let listenPort = PORT;

server.on('error', err => {
  if (err && err.code === 'EADDRINUSE' && listenPort < PORT + 8) {
    listenPort += 1;
    console.log(`端口 ${listenPort - 1} 被占用，改用 ${listenPort}`);
    setTimeout(() => server.listen(listenPort, '127.0.0.1', onReady), 100);
  } else {
    console.error('启动失败：', err.message);
    process.exit(1);
  }
});

function onReady() {
  const url = `http://127.0.0.1:${listenPort}/`;
  console.log('');
  console.log('  学习通作业总览已启动');
  console.log('  ' + url);
  console.log('');
  console.log('  这个窗口不要关，关掉服务就停了。');
  console.log('');
  if (!process.env.NO_OPEN) {
    exec(`start "" "${url}"`, err => { if (err) console.log('（自动打开浏览器失败，请手动访问上面的地址）'); });
  }
}

// CLI：node server.js --crawl 直接跑一遍题库抓取并打印统计（自检用）
if (process.argv.includes('--crawl')) {
  let last = '';
  crawlBank((i, n, title) => {
    const line = `\r  ${i}/${n}  ${title.slice(0, 24)}          `;
    process.stdout.write(line);
    last = line;
  }).then(bank => {
    const courses = Object.values(bank.courses);
    const assignments = courses.reduce((s, c) => s + Object.keys(c.assignments).length, 0);
    const questions = courses.reduce((s, c) => s + Object.values(c.assignments).reduce((t, a) => t + a.questions.length, 0), 0);
    const withStem = courses.reduce((s, c) => s + Object.values(c.assignments).reduce((t, a) => t + a.questions.filter(q => q.stem && q.stem.length > 3).length, 0), 0);
    console.log('\r' + ' '.repeat(Math.max(0, last.length)) + '\r');
    console.log(`课程 ${courses.length} | 作业 ${assignments} | 题目 ${questions} | 有题干 ${withStem}`);
    courses.slice(0, 5).forEach(c => console.log(`  - ${c.name}: ${Object.keys(c.assignments).length} 个作业, ` +
      Object.values(c.assignments).reduce((t, a) => t + a.questions.length, 0) + ' 题'));
    if (questions === 0 || withStem < questions) { console.error('!! 题目解析不完整'); process.exit(1); }
    process.exit(0);
  }).catch(e => { console.error('\n抓取失败:', e.message); process.exit(1); });
} else {
  server.listen(PORT, '127.0.0.1', onReady);
}
