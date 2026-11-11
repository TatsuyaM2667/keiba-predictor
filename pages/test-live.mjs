// JRA 自動取得の自己チェック: 解析 (lib/jra.ts)・取得計画 (sync/plan.ts)・取得処理 (sync/index.ts の tick)・
// 画面用 API (/api/live/*) を、JRA に接続せずに通しで確かめる。
// JRA のページはここに保存しない (著作物のため)。下の HTML は、解析に必要な形だけをまねて手で書いたもの。
// 使い方: node test-live.mjs
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { parseTop, parseRaceList, parseCard, parseScheduleMonth, gradeOf, parseResult, parseResultTop } from "./lib/jra.ts";
import { plan, cardInterval, MIN, HOUR } from "./sync/src/plan.ts";
import { tick } from "./sync/src/index.ts";
import { onRequest } from "./functions/api/[[path]].ts";
import { features, paceOf, marketProbs, kelly, simulateOrders, probOf, hits, harville, oddsFrom, strategies, commentary, BET_TYPES, fittedProbs, sampleOrders, normSurface } from "../src/main/resources/static/js/race-model.js";

// ---------- 手書きの JRA 風 HTML ----------
const TOP = `<a href="#" onclick="doAction('/JRADB/accessD.html', 'pw01drl10052026050520261115/AB');">5回東京5日<span>土曜</span></a>
  <a href="#" onclick="doAction('/JRADB/accessD.html', 'pw01drl10052026050520261115/AB');">もう一度</a>
  <a href="#" onclick="doAction('/JRADB/accessD.html', 'pw01drl10082026050520261115/C1');">5回京都5日</a>`;
const LIST = [10, 11].map(n => `<tr><th><a href="/JRADB/accessD.html?CNAME=pw01dde100520260505${n}20261115/E${n - 10}">${n}R</a></th>
  <td class="time">${n + 4}時40分</td>
  <td class="race_name">${n === 11 ? `<div class="stakes">テスト記念<span class="grade_icon"><img src="/x/icon_grade_s_g2.png"></span></div><div>3歳以上オープン</div>` : `<div>3歳以上2勝クラス</div>`}</td>
  <td class="dist"><span class="course">芝</span><span class="dist">2,000</span>m <span class="num">${n === 11 ? 3 : 12}</span>頭</td></tr>`).join("");
const past = (place, field, corner, dist, diff) => `<td class="past p1"><div class="date">2026年10月12日</div><div class="rc">東京</div>
  <div class="name">毎日王冠</div><div class="r_class"><img src="icon_grade_s_g2.png"></div><div class="place">${place}</div><div class="max">${field}</div>
  <div class="dist">${dist}芝</div><div class="time">1:45.3</div><div class="condition">良</div><div class="f3">3F 33.5</div>
  <ul class="corner_list"><li>${corner}</li><li>${corner}</li></ul><div class="fin"><span class="time">(${diff})</span></div></td>`;
const runner = (n, name, odds, pastHtml, extra = "") => `<td class="waku"><img src="/img/waku/${n}.png"></td><td class="num">${n}<span class="icon">B</span></td>
  <td class="horse"><div class="name"><a href="#">${name}</a></div>${extra}
  <div class="odds_line"><span class="num"><strong${n === 1 ? ' class="red"' : ""}>${odds}</strong></span><span class="pop_rank">(${n}番人気)</span></div>
  <p class="trainer"><a>調教師${n}</a></p><p class="division">(美浦)</p><p class="sire"><span>父：</span>父${n}</p><p class="mare"><span>母：</span>母${n}</p><p>(母の父：母父${n})</p>
  <div class="cell weight">480kg<span class="transition">(+4)</span></div></td>
  <td class="jockey"><p class="age">牡4/黒鹿</p><p class="weight">57.0<span>kg</span></p><p class="jockey"><a>騎手${n}</a></p></td>${pastHtml}`;
const CARD = `<h2><span class="race_name">テスト記念<span class="grade_icon"><img src="icon_grade_g2.png"></span></span><span class="num">第64回</span></h2>
  <div class="cell category">3歳以上</div><div class="cell class">オープン</div>
  <div class="cell course"><span class="cap">コース：</span>2,000<span class="unit">メートル</span><span class="detail">（芝・左）</span></div>
  <div>発走時刻：<strong>15時40分</strong></div><table><tbody><tr>` +
  runner(1, "テストホースア", "2.1", past(1, 12, 1, 1800, -0.2)) +
  runner(2, "テストホースイ", "4.5", past(6, 12, 6, 2400, 0.8)) +
  runner(3, "テストホースウ", "9.0", "");
