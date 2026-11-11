// ==================================================================================
// Cloudflare Pages Functions — /api/* をまとめて処理する
// ==================================================================================
// Pages では Kotlin のサーバーが動かないので、Kotlin 版 (src/main/kotlin/.../Main.kt) と
// 同じ URL・同じ JSON の形の API をここで作る。画面 (static/js/main.js) は変更なしで動く。
//   - 名鑑・競走・競馬場などのデータ … ビルド時に Kotlin が書き出した dist/data/*.json を読む
//   - 天気・写真のクレジット・要約   … Open-Meteo / Wikipedia の無料 API をその場で呼ぶ
//   - ユーザーのデータ               … Firebase Auth でサインインした人だけ、D1 に保存する
// 検索と並び替えのルールは service/LibraryService.kt と同じにしている (変えるときは両方を直す)。
//
// 使う Cloudflare の機能 (wrangler.jsonc で設定):
//   DATA (R2) … data/*.json の置き場。なければ dist/data/*.json (静的ファイル) を使う
//   DB   (D1) … users / favorites / notes / sim_results テーブル (migrations/0001_init.sql)

import { verifyIdToken, type FirebaseUser } from "../../lib/firebase-auth.ts";
import { parseScheduleMonth } from "../../lib/jra.ts";

// Cloudflare の型定義パッケージを入れずに済むよう、使う部分だけを書いた最小限の型
interface D1Stmt { bind(...v: unknown[]): D1Stmt; all<T = any>(): Promise<{ results: T[] }>; first<T = any>(): Promise<T | null>; run(): Promise<{ meta: { changes: number } }> }
interface Env {
  ASSETS: { fetch: (req: Request | string) => Promise<Response> };
  DATA?: { get(key: string): Promise<{ json(): Promise<any> } | null> };
  DB?: { prepare(sql: string): D1Stmt; batch(s: D1Stmt[]): Promise<unknown> };
  FIREBASE_API_KEY?: string; FIREBASE_AUTH_DOMAIN?: string; FIREBASE_PROJECT_ID?: string; FIREBASE_APP_ID?: string;
}
type Ctx = { request: Request; env: Env; params: { path?: string[] } };

const UA = "KeibaVision/2.0 (https://github.com/TatsuyaM2667/keiba-predictor)";

// --- データ (JSON) を読む: R2 → なければ静的ファイル。同じ実行環境 (isolate) では 10 分間使い回す ---
// (R2 を更新しても、古い isolate が残っている間は最大 10 分前のデータが返ることがある)
const memo = new Map<string, { at: number; value: Promise<any> }>();
async function load(env: Env, url: URL, name: string): Promise<any> {
  const obj = await env.DATA?.get(`data/${name}.json`).catch(() => null);
  if (obj) return obj.json();
  const r = await env.ASSETS.fetch(new URL(`/data/${name}.json`, url.origin).toString());
  // 無いファイルを頼むと Pages は index.html (HTML) を返すので、JSON かどうかも確かめる
  if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) throw new Error(`data/${name}.json がありません`);
  return r.json();
}
function data(env: Env, url: URL, name: string): Promise<any> {
  const hit = memo.get(name);
  if (hit && Date.now() - hit.at < 600_000) return hit.value;
  const value = load(env, url, name);
  memo.set(name, { at: Date.now(), value });
  value.catch(() => memo.delete(name)); // 失敗は覚えない (次のリクエストで再挑戦)
  return value;
}

const json = (body: unknown, status = 200, maxAge = 0) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": maxAge ? `public, max-age=${maxAge}` : "no-store" },
  });

const int = (v: string | null, def: number) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) ? n : def; };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

