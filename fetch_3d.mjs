/**
 * 福彩 3D 历史开奖 → data/lottery_history.json
 *
 * 主源：https://data.17500.cn/3d_asc.txt —— 一行一期的纯文本全量档案，2002 年至今。
 *       挑它是因为它不挑出口 IP：GitHub 机房、Cloudflare 边缘、家里电脑都是 200。
 * 备胎：www.cwl.gov.cn 的 findDrawNotice 接口。官方源，但网宿 WAF 把海外机房 IP
 *       全拦成 403（2026-10-30 实测：Actions runner 403、Cloudflare 边缘回拦截页、
 *       家里电脑 200）⇒ 它只能当 17500 挂了时的兜底，而且大概率也兜不住。
 * 两源同字段已逐期对过账：中彩网收录的 4,793 期里，开奖号 4,793 期完全一致、0 处不同。
 *
 * 用法：node fetch_3d.mjs [--out=<路径>] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';

const TXT = 'https://data.17500.cn/3d_asc.txt';
const API = 'https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice';
const OUT = process.env.FC3D_OUT || 'data/lottery_history.json';
const FORCE = process.argv.includes('--force');
const argvOut = process.argv.find(a => a.startsWith('--out='));
if (argvOut) process.env.OUT_OVERRIDE = argvOut.slice(6);
const target = process.env.OUT_OVERRIDE || OUT;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
};
const WD = '日一二三四五六';

function fail(msg) {
  console.error('[✗] ' + msg);
  process.exit(1);
}

/* 期号是「年份 + 年内序号」，字典序即时间序 */
function byCode(a, b) { return a.code < b.code ? -1 : a.code > b.code ? 1 : 0; }

function isoDate(raw) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(raw || '').trim());
  return m ? m[1] : null;
}
function weekOf(date) {
  const d = new Date(date + 'T00:00:00Z');
  return isNaN(d) ? '' : WD[d.getUTCDay()];
}
function threeDigits(a, b, c) {
  const d = [a, b, c].map(Number);
  if (d.some(n => !Number.isInteger(n) || n < 0 || n > 9)) return null;
  return d.join('');
}

/* 一行 = 17 列：期号 日期 百 十 个 (试机号三位)(两位机号) 销售额 (三档单注奖金各两列)
   这页只用得上期号、日期、百十个、销售额；其余列不猜语义，原样丢掉。 */
function parseTxt(text) {
  const out = [];
  let bad = 0;
  for (const line of String(text).split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (!t[0]) continue;
    if (!/^\d{7}$/.test(t[0]) || t.length !== 17) { bad++; continue; }
    const date = isoDate(t[1]);
    const num = threeDigits(t[2], t[3], t[4]);
    if (!date || !num) { bad++; continue; }
    out.push({ code: t[0], date, week: weekOf(date), num, sales: Number(t[10]) || null });
  }
  return { out, bad };
}

/* 官方接口的形状和 17500 不一样，出来要归成同一副样子 */
function parseCwl(rows) {
  const out = [];
  let bad = 0;
  for (const r of rows) {
    const code = String(r.code || '').trim();
    const date = isoDate(r.date);
    const parts = String(r.red || '').split(',').map(s => s.trim());
    const num = parts.length === 3 ? threeDigits(parts[0], parts[1], parts[2]) : null;
    if (!/^\d{7}$/.test(code) || !date || !num) { bad++; continue; }
    out.push({ code, date, week: String(r.week || '') || weekOf(date), num, sales: Number(r.sales) || null });
  }
  return { out, bad };
}

async function grab(url, label, referer) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { ...HEADERS, Referer: referer } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    console.log('[·] ' + label + ' 回了 ' + res.status + ' · ' + Buffer.byteLength(text) + ' B');
    return text;
  } catch (e) {
    console.log('[·] ' + label + ' 没答话：' + (e.name === 'AbortError' ? '25 秒超时' : String(e.message || e)));
    return null;
  } finally { clearTimeout(timer); }
}