const SCHEDULE = [{ month: "11", data: [
  { date: "15", day: "土", info: [{ race: [{ name: "5回東京5日" }, { name: "5回京都5日" }], gradeRace: [{ name: "テスト記念", grade: "G2", pos: "1" }, { name: "テスト障害", grade: "J・G1", pos: "2" }] }] },
  { date: "16", day: "日", info: [{ race: [{ name: "5回東京6日" }], gradeRace: [] }] },
  { date: "17", day: "月", info: [{ race: [], gradeRace: [] }] },
] }];

// 結果ページ: 着順・払戻金・この競走の出馬表と、同じ開催の 9R〜11R の結果へのリンク
const RESULT_TOP = `<a href="/JRADB/accessS.html?CNAME=pw01sde1005202605051120261115/A1">テスト記念</a><a href="/JRADB/accessS.html?CNAME=pw01sde1005202605051120261115/A1">同じ</a>`;
const RESULT = (rn) => CARD.slice(0, CARD.indexOf("<table")) + `<table><tbody>` +
  [[1, 2, 2], [2, 1, 1], [3, 3, 3]].map(([place, n, pop]) => `<tr><td class="place">${place}</td><td class="waku"><img src="/waku/${n}.png"></td><td class="num">${n}</td>
    <td class="horse"><a href="#">ホース${n}</a></td><td class="time">2:00.0</td><td class="margin"> クビ</td><td class="pop">${pop}</td></tr>`).join("") +
  `<tr><td class="place">除外</td><td class="num">4</td><td class="horse">ホース4</td></tr></tbody></table>
  <li class="win"><dl><dt>単勝</dt><dd><div class="line"><div class="num">2</div><div class="yen">450<span>円</span></div></div></dd></dl></li>
  <li class="place"><dl><dd><div class="line"><div class="num">2</div><div class="yen">150</div></div><div class="line"><div class="num">1</div><div class="yen">110</div></div></dd></dl></li>
  <li class="umaren"><dl><dd><div class="line"><div class="num">1-2</div><div class="yen">1,230</div></div></dd></dl></li>
  <a href="/JRADB/accessD.html?CNAME=pw01dde100520260505${String(rn).padStart(2, "0")}20261115/C${rn - 8}">出馬表</a>` +
  ["09", "10", "11"].map(r => `<a href="/JRADB/accessS.html?CNAME=pw01sde100520260505${r}20261115/B${r.slice(1)}">${r}R</a>`).join("") +
  `<a href="/JRADB/accessS.html?CNAME=pw01sde1008202605050120261115/F0">京都1R</a>`;