// --- 名鑑の検索 (LibraryService.searchHorses と同じ) ---
function searchHorses(views: any[], q: URLSearchParams) {
  const needle = (q.get("q") ?? "").trim().toLowerCase();
  const sex = q.get("sex") ?? "", surface = q.get("surface") ?? "", photo = q.get("photo") === "1";
  let list = views.filter(v => {
    const h = v.horse;
    if (needle && !(h.name.toLowerCase().includes(needle) || h.nameEn.toLowerCase().includes(needle) ||
      h.sire.includes(needle) || h.dam.includes(needle) || h.bigWins.some((w: any) => w.race.includes(needle)))) return false;
    if (photo && !h.image) return false;
    if (sex && !h.sex.startsWith(sex)) return false;
    if (surface && !v.surface.includes(surface)) return false;
    return true;
  });
  const by: Record<string, (a: any, b: any) => number> = {
    name: (a, b) => (a.horse.name < b.horse.name ? -1 : a.horse.name > b.horse.name ? 1 : 0),
    new: (a, b) => (b.horse.birthYear ?? 0) - (a.horse.birthYear ?? 0),
    old: (a, b) => (a.horse.birthYear ?? 9999) - (b.horse.birthYear ?? 9999),
    wins: (a, b) => b.gradedWins - a.gradedWins,
    rating: (a, b) => b.rating - a.rating || b.gradedWins - a.gradedWins,
  };
  list = list.slice().sort(by[q.get("sort") ?? "rating"] ?? by.rating);
  const offset = Math.max(0, int(q.get("offset"), 0)), limit = clamp(int(q.get("limit"), 48), 1, 200);
  return { total: list.length, items: list.slice(offset, offset + limit) };
}

