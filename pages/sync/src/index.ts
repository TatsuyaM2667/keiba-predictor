// ==================================================================================
// keiba-vision-sync — JRA 公式サイトから開催日程・出馬表・オッズを自動で取り込む Worker
// ==================================================================================
// Cloudflare の Cron Trigger で 1 分ごとに起動し、plan() が選んだ 1 件だけを取得して D1 に保存する。
// 人の操作は一切いらない。画面 (Pages) は D1 を読むだけで、予想の計算はブラウザ (Zig の Wasm) が行う。
//   GET / … 取得の状態 (最終取得時刻・最後のエラー・件数) を JSON で返す (動作確認用)

import { decodeSjis, parseTop, parseRaceList, parseCard, parseResultTop, parseResult, parseRaceCname, compactCard } from "../../lib/jra.ts";
import { plan, jst, type Meeting, type RaceDue, type ResultDue } from "./plan.ts";

interface D1Stmt { bind(...v: unknown[]): D1Stmt; all<T = any>(): Promise<{ results: T[] }>; first<T = any>(): Promise<T | null>; run(): Promise<unknown> }
interface Env { DB: { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<unknown> } }

const BASE = "https://www.jra.go.jp";
const HOUR_MS = 3_600_000;
const UA = "KeibaVision/2.0 (+https://github.com/TatsuyaM2667/keiba-predictor)";

