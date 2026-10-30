/**
 * 福彩 3D 历史开奖采集
 * 数据源：www.cwl.gov.cn 的 findDrawNotice 接口（彩种代码是 3d，不是 fc3d）
 * 每次跑都全量重取，不做增量合并 —— 少一类「漏一天补不回来」的故障模式。
 * 用法：node fetch_3d.mjs [--out=<路径>] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';

const API = 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice';
const OUT = process.env.FC3D_OUT || 'data/lottery_history.json';
const FORCE = process.argv.includes('--force');
const argvOut = process.argv.find(a => a.startsWith('--out='));
if (argvOut) process.env.OUT_OVERRIDE = argvOut.slice(6);
const target = process.env.OUT_OVERRIDE || OUT;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Referer': 'https://www.cwl.gov.cn/ygkj/wqkjgg/fc3d/',
  'Accept': 'application/json, text/javascript, */*; q=0.01'
};

function fail(msg) {
  console.error('[✗] ' + msg);
  process.exit(1);
}

/* 接口给的 date 形如 "2026-01-01(四)"，只取前半；week 单独留着，省得前端再算 */
function isoDate(raw) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw || '').trim());
  return m ? m[1] : null;
}

/* red 形如 "2,9,8" —— 百位、十位、个位 */
function toDigits(raw) {
  const parts = String(raw || '').split(',').map(s => s.trim());
  if (parts.length !== 3) return null;
  const d = parts.map(Number);
  if (d.some(n => !Number.isInteger(n) || n < 0 || n > 9)) return null;
  return d;
}

function normalize(rows) {
  const out = [];
  let bad = 0;
  for (const r of rows) {
    const code = String(r.code || '').trim();
    const date = isoDate(r.date);
    const d = toDigits(r.red);
    if (!/^\d{7}$/.test(code) || !date || !d) { bad++; continue; }
    out.push({
      code,
      date,
      week: String(r.week || ''),
      num: d.join(''),
      sales: Number(r.sales) || null
    });
  }
  return { out, bad };
}

/* 期号是「年份 + 年内序号」，字典序即时间序，可以直接拿来排序 */
function byCode(a, b) {
  return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
}

async function fetchAll() {
  /* 带上 systemType=PC 只回 100 条（实测），这串参数就是它自己页面用的那一条，别加料 */
  const url = API + '?name=3d&pageNo=1&pageSize=100';
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) fail('接口返回 HTTP ' + res.status + '（403 多为网宿 WAF 拦机房/异常请求，不是数据没了）');
  const text = await res.text();
  let j;
  try { j = JSON.parse(text); }
  catch { fail('响应不是 JSON，前 120 字符：' + text.slice(0, 120)); }
  if (j.state !== 0 || !Array.isArray(j.result)) fail('接口 state=' + j.state + ' message=' + j.message);
  if (j.result.length < 500) fail('只回 ' + j.result.length + ' 条，远少于预期，判为异常，不写盘');
  return j.result;
}

function readOld(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

async function main() {
  const result = await fetchAll();
  const { out, bad } = normalize(result);
  if (!out.length) fail('清洗后 0 条，判为接口改版，不写盘');

  out.sort(byCode);
  const newest = out[out.length - 1];

  const dir = path.dirname(target);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

  const old = readOld(target);
  const oldCount = old && Array.isArray(old.draws) ? old.draws.length : 0;
  if (old && out.length < oldCount && !FORCE) {
    fail('新档案 ' + out.length + ' 条比现有 ' + oldCount + ' 条还少，判为上游截断，不覆盖（确认可覆盖再加 --force）');
  }

  /* 同一天被官方改号是真实发生过的，原值进 fixes，不静默丢 */
  const fixes = [];
  if (old && Array.isArray(old.draws)) {
    const map = new Map(out.map(d => [d.code, d.num]));
    for (const d of old.draws) {
      const now = map.get(d.code);
      if (now && now !== d.num) fixes.push({ code: d.code, was: d.num, now, at: new Date().toISOString() });
    }
  }

  /* 休市那几天（春节、国庆）今天压根没开奖，每半小时一格就有一格真跑回来。
     这时候「最新的期号」和文件里一样，只有 fetchedAt 会变 —— 照写就是每天五六条
     空提交，Actions 列表看着像坏了、Pages 也跟着重建。所以没新期号且没人改号就不落盘。
     fetchedAt 不进判据：它是这一轮敲过门的证明，脚本自己会打日志，没必要为它推一次 main。 */
  if (old && old.asofCode === newest.code && !fixes.length && !FORCE) {
    console.log('[=] 最新仍是 ' + newest.code + '（' + newest.date + '），上游没有新期号，文件不动');
    return;
  }

  const doc = {
    source: '中国福利彩票官网 cwl.gov.cn',
    fetchedAt: new Date().toISOString(),
    asof: newest.date,
    asofCode: newest.code,
    count: out.length,
    first: out[0].code,
    fixes,
    draws: out
  };

  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, target);

  console.log('[✓] ' + out.length + ' 期（' + out[0].code + ' → ' + newest.code + '）'
    + (bad ? '，丢弃异常记录 ' + bad + ' 条' : '')
    + (fixes.length ? '，官方改号 ' + fixes.length + ' 条已记入 fixes' : '')
    + ' 已写入 ' + target + '（' + fs.statSync(target).size + ' B）');
}

main();