// ---------- 解析 ----------
assert.equal(gradeOf('<img src="icon_grade_lg_g1.png">'), "GI");
const top = parseTop(TOP);
assert.equal(top.length, 2, "同じ開催は 1 回だけ");
assert.deepEqual(top[0], { cname: "pw01drl10052026050520261115/AB", venue: "05", date: "2026-11-15", label: "5回東京5日" });
const list = parseRaceList(LIST);
assert.equal(list.length, 2);
assert.deepEqual(
  { id: list[1].id, raceNo: list[1].raceNo, postTime: list[1].postTime, name: list[1].name, grade: list[1].grade, cond: list[1].cond, surface: list[1].surface, distance: list[1].distance, field: list[1].field },
  { id: "20261115-05-11", raceNo: 11, postTime: "15:40", name: "テスト記念", grade: "GII", cond: "3歳以上オープン", surface: "芝", distance: 2000, field: 3 },
);
const card = parseCard(CARD);
assert.deepEqual(card.header, { name: "テスト記念", edition: "第64回", grade: "GII", cond: "3歳以上 オープン", distance: 2000, surface: "芝", turn: "左", postTime: "15:40" });
assert.equal(card.runners.length, 3);
const [a1, a2, a3] = card.runners;
assert.deepEqual([a1.num, a1.waku, a1.odds, a1.pop, a1.carry, a1.bodyWeight, a1.weightDiff, a1.color, a1.jockey, a1.damSire], [1, 1, 2.1, 1, 57, 480, 4, "黒鹿", "騎手1", "母父1"]);
assert.equal(a2.odds, 4.5, "人気が赤字でない馬のオッズ");
assert.deepEqual([a1.past[0].place, a1.past[0].field, a1.past[0].distance, a1.past[0].surface, a1.past[0].grade, a1.past[0].diff], [1, 12, 1800, "芝", "GII", -0.2]);
assert.equal(a3.past.length, 0, "過去走なし");
assert.deepEqual(parseResultTop(RESULT_TOP), ["pw01sde1005202605051120261115/A1"]);
const res = parseResult(RESULT(11), "pw01sde1005202605051120261115/A1");
assert.equal(res.cardCname, "pw01dde1005202605051120261115/C3", "この競走の出馬表");
assert.deepEqual(res.order.map(o => [o.place, o.num, o.pop, o.status]), [[1, 2, 2, ""], [2, 1, 1, ""], [3, 3, 3, ""], [null, 4, null, "除外"]]);
assert.deepEqual(res.payouts.win, [{ combo: "2", yen: 450 }]);
assert.deepEqual(res.payouts.umaren, [{ combo: "1-2", yen: 1230 }], "3 桁区切りのカンマ");
assert.equal(res.payouts.place.length, 2);
assert.deepEqual(res.payouts.tierce, [], "載っていない券種は空");
assert.deepEqual(res.siblings, ["pw01sde1005202605050920261115/B9", "pw01sde1005202605051020261115/B0"], "同じ日・同じ競馬場のレースだけ");
const days = parseScheduleMonth(SCHEDULE, 2026);
assert.equal(days[0].date, "2026-11-15");
assert.deepEqual(days[0].graded, [{ name: "テスト記念", grade: "GII", venue: "東京5日" }, { name: "テスト障害", grade: "J・GI", venue: "京都5日" }]);

// ---------- 予想モデル ----------
const race = { surface: "芝", distance: 2000 };
const f = card.runners.map(r => features(r, race));
assert(f[0].mu > f[1].mu && f[1].mu > 0.9, "前走 1 着の馬が上");
assert.equal(f[2].form, 0.4, "過去走なしは 0.4");
assert.deepEqual(f.map(v => v.style), [0, 2, 2], "1 コーナー 1/12 = 逃げ、6/12 = 差し、不明 = 差し");
assert.equal(paceOf([0, 2, 2]).name, "スローペース");
assert.equal(paceOf([0, 0, 1]).name, "ハイペース");
const m = marketProbs([2, 4, 4]);
assert(Math.abs(m.probs.reduce((s, v) => s + v, 0) - 1) < 1e-9 && Math.abs(m.takeout) < 1e-9);
assert.equal(kelly(0.3, 3), 0, "期待値 0.9 は賭けない");
assert(Math.abs(kelly(0.5, 3) - 0.25 * 0.25) < 1e-12, "f = (pO−1)/(O−1) の 1/4");