async function get(path: string): Promise<Response> {
  const res = await fetch(BASE + path, { headers: { "user-agent": UA, "accept-language": "ja" }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res;
}
const page = async (cname: string, kind = "D") => decodeSjis(await (await get(`/JRADB/access${kind}.html?CNAME=${encodeURIComponent(cname)}`)).arrayBuffer());
async function post(path: string, body: string) {
  const res = await fetch(BASE + path, {
    method: "POST", body, signal: AbortSignal.timeout(20_000),
    headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" },
  });
  if (!res.ok) throw new Error(`${path} ${body}: HTTP ${res.status}`);
  return decodeSjis(await res.arrayBuffer());
}
// 結果の一覧に載ったレースを、まだなければ追加する
const addResult = (db: Env["DB"], cname: string) => {
  const o = parseRaceCname(cname)!;
  return db.prepare("INSERT INTO jra_results (id, date, venue, race_no, cname) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING").bind(o.id, o.date, o.venue, o.raceNo, cname);
};

const setState = (env: Env, key: string, value: string | number) =>
  env.DB.prepare("INSERT INTO jra_state (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2").bind(key, String(value)).run();

export async function tick(env: Env, now = Date.now()) {
  const db = env.DB;
  const today = jst(now).date;
  const [state, meetings, races, results] = await Promise.all([
    db.prepare("SELECT key, value FROM jra_state").all<{ key: string; value: string }>(),
    db.prepare("SELECT cname, date, fetched_at FROM jra_meetings WHERE date >= ?").bind(today).all<Meeting>(),
    db.prepare("SELECT id, cname, date, post_time, card_at FROM jra_races WHERE date >= ?").bind(today).all<RaceDue>(),
    db.prepare(`SELECT id, date, cname, result_at, result IS NOT NULL AS has_result, card_cname, card_at, card IS NOT NULL AS has_card
                FROM jra_results WHERE (result IS NULL OR card IS NULL) AND date >= date(?, '-90 days') ORDER BY date DESC LIMIT 300`).bind(today).all<ResultDue>(),
  ]);
  const task = plan(now, Object.fromEntries(state.results.map(r => [r.key, r.value])), meetings.results, races.results, results.results);
  await setState(env, "last_tick", now);
  if (task.kind === "idle") return task;
  await setState(env, "last_task", JSON.stringify(task));

  try {
    if (task.kind === "schedule") {
      const json = await (await get(`/keiba/common/calendar/json/${task.month}.json`)).text();
      JSON.parse(json); // 壊れた応答を保存しない
      await db.prepare("INSERT INTO jra_schedule (month, json, fetched_at) VALUES (?1, ?2, ?3) ON CONFLICT(month) DO UPDATE SET json = ?2, fetched_at = ?3")
        .bind(task.month, json, now).run();
      await setState(env, `sched:${task.month}`, now);
    } else if (task.kind === "top") {
      // 出馬表トップは POST で開く画面
      const list = parseTop(await post("/JRADB/accessD.html", "cname=pw01dli00/F3"));
      await db.batch([
        ...list.map(m => db.prepare("INSERT INTO jra_meetings (cname, date, venue, label) VALUES (?, ?, ?, ?) ON CONFLICT(cname) DO NOTHING").bind(m.cname, m.date, m.venue, m.label)),
        // 10 日より前のデータは消す (容量を増やし続けないため)
        db.prepare("DELETE FROM jra_meetings WHERE date < date(?, '-10 days')").bind(today),
        db.prepare("DELETE FROM jra_races WHERE date < date(?, '-10 days')").bind(today),
      ]);
      await setState(env, "top", now);
    } else if (task.kind === "meeting") {
      const rows = parseRaceList(await page(task.cname));
      if (!rows.length) throw new Error(`${task.cname}: レースが見つかりません (ページの形式が変わった可能性)`);
      await db.batch([
        ...rows.map(r => db.prepare(
          `INSERT INTO jra_races (id, date, venue, race_no, post_time, name, grade, cond, surface, distance, field, cname)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
           ON CONFLICT(id) DO UPDATE SET post_time = ?5, name = ?6, grade = ?7, cond = ?8, surface = ?9, distance = ?10, field = ?11, cname = ?12`
        ).bind(r.id, r.date, r.venue, r.raceNo, r.postTime, r.name, r.grade, r.cond, r.surface, r.distance, r.field, r.cname)),
        db.prepare("UPDATE jra_meetings SET fetched_at = ? WHERE cname = ?").bind(now, task.cname),
      ]);
    } else if (task.kind === "card") {
      const card = parseCard(await page(task.cname));
      if (!card.runners.length) throw new Error(`${task.cname}: 出走馬が見つかりません (ページの形式が変わった可能性)`);
      await db.prepare("UPDATE jra_races SET card = ?, card_at = ? WHERE id = ?").bind(JSON.stringify(card), now, task.id).run();
      // 出馬表の頭数がレース一覧の頭数より少なければ、読み取りに失敗した馬がいる (保存はして、警告を残す)
      const row = await db.prepare("SELECT field FROM jra_races WHERE id = ?").bind(task.id).first<{ field: number | null }>();
      if (row?.field && card.runners.length < row.field) {
        await setState(env, "last_warning", JSON.stringify({ at: now, id: task.id, message: `出馬表が ${card.runners.length} 頭しか読めません (レース一覧では ${row.field} 頭)` }));
      }
    } else if (task.kind === "results_top") {
      const list = parseResultTop(await post("/JRADB/accessS.html", "cname=pw01sli00/AF"));
      if (!list.length) throw new Error("結果一覧: レースが見つかりません (ページの形式が変わった可能性)");
      await db.batch(list.map(c => addResult(db, c)));
      await setState(env, "results_top", now);
    } else if (task.kind === "result") {
      const html = await page(task.cname, "S");
      const r = parseResult(html, task.cname);
      if (!r.order.length || !r.payouts.win.length) throw new Error(`${task.cname}: 着順が見つかりません (まだ確定していない可能性)`);
      const head = parseCard(html).header;
      const self = parseRaceCname(task.cname)!;
      await db.batch([
        db.prepare("UPDATE jra_results SET name = ?, grade = ?, result = ?, result_at = ?, card_cname = ? WHERE id = ?")
          .bind(head.name, head.grade, JSON.stringify({ order: r.order, payouts: r.payouts }), now, r.cardCname, task.id),
        // 今週取り込んだ出馬表 (発走後の確定オッズ) があれば、それを使う (JRA にもう一度取りに行かない)
        db.prepare("UPDATE jra_results SET card = (SELECT card FROM jra_races WHERE id = ?1), card_at = ?2 WHERE id = ?1 AND EXISTS (SELECT 1 FROM jra_races WHERE id = ?1 AND card IS NOT NULL)")
          .bind(task.id, now),
        // 最近 (7 日以内) の開催は、同じ日の全レースの結果も集める
        ...(self.date >= jst(now - 7 * 24 * HOUR_MS).date ? r.siblings.map(c => addResult(db, c)) : []),
      ]);
      // jra_races の出馬表は詳しい形のままなので、ここで絞った形に置き換える
      const copied = await db.prepare("SELECT card FROM jra_results WHERE id = ?").bind(task.id).first<{ card: string | null }>();
      if (copied?.card) await db.prepare("UPDATE jra_results SET card = ? WHERE id = ?").bind(JSON.stringify(compactCard(JSON.parse(copied.card))), task.id).run();
    } else if (task.kind === "result_card") {
      const card = parseCard(await page(task.cname));
      if (!card.runners.length) throw new Error(`${task.cname}: 出走馬が見つかりません`);
      await db.prepare("UPDATE jra_results SET card = ?, card_at = ? WHERE id = ?").bind(JSON.stringify(compactCard(card)), now, task.id).run();
    }
    await setState(env, "last_ok", now);
  } catch (e) {
    // 失敗しても止まらない。次の起動 (1 分後) に同じものをもう一度試す
    await setState(env, "last_error", JSON.stringify({ at: now, task, message: String(e) }));
    // ただし同じ所で失敗し続けて後ろの取得が止まらないよう「今取得した」ことにして、通常の更新間隔のあとで再挑戦する
    // (保存済みのデータはそのまま残る。まだ公開されていない先の月の日程は 403 が返るので、12 時間後にまた試す)
    if (task.kind === "schedule") await setState(env, `sched:${task.month}`, now);
    if (task.kind === "top") await setState(env, "top", now);
    if (task.kind === "meeting") await db.prepare("UPDATE jra_meetings SET fetched_at = ? WHERE cname = ?").bind(now, task.cname).run();
    if (task.kind === "card") await db.prepare("UPDATE jra_races SET card_at = ? WHERE id = ?").bind(now, task.id).run();
    if (task.kind === "results_top") await setState(env, "results_top", now);
    if (task.kind === "result") await db.prepare("UPDATE jra_results SET result_at = ? WHERE id = ?").bind(now, task.id).run();
    if (task.kind === "result_card") await db.prepare("UPDATE jra_results SET card_at = ? WHERE id = ?").bind(now, task.id).run();
  }
  return task;
}

export default {
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(tick(env));
  },
  async fetch(_req: Request, env: Env) {
    const state = await env.DB.prepare("SELECT key, value FROM jra_state").all<{ key: string; value: string }>();
    const counts = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM jra_meetings) AS meetings, (SELECT COUNT(*) FROM jra_races) AS races, (SELECT COUNT(*) FROM jra_races WHERE card IS NOT NULL) AS cards, (SELECT COUNT(*) FROM jra_results) AS results, (SELECT COUNT(*) FROM jra_results WHERE result IS NOT NULL AND card IS NOT NULL) AS checked").first();
    return Response.json({ state: Object.fromEntries(state.results.map(r => [r.key, r.value])), counts });
  },
};