// --- 競走一覧の検索 (LibraryService.searchRaces と同じ) ---
const gradeOrder = (g: string) => /^(G|Jpn)I$/.test(g) ? 0 : /^(G|Jpn)II$/.test(g) ? 1 : /^(G|Jpn)III$/.test(g) ? 2 : g ? 3 : 4;
function searchRaces(races: any[], q: URLSearchParams) {
  const needle = (q.get("q") ?? "").trim(), course = q.get("course") ?? "", grade = q.get("grade") ?? "", surface = q.get("surface") ?? "";
  const list = races.filter(r =>
    (!needle || r.name.includes(needle) || r.title.includes(needle)) &&
    (!course || r.course.includes(course)) &&
    (!grade || r.grade === grade) &&
    (!surface || r.surface.includes(surface)))
    .sort((a, b) => gradeOrder(a.grade) - gradeOrder(b.grade) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const offset = Math.max(0, int(q.get("offset"), 0)), limit = clamp(int(q.get("limit"), 100), 1, 500);
  return { total: list.length, items: list.slice(offset, offset + limit) };
}

// --- 天気 (WeatherService.currentFor と同じ。WMO 天気コード → 日本語・アイコン・推定馬場) ---
function interpret(code: number, precip: number): [string, string, string] {
  if (code === 0) return ["快晴", "sun", "FIRM"];
  if (code === 1 || code === 2) return ["晴れ", "cloud-sun", "FIRM"];
  if (code === 3) return ["曇り", "cloud", "FIRM"];
  if (code === 45 || code === 48) return ["霧", "cloud-fog", "GOOD"];
  if ([51, 53, 55].includes(code)) return ["小雨", "cloud-drizzle", precip > 1.5 ? "YIELDING" : "GOOD"];
  if ([71, 73, 75, 77, 85, 86].includes(code)) return ["雪", "cloud-snow", "YIELDING"];
  if ([61, 63, 65].includes(code)) return ["雨", "cloud-rain", "YIELDING"];
  if ([80, 81, 82].includes(code)) return ["強い雨", "cloud-lightning", "SOFT"];
  return ["曇り", "cloud", "FIRM"];
}
async function weather(courses: any[]) {
  const pts = courses.filter(c => c.lat != null && c.lon != null);
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + pts.map(c => c.lat.toFixed(4)).join(",") +
    "&longitude=" + pts.map(c => c.lon.toFixed(4)).join(",") +
    "&current=temperature_2m,precipitation,weather_code,wind_speed_10m&timezone=Asia%2FTokyo";
  // Cloudflare のキャッシュに 10 分置く (同じ URL への問い合わせを Open-Meteo に送りすぎない)
  const res = await fetch(url, { cf: { cacheTtl: 600, cacheEverything: true } } as RequestInit);
  if (!res.ok) return [];
  const root: any = await res.json();
  const arr = Array.isArray(root) ? root : [root];
  return arr.map((el, i) => {
    const c = el.current, precip = c.precipitation ?? 0;
    const [description, icon, trackCondition] = interpret(c.weather_code ?? 0, precip);
    return { id: pts[i].id, temperatureC: c.temperature_2m ?? 0, description, icon, windKmh: c.wind_speed_10m ?? 0, precipitationMm: precip, trackCondition };
  });
}

// --- Wikipedia: 要約と写真のクレジット (WikiClient.summary / credits と同じ) ---
const plain = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
async function summary(title: string): Promise<string | null> {
  const r = await fetch("https://ja.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title.replace(/ /g, "_")),
    { headers: { "user-agent": UA }, cf: { cacheTtl: 86400, cacheEverything: true } } as RequestInit);
  return r.ok ? ((await r.json()) as any).extract ?? null : null;
}
async function credits(files: string[]) {
  if (!files.length) return [];
  const p = new URLSearchParams({
    action: "query", prop: "imageinfo", iiprop: "url|extmetadata", iiurlwidth: "800",
    titles: files.map(f => `File:${f}`).join("|"), format: "json", formatversion: "2",
  });
  const r = await fetch(`https://ja.wikipedia.org/w/api.php?${p}`, { headers: { "user-agent": UA }, cf: { cacheTtl: 86400, cacheEverything: true } } as RequestInit);
  if (!r.ok) return [];
  const pages: any[] = ((await r.json()) as any).query?.pages ?? [];
  return pages.flatMap(pg => {
    const info = pg.imageinfo?.[0];
    if (!info) return [];
    const m = (k: string) => info.extmetadata?.[k]?.value ?? "";
    return [{ file: String(pg.title).replace(/^[^:]*:/, "").replace(/ /g, "_"), thumbUrl: info.thumburl ?? null, pageUrl: info.descriptionurl ?? null, artist: plain(m("Artist")).slice(0, 120), license: m("LicenseShortName") }];
  });
}

// --- ユーザー (Firebase Auth + D1) ---------------------------------------------------
const firebaseConfig = (env: Env) => env.FIREBASE_PROJECT_ID && env.FIREBASE_API_KEY
  ? { apiKey: env.FIREBASE_API_KEY, authDomain: env.FIREBASE_AUTH_DOMAIN, projectId: env.FIREBASE_PROJECT_ID, appId: env.FIREBASE_APP_ID }
  : null;

/** Authorization: Bearer <ID トークン> を検証し、初回なら users に登録する。サインインしていなければ null */
async function currentUser(request: Request, env: Env): Promise<FirebaseUser | null> {
  if (!env.DB || !env.FIREBASE_PROJECT_ID) return null;
  const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  const user = token ? await verifyIdToken(token, env.FIREBASE_PROJECT_ID) : null;
  if (user) {
    await env.DB.prepare(
      `INSERT INTO users (uid, name, email, photo_url) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(uid) DO UPDATE SET name = ?2, email = ?3, photo_url = ?4, last_seen = datetime('now')`
    ).bind(user.uid, user.name, user.email, user.picture).run();
  }
  return user;
}

/** 画面が使う UserProfile の形 (Kotlin 版の model/Models.kt と同じ) にまとめる */
async function profile(env: Env, u: FirebaseUser) {
  const [favs, notes] = await Promise.all([
    env.DB!.prepare("SELECT horse FROM favorites WHERE uid = ? ORDER BY created_at").bind(u.uid).all<{ horse: string }>(),
    env.DB!.prepare("SELECT race_id, note FROM notes WHERE uid = ?").bind(u.uid).all<{ race_id: string; note: string }>(),
  ]);
  return {
    id: u.uid, name: u.name || u.email || "ユーザー", email: u.email, avatarUrl: u.picture, provider: "google",
    favoriteHorses: favs.results.map(r => r.horse),
    notes: Object.fromEntries(notes.results.map(r => [r.race_id, r.note])),
  };
}

/** リクエストの JSON 本文を読む。壊れていたら null (呼び出し側で 400 にする) */
const body = async (request: Request): Promise<any> => {
  if ((Number(request.headers.get("content-length")) || 0) > 32_000) return null; // 大きすぎる本文は受け取らない
  return request.json().catch(() => null);
};
const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);