// ---------- 馬券の確率 (本物の Zig の WebAssembly を使う) ----------
const z = (await WebAssembly.instantiate(await readFile(new URL("../src/main/resources/static/wasm/montecarlo.wasm", import.meta.url)))).instance.exports;
const speeds = [106, 104, 102, 101, 100, 99, 98, 97];
speeds.forEach((sp, i) => z.set_horse(i, sp, 0.7, [0, 1, 2, 3][i % 4]));
const n8 = speeds.length;
z.simulate(n8, 100000, 1.0, 7);
const ord = simulateOrders(z, n8, 1.0, 20000);
for (let i = 0; i < n8; i++) {
  const mc = z.win_rate(i) / 100, p1 = probOf(ord, n8, "win", [i]);
  assert(Math.abs(mc - p1) < 4 * Math.sqrt(mc * (1 - mc) / 20000) + 0.003, `1 回ずつ走らせた勝率が simulate と一致 (${i}: ${mc} vs ${p1})`);
}
assert(Math.abs([...Array(n8).keys()].reduce((s, i) => s + probOf(ord, n8, "place", [i]), 0) - 3) < 1e-9, "複勝は毎回 3 頭当たる");
assert.equal(hits("umaren", [2, 0], [0, 2, 5], 8), true);
assert.equal(hits("umatan", [2, 0], [0, 2, 5], 8), false, "馬単は順番どおり");
assert.equal(hits("wide", [5, 0], [0, 2, 5], 8), true);
assert.equal(hits("trio", [5, 2, 0], [0, 2, 5], 8), true);
assert.equal(hits("tierce", [0, 2, 5], [0, 2, 5], 8), true);
assert.equal(hits("place", [5], [0, 2, 5], 7), false, "7 頭以下の複勝は 2 着まで");
const qm = [0.4, 0.3, 0.2, 0.1];
let sU = 0, sT = 0, sW = 0;
for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) { if (i < j) { sU += harville(qm, "umaren", [i, j]); sW += harville(qm, "wide", [i, j]); } for (let k = 0; k < 4; k++) sT += harville(qm, "tierce", [i, j, k]); }
assert(Math.abs(sU - 1) < 1e-9 && Math.abs(sT - 1) < 1e-9, "Harville の確率は合計 1");
assert(Math.abs(sW - 3) < 1e-9, "ワイドは毎回 3 組が当たる");
assert.equal(oddsFrom(0.25, 0.2), 3.2, "(1 − 0.2) ÷ 0.25");
assert.equal(oddsFrom(0.9, 0.2), 1.0, "最低 1.0 倍 (元返し)");
assert.equal(BET_TYPES.length, 7);
const st = strategies(ord, n8, [0, 1, 2, 3], [0.3, 0.2, 0.15, 0.1, 0.09, 0.07, 0.05, 0.04], [2.6, 4, 5.3, 8, 8.9, 11.4, 16, 20]);
assert.equal(st.length, 7);
assert(st.every(x => x.hitRate > 0 && x.hitRate <= 1 && x.returnRate > 0), "的中率と回収率");
assert.equal(st.find(x => x.name.startsWith("単勝")).tickets[0].estimated, false, "単勝は本物のオッズ");
assert(Math.abs(st[0].returnRate - probOf(ord, n8, "win", [0]) * 2.6) < 1e-9, "回収率 = 的中率 × オッズ (1 点)");
assert(st.find(x => x.name.startsWith("3連複")).points === 4 && st.find(x => x.name.startsWith("3連単")).points === 6);
const cm = commentary({ horses: card.runners.map(r => ({ ...r, popularity: r.pop })), f, p: [0.5, 0.3, 0.2], q: [0.5, 0.25, 0.25], pace: paceOf(f.map(v => v.style)), race });
assert.equal(cm.picks[0].mark, "◎");
assert(cm.picks[0].reasons[0].includes("前走 GII 1着/12頭"));
assert(cm.picks[2].reasons.some(t => t.includes("過去の出走がなく")));
assert(cm.pace.includes("スローペース"));

// ---------- 採用モデル (Kotlin の ModelService が学習したもの) ----------
const qq = [0.5, 0.3, 0.15, 0.05], XX = qq.map(() => [0.5, -0.01, 0, 0, 0, 4]);
const marketOnly = { alpha: 1, mean: [0, 0, 0, 0, 0, 0], sd: [1, 1, 1, 1, 1, 1], beta: [0, 0, 0, 0, 0, 0] };
fittedProbs(marketOnly, XX, qq).forEach((v, i) => assert(Math.abs(v - qq[i]) < 1e-12, "市場を採用したら、勝率 = 市場の確率"));
assert.equal(fittedProbs(marketOnly, XX, [0.5, 0.5, 0, 0]), null, "オッズのない馬がいたら使わない (手動モデルへ)");
assert.equal(fittedProbs(null, XX, qq), null);
const so = sampleOrders(qq, 40000);
qq.forEach((v, i) => assert(Math.abs(probOf(so, 4, "win", [i]) - v) < 0.01, `くじ引きの 1 着の割合 = 勝率 (${i})`));
assert(Math.abs(probOf(so, 4, "umatan", [0, 1]) - harville(qq, "umatan", [0, 1])) < 0.01, "2 着も同じモデル (Harville の式) どおり");
assert.equal(normSurface("芝 内外"), "芝");
assert.equal(normSurface("ダート"), "ダート");