async function main() {
  let rows = null, source = null, bad = 0;

  const txt = await grab(TXT, '17500 纯文本', 'https://www.17500.cn/');
  if (txt) {
    const p = parseTxt(txt);
    if (p.out.length >= 500) { rows = p.out; source = '17500.cn 3d_asc.txt'; bad = p.bad; }
    else console.log('[·] 17500 只解析出 ' + p.out.length + ' 期（丢弃 ' + p.bad + ' 行），判为改版，转官方源');
  }

  if (!rows) {
    /* 带上 systemType=PC 只回 100 条（实测），这串参数就是它自己页面用的那一条，别加料 */
    const j = await grab(API + '?name=3d&pageNo=1&pageSize=100', '中彩网接口', 'https://www.cwl.gov.cn/ygkj/wqkjgg/fc3d/');
    if (!j) fail('两个源都没答话（17500 挂了、中彩网多半是被 WAF 拦），这一轮不动档案');
    let doc;
    try { doc = JSON.parse(j); } catch { fail('中彩网响应不是 JSON，前 120 字符：' + j.slice(0, 120)); }
    if (doc.state !== 0 || !Array.isArray(doc.result)) fail('中彩网 state=' + doc.state + ' message=' + doc.message);
    const p = parseCwl(doc.result);
    rows = p.out; bad = p.bad; source = 'cwl.gov.cn';
  }

  if (rows.length < 500) fail('清洗后只有 ' + rows.length + ' 期，远少于预期，判为异常，不写盘');
  rows.sort(byCode);
  const newest = rows[rows.length - 1];

  const dir = path.dirname(target);
  if (dir && dir !== '.') fs.mkdirSync(dir, { recursive: true });

  let old = null;
  try { old = JSON.parse(fs.readFileSync(target, 'utf8')); } catch { old = null; }
  const oldCount = old && Array.isArray(old.draws) ? old.draws.length : 0;
  if (old && rows.length < oldCount && !FORCE) {
    fail('新档案 ' + rows.length + ' 期比现有 ' + oldCount + ' 期还少，判为上游截断，不覆盖（确认可覆盖再加 --force）');
  }

  /* 同一期被改号是真实发生过的（官方勘误、或两源本身打架），原值进 fixes，不静默丢。
     销售额也一起比：17500 和中彩网可比的那 4,793 期里号码 0 处不同、销售额 8 处不同
     （差 0.5%~7%，两源谁对没第三方能判）⇒ 号码不一致才是要报警的那种，销售额变了只记一笔。 */
  const fixes = [];
  if (old && Array.isArray(old.draws)) {
    const map = new Map(rows.map(d => [d.code, d]));
    const at = new Date().toISOString();
    for (const d of old.draws) {
      const now = map.get(d.code);
      if (!now) continue;
      if (now.num !== d.num) fixes.push({ code: d.code, field: 'num', was: d.num, now: now.num, at });
      else if (d.sales != null && now.sales != null && now.sales !== d.sales)
        fixes.push({ code: d.code, field: 'sales', was: d.sales, now: now.sales, at });
    }
  }
  if (fixes.length) {
    const numFix = fixes.filter(f => f.field === 'num').length;
    console.log('[!] ' + fixes.length + ' 个字段和现有档案不一致（其中号码 ' + numFix + ' 处）：'
      + fixes.slice(0, 5).map(f => f.code + ' ' + f.field + ' ' + f.was + '→' + f.now).join('、'));
  }

  /* 休市那几天（春节、国庆）压根没开奖，每半小时一格就有一格真跑回来。
     这时候「最新的期号」和文件里一样，只有 fetchedAt 会变 —— 照写就是每天五六条
     空提交，Actions 列表看着像坏了、Pages 也跟着重建。所以没新期号且没人改号就不落盘。
     条数也要一起比：换源或上游回填旧年份时，最新期号不动但档案变长，那是真要写的。 */
  if (old && old.asofCode === newest.code && rows.length === oldCount && !fixes.length && !FORCE) {
    console.log('[=] 最新仍是 ' + newest.code + '（' + newest.date + '），上游没有新期号，文件不动');
    return;
  }

  const doc = {
    source,
    fetchedAt: new Date().toISOString(),
    asof: newest.date,
    asofCode: newest.code,
    count: rows.length,
    first: rows[0].code,
    fixes,
    draws: rows
  };

  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(doc));
  fs.renameSync(tmp, target);

  console.log('[✓] ' + rows.length + ' 期（' + rows[0].code + ' → ' + newest.code + '）源=' + source
    + (bad ? '，丢弃异常行 ' + bad + ' 条' : '')
    + (fixes.length ? '，改号 ' + fixes.length + ' 条' : '')
    + ' 已写入 ' + target + '（' + fs.statSync(target).size + ' B）');
}

main();