async function userApi(path: string, request: Request, env: Env): Promise<Response | null> {
  const post = request.method === "POST";
  switch (path) {
    case "config": return json({ firebase: firebaseConfig(env) }, 200, 300);
    case "auth/me": case "favorites": case "notes": case "sims": break;
    case "auth/login": return json({ error: "サインインは画面の Google ボタンから行ってください" }, 501);
    case "auth/logout": return json({ status: "logged_out" }); // Firebase のサインアウトはブラウザ側で行う
    default: return null;
  }
  const u = await currentUser(request, env);
  if (!u) return json({ error: firebaseConfig(env) ? "サインインしてください" : "この環境ではサインインできません" }, firebaseConfig(env) ? 401 : 501);
  const db = env.DB!;

  if (path === "auth/me") return json(await profile(env, u));

  if (path === "favorites" && post) {
    // 押すたびに追加 / 解除が切り替わる (Kotlin 版の AuthService.addFavorite と同じ)
    const horse = str((await body(request))?.horseName, 200);
    if (!horse) return json({ error: "horseName が必要です" }, 400);
    const del = await db.prepare("DELETE FROM favorites WHERE uid = ? AND horse = ?").bind(u.uid, horse).run();
    if (!del.meta.changes) await db.prepare("INSERT INTO favorites (uid, horse) VALUES (?, ?)").bind(u.uid, horse).run();
    return json(await profile(env, u));
  }

  if (path === "notes" && post) {
    const b = await body(request);
    const raceId = str(b?.raceId, 64), note = str(b?.note, 5000);
    if (!raceId || note === null) return json({ error: "raceId と note (5000 文字まで) が必要です" }, 400);
    if (note.trim()) {
      await db.prepare(`INSERT INTO notes (uid, race_id, note) VALUES (?1, ?2, ?3)
        ON CONFLICT(uid, race_id) DO UPDATE SET note = ?3, updated_at = datetime('now')`).bind(u.uid, raceId, note).run();
    } else {
      await db.prepare("DELETE FROM notes WHERE uid = ? AND race_id = ?").bind(u.uid, raceId).run(); // 空にしたら削除
    }
    return json(await profile(env, u));
  }

  if (path === "sims" && post) {
    const b = await body(request);
    const courseId = str(b?.courseId, 32), course = str(b?.course, 32), surface = str(b?.surface, 8);
    const distance = Number(b?.distance);
    const result = Array.isArray(b?.result) && b.result.length >= 2 && b.result.length <= 18
      ? b.result.map((r: any) => ({ name: String(r?.name ?? "").slice(0, 60), num: Number(r?.num) || 0, waku: Number(r?.waku) || 0, time: Number(r?.time) || 0, margin: String(r?.margin ?? "").slice(0, 12) }))
      : null;
    if (!courseId || !course || !surface || !Number.isFinite(distance) || distance < 100 || distance > 5000 || !result) return json({ error: "結果の形が正しくありません" }, 400);
    await db.prepare("INSERT INTO sim_results (uid, course_id, course, distance, surface, result) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(u.uid, courseId, course, Math.round(distance), surface, JSON.stringify(result)).run();
    // 1 人あたり新しい 100 件だけ残す
    await db.prepare(`DELETE FROM sim_results WHERE uid = ?1 AND id NOT IN
      (SELECT id FROM sim_results WHERE uid = ?1 ORDER BY id DESC LIMIT 100)`).bind(u.uid).run();
    return json({ ok: true });
  }

  if (path === "sims") {
    const rows = await db.prepare("SELECT id, course_id, course, distance, surface, result, created_at FROM sim_results WHERE uid = ? ORDER BY id DESC LIMIT 30")
      .bind(u.uid).all<any>();
    return json(rows.results.map(r => ({ ...r, result: JSON.parse(r.result) })));
  }
  return json({ error: "Method Not Allowed" }, 405);
}

// --- JRA の実データ (keiba-vision-sync Worker が D1 に入れたもの) -----------------------
const VENUE_NAMES: Record<string, string> = { "01": "札幌", "02": "函館", "03": "福島", "04": "新潟", "05": "東京", "06": "中山", "07": "中京", "08": "京都", "09": "阪神", "10": "小倉" };
const jstToday = (offsetDays = 0) => new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);