// ---------- 取得計画 ----------
const at = (iso) => Date.parse(iso); // JST で書く
const sat = at("2026-11-15T10:00:00+09:00");
const fresh = { "sched:202611": sat, "sched:202612": sat, "sched:202701": sat, top: sat, results_top: sat };
assert.deepEqual(plan(sat, {}, [], []), { kind: "schedule", month: "202611" });
assert.deepEqual(plan(sat, { ...fresh, top: sat - 21 * MIN }, [], []), { kind: "top" }, "土曜は 20 分ごと");
assert.deepEqual(plan(at("2026-11-11T10:00:00+09:00"), { ...fresh, "sched:202611": at("2026-11-11T09:00:00+09:00"), top: at("2026-11-11T06:00:00+09:00") }, [], []).kind, "top");
assert.equal(plan(at("2026-11-11T10:00:00+09:00"), { ...fresh, top: at("2026-11-11T08:00:00+09:00") }, [], []).kind, "idle", "水曜は 3 時間ごと");
const mt = [{ cname: "old", date: "2026-11-15", fetched_at: sat - 4 * HOUR }, { cname: "new", date: "2026-11-15", fetched_at: 0 }, { cname: "past", date: "2026-11-14", fetched_at: 0 }];
assert.deepEqual(plan(sat, fresh, mt, []), { kind: "meeting", cname: "new" }, "未取得の開催が先");
assert.equal(plan(sat, fresh, mt.slice(2), []).kind, "idle", "終わった開催は取らない (JRA 側でページが消える)");
const rd = (post, card_at, date = "2026-11-15") => ({ id: post, cname: `c${post}`, date, post_time: post, card_at });
assert.equal(cardInterval(rd("15:40", 0, "2026-11-16"), sat), 0, "翌日のレースは未取得ならすぐ");
assert.equal(cardInterval(rd("15:40", sat, "2026-11-16"), sat), 3 * HOUR);
assert.equal(cardInterval(rd("15:40", sat), sat), 20 * MIN, "当日の発走前は 20 分ごと");
assert.equal(cardInterval(rd("09:30", at("2026-11-15T09:20:00+09:00")), sat), 0, "発走後に最後の 1 回");
assert.equal(cardInterval(rd("09:30", at("2026-11-15T09:50:00+09:00")), sat), null, "確定後はもう取らない");
assert.equal(cardInterval(rd("15:40", 0, "2026-11-14"), sat), null, "終わった日は取らない");
assert.deepEqual(plan(sat, fresh, [], [rd("15:40", sat - 25 * MIN), rd("12:00", sat - 50 * MIN)]), { kind: "card", id: "12:00", cname: "c12:00" }, "遅れが大きい方");

// ---------- tick を通しで (fetch を偽物に差し替え、D1 は node:sqlite) ----------
// Shift_JIS に変換する表を TextDecoder から作る (Node には Shift_JIS の TextEncoder がないため)
const sjis = new Map();
const dec = new TextDecoder("shift_jis");
for (let hi = 0x81; hi <= 0xfc; hi++) for (let lo = 0x40; lo <= 0xfc; lo++) {
  const ch = dec.decode(new Uint8Array([hi, lo]));
  if (ch.length === 1 && ch !== "�" && !sjis.has(ch)) sjis.set(ch, [hi, lo]);
}
const toSjis = (s) => new Uint8Array([...s].flatMap(ch => (ch.charCodeAt(0) < 0x80 ? [ch.charCodeAt(0)] : sjis.get(ch) ?? [0x3f])));
const requests = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  requests.push(`${init.method ?? "GET"} ${u.replace("https://www.jra.go.jp", "")}`);
  if (u.includes("/calendar/json/")) return new Response(JSON.stringify(SCHEDULE));
  if (init.method === "POST") return new Response(toSjis(String(init.body).includes("sli") ? RESULT_TOP : TOP));
  const sde = /CNAME=(pw01sde100520260505(\d{2})20261115)/.exec(decodeURIComponent(u));
  if (sde) return new Response(toSjis(RESULT(+sde[2])));
  if (u.includes("pw01drl")) return new Response(toSjis(LIST));
  if (u.includes("pw01dde")) return new Response(toSjis(CARD));
  return new Response("", { status: 404 });
};
const db = new DatabaseSync(":memory:");
for (const f of ["0001_init.sql", "0002_jra.sql", "0003_results.sql"]) db.exec(await readFile(new URL(`./migrations/${f}`, import.meta.url), "utf8"));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: db.prepare(sql).all(...args) }),
  first: async () => db.prepare(sql).get(...args) ?? null,
  run: async () => db.prepare(sql).run(...args),
});
const env = { DB: { prepare: sql => stmt(sql), batch: async (list) => { for (const s of list) await s.run(); } } };
let t = at("2026-11-14T10:00:00+09:00"); // 前日の土曜 → 翌日分を取る
const kinds = [];
for (let i = 0; i < 12; i++, t += MIN) kinds.push((await tick(env, t)).kind);
assert.deepEqual(kinds, ["schedule", "schedule", "schedule", "top", "meeting", "meeting", "card", "card", "results_top", "idle", "idle", "idle"], "結果は終わったレースだけ");
assert(requests.length === 9 && requests.every(r => r.startsWith("GET /") || r.startsWith("POST /")), "1 分に 1 件まで");
const row = db.prepare("SELECT * FROM jra_races WHERE id = '20261115-05-11'").get();
assert.equal(JSON.parse(row.card).runners.length, 3);