async function liveApi(path: string, q: URLSearchParams, env: Env): Promise<Response | null> {
  if (!path.startsWith("live/")) return null;
  if (!env.DB) return json({ error: "この環境では使えません" }, 501);
  const db = env.DB;

  if (path === "live/schedule") {
    // 今日から 10 週間先までの開催日と重賞
    const rows = await db.prepare("SELECT month, json FROM jra_schedule ORDER BY month").all<{ month: string; json: string }>();
    const from = jstToday(), to = jstToday(70);
    // 各月の JSON からは、その月の日だけを使う (前後の月が混ざっていても二重にならないように)
    const days = rows.results.flatMap(r => parseScheduleMonth(JSON.parse(r.json), Number(r.month.slice(0, 4)))
      .filter(d => d.date.slice(0, 7) === `${r.month.slice(0, 4)}-${r.month.slice(4)}`))
      .filter(d => d.meetings.length && d.date >= from && d.date <= to);
    const withRaces = await db.prepare("SELECT DISTINCT date FROM jra_races WHERE date >= ?").bind(from).all<{ date: string }>();
    const has = new Set(withRaces.results.map(r => r.date));
    return json(days.map(d => ({ ...d, hasRaces: has.has(d.date) })), 200, 300);
  }

  if (path === "live/races") {
    // 今日以降に出馬表がある日。なければ直近の開催 (結果が出たあとの振り返り用)
    let dates = (await db.prepare("SELECT DISTINCT date FROM jra_races WHERE date >= ? ORDER BY date").bind(jstToday()).all<{ date: string }>()).results.map(r => r.date);
    if (!dates.length) dates = (await db.prepare("SELECT DISTINCT date FROM jra_races ORDER BY date DESC LIMIT 2").all<{ date: string }>()).results.map(r => r.date).reverse();
    if (!dates.length) return json({ dates: [], races: [] }, 200, 60);
    const races = await db.prepare(
      `SELECT id, date, venue, race_no, post_time, name, grade, cond, surface, distance, field, card_at, card IS NOT NULL AS has_card
       FROM jra_races WHERE date IN (${dates.map(() => "?").join(",")}) ORDER BY date, venue, race_no`
    ).bind(...dates).all<any>();
    return json({
      dates,
      races: races.results.map(r => ({ ...r, venueName: VENUE_NAMES[r.venue] ?? r.venue, hasCard: !!r.has_card, has_card: undefined })),
    }, 200, 60);
  }

  if (path === "live/race") {
    const id = q.get("id") ?? "";
    if (!/^\d{8}-\d{2}-\d{2}$/.test(id)) return json({ error: "id の形式が正しくありません" }, 400);
    const r = await db.prepare("SELECT * FROM jra_races WHERE id = ?").bind(id).first<any>();
    if (!r) return json({ error: "見つかりません" }, 404);
    return json({ ...r, venueName: VENUE_NAMES[r.venue] ?? r.venue, card: r.card ? JSON.parse(r.card) : null }, 200, 60);
  }

  if (path === "live/results") {
    // 予想の答え合わせ用: 結果と出馬表がそろった過去のレース (新しい順)。
    // 保存してある JSON は解析せずにそのままつなげる (Functions の CPU 時間の上限を超えないため)
    const rows = await db.prepare(
      `SELECT id, date, venue, race_no, name, grade, result, card FROM jra_results
       WHERE result IS NOT NULL AND card IS NOT NULL ORDER BY date DESC, venue, race_no LIMIT ?`
    ).bind(Math.min(500, Math.max(1, int(q.get("limit"), 300)))).all<any>();
    const body = `[${rows.results.map(r =>
      `{"id":${JSON.stringify(r.id)},"date":${JSON.stringify(r.date)},"venueName":${JSON.stringify(VENUE_NAMES[r.venue] ?? r.venue)},"race_no":${Number(r.race_no)},"name":${JSON.stringify(r.name)},"grade":${JSON.stringify(r.grade)},"result":${r.result},"card":${r.card}}`
    ).join(",")}]`;
    return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=600" } });
  }

  if (path === "live/status") {
    const rows = await db.prepare("SELECT key, value FROM jra_state WHERE key IN ('last_tick', 'last_ok', 'last_error', 'top')").all<{ key: string; value: string }>();
    return json(Object.fromEntries(rows.results.map(r => [r.key, r.value])), 200, 30);
  }
  return json({ error: "Not Found" }, 404);
}

export const onRequest = async ({ request, env, params }: Ctx): Promise<Response> => {
  const url = new URL(request.url);
  const q = url.searchParams;
  const path = (params.path ?? []).join("/");
  const d = (name: string) => data(env, url, name);
  try {
    const user = await userApi(path, request, env);
    if (user) return user;
    const live = await liveApi(path, q, env);
    if (live) return live;
    switch (path) {
      case "health": return json({ status: "ok", version: "2.0.0", runtime: "cloudflare-pages" });
      case "library/status": return json(await d("status"), 200, 3600);
      // Pages ではデータの再取得はできない (ビルド時に書き出す)。今の状態をそのまま返す
      case "library/refresh": return json(await d("status"));
      case "horses": return json(searchHorses(await d("horses"), q), 200, 300);
      case "horses/detail": {
        const title = q.get("title");
        if (!title) return json({ error: "title が必要です" }, 400);
        const view = (await d("horses")).find((v: any) => v.horse.title === title);
        if (!view) return json({ error: "見つかりません" }, 404);
        return json({ view, summary: await summary(title).catch(() => null) }, 200, 3600);
      }
      case "catalog/races": return json(searchRaces(await d("races-catalog"), q), 200, 300);
      case "courses": return json(await d("courses"), 200, 3600);
      case "weather": return json(await weather(await d("courses")), 200, 600);
      case "media": return json(await credits((q.get("files") ?? "").split("|").filter(Boolean).slice(0, 50)), 200, 86400);
      case "encyclopedia/pedigree": return json(await d("pedigree"), 200, 3600);
      case "encyclopedia/breeds": return json(await d("breeds"), 200, 3600);
      case "encyclopedia/coats": return json(await d("coats"), 200, 3600);
      case "races": return json(await d("races"), 200, 3600);
      // 採用した予想モデル (ビルド時に Kotlin の ModelService が過去のレースで学習・交差検証して書き出したもの)
      case "model/params": return json(await d("model-params"), 200, 3600);
    }
    const m = path.match(/^races\/([\w-]+)(\/analysis)?$/);
    if (m) {
      const race = (await d("races")).find((r: any) => r.id === m[1]);
      if (!race) return json({ error: "見つかりません" }, 404);
      return json(m[2] ? await d(`analysis-${m[1]}`) : race, 200, 3600);
    }
    return json({ error: "Not Found" }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
};