// 失敗しても止まらず、記録して次へ進む
const goodFetch = globalThis.fetch;
globalThis.fetch = async () => new Response("", { status: 503 });
t += 3 * HOUR;
assert.equal((await tick(env, t)).kind, "top");
assert.match(db.prepare("SELECT value FROM jra_state WHERE key = 'last_error'").get().value, /HTTP 503/);
assert.notEqual((await tick(env, t + MIN)).kind, "top", "失敗したものを毎分取り直さない (後ろの取得が止まらない)");
assert.equal(JSON.parse(db.prepare("SELECT card FROM jra_races WHERE id = '20261115-05-11'").get().card).runners.length, 3, "保存済みの出馬表は消えない");

// レースが終わったら結果を集める (17 時以降)。今週取り込んだ出馬表があればそれを使い、なければ取りに行く
globalThis.fetch = goodFetch;
t = at("2026-11-15T18:00:00+09:00");
const later = [];
for (let i = 0; i < 30; i++, t += MIN) {
  const k = (await tick(env, t)).kind;
  if (k === "idle") break;
  later.push(k);
}
assert.deepEqual(later.filter(k => k.startsWith("result")), ["results_top", "result", "result", "result", "result_card"], "11R → 同じ日の 9R・10R、出馬表は 9R だけ取りに行く");
const stored = db.prepare("SELECT id, result, card FROM jra_results ORDER BY id").all();
assert.deepEqual(stored.map(r => r.id), ["20261115-05-09", "20261115-05-10", "20261115-05-11"]);
assert(stored.every(r => r.result && r.card), "結果と出馬表がそろう");
assert.equal(JSON.parse(stored[2].card).runners[0].jockey, undefined, "出馬表は必要な項目だけに絞る");
assert.equal(JSON.parse(stored[2].card).runners[0].past[0].place, 1);

// ---------- 画面用 API ----------
const call = async (pq) => {
  const url = new URL(pq, "https://example.pages.dev");
  const res = await onRequest({ request: new Request(url), env, params: { path: url.pathname.replace(/^\/api\//, "").split("/") } });
  return { status: res.status, body: await res.json() };
};
const realNow = Date.now;
Date.now = () => at("2026-11-14T12:00:00+09:00");
try {
  let r = await call("/api/live/races");
  assert.deepEqual(r.body.dates, ["2026-11-15"]);
  assert.equal(r.body.races.length, 2);
  assert.equal(r.body.races[1].venueName, "東京");
  assert.equal(r.body.races[1].hasCard, true);
  r = await call("/api/live/race?id=20261115-05-11");
  assert.equal(r.body.card.header.name, "テスト記念");
  assert.equal((await call("/api/live/race?id=../../x")).status, 400);
  assert.equal((await call("/api/live/race?id=20991231-05-11")).status, 404);
  r = await call("/api/live/schedule");
  assert.deepEqual(r.body.map(d => [d.date, d.hasRaces]), [["2026-11-15", true], ["2026-11-16", false]], "開催のない日は出さない");
  assert((await call("/api/live/status")).body.last_tick);
  r = await call("/api/live/results");
  assert.equal(r.body.length, 3);
  assert.equal(r.body[0].venueName, "東京");
  assert.deepEqual(r.body.find(x => x.id === "20261115-05-11").result.payouts.win, [{ combo: "2", yen: 450 }]);
} finally {
  Date.now = realNow;
}
console.log("JRA 自動取得: すべて OK");
