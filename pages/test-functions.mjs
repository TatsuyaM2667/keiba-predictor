// Pages Functions の自己チェック (workerd が動かない環境でも Node だけで確認できる)。
// 使い方: npm run build のあと node test-functions.mjs
// ASSETS は dist/ のファイルを返す偽物に差し替える。天気と Wikipedia は本物の API を呼ぶ。
import assert from "node:assert";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { onRequest } from "./functions/api/[[path]].ts";
import { setJwksFetcher, verifyIdToken } from "./lib/firebase-auth.ts";

const env = {
  ASSETS: {
    async fetch(u) {
      const path = new URL(u).pathname;
      try {
        return new Response(await readFile(new URL(`./dist${path}`, import.meta.url)), { headers: { "content-type": "application/json" } });
      } catch {
        return new Response("<html>", { headers: { "content-type": "text/html" } }); // Pages の SPA フォールバックの真似
      }
    },
  },
};
const call = async (pathAndQuery) => {
  const url = new URL(pathAndQuery, "https://example.pages.dev");
  const res = await onRequest({ request: new Request(url), env, params: { path: url.pathname.replace(/^\/api\//, "").split("/") } });
  return { status: res.status, body: await res.json() };
};

let r = await call("/api/health");
assert.equal(r.body.status, "ok");

r = await call("/api/horses?q=オグリ&limit=3");
assert(r.body.total > 0 && r.body.items[0].horse.name.includes("オグリ"));
r = await call("/api/horses?sort=rating&photo=1&limit=5");
assert.equal(r.body.items.length, 5);
assert(r.body.items.every((v, i, a) => !i || a[i - 1].rating >= v.rating), "能力値の降順");
assert(r.body.items.every(v => v.horse.image));
r = await call("/api/horses?limit=99999");
assert.equal(r.body.items.length, 200, "limit は 200 まで");

r = await call("/api/horses/detail?title=" + encodeURIComponent("オグリキャップ"));
assert.equal(r.body.view.horse.name, "オグリキャップ");
assert(r.body.summary && r.body.summary.length > 20, "Wikipedia の要約");
assert.equal((await call("/api/horses/detail?title=xxxx")).status, 404);
assert.equal((await call("/api/horses/detail")).status, 400);

r = await call("/api/jockeys?q=" + encodeURIComponent("武豊"));
assert(r.body.items.some(j => j.title === "武豊"), "騎手名鑑で検索");
r = await call("/api/jockeys?region=中央&active=1&limit=200");
assert(r.body.total > 0 && r.body.items.every(j => j.region === "中央" && j.active), "中央・現役で絞り込み");
assert(r.body.items.every((j, i, a) => !i || (a[i - 1].g1Wins ?? -1) >= (j.g1Wins ?? -1)), "GI 勝利数の多い順");
r = await call("/api/jockeys/detail?title=" + encodeURIComponent("武豊"));
assert.equal(r.body.jockey.name, "武豊");
assert.equal((await call("/api/jockeys/detail?title=xxxx")).status, 404);

r = await call("/api/catalog/races?grade=GI&limit=500");
assert(r.body.total > 0 && r.body.items.every(x => x.grade === "GI"), "GI は完全一致");

r = await call("/api/courses");
assert.equal(r.body.length, 25);
r = await call("/api/weather");
assert(r.body.length >= 20 && r.body[0].icon, "天気");
r = await call("/api/media?files=Oguri_Cap_in_Yushun_Stallion_station.jpg");
assert(r.body[0].license, "写真のライセンス");

r = await call("/api/races");
assert.equal(r.body.length, 3);
r = await call("/api/model/params");
assert(["market", "market_power", "market_features"].includes(r.body.selected), "採用モデル");
assert.equal(r.body.beta.length, r.body.features.length);
r = await call("/api/races/arima-2026/analysis");
assert(Math.abs(r.body.predictions.reduce((s, p) => s + p.winProbability, 0) - 100) < 0.5, "サンプルの勝率の合計は 100%");
r = await call("/api/races/arima-2026/analysis");
assert(r.body.predictions.length > 0);
assert.equal((await call("/api/races/nope/analysis")).status, 404);
// Firebase が未設定の環境では、サインイン系は「使えない (501)」を返し、設定は null
assert.equal((await call("/api/auth/me")).status, 501);
assert.equal((await call("/api/favorites")).status, 501);
assert.equal((await call("/api/config")).body.firebase, null);
assert.equal((await call("/api/nothing")).status, 404);
for (const p of ["pedigree", "breeds", "coats"]) assert((await call(`/api/encyclopedia/${p}`)).body.length > 0);

// ---------------- Firebase Auth の検証 ----------------
// 本物の Google の鍵の代わりに、その場で作った RSA 鍵で署名したトークンを使う
const PROJECT = "keiba-test";
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
setJwksFetcher(async () => ({ keys: [{ ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" }], maxAge: 3600 }));
const b64 = o => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
async function token(claims = {}, { key = pair.privateKey, kid = "k1", alg = "RS256" } = {}) {
  const head = b64({ alg, kid, typ: "JWT" });
  const body = b64({ iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, sub: "user-1", iat: now - 10, exp: now + 3600, auth_time: now - 10, name: "テスト太郎", email: "t@example.com", picture: "", ...claims });
  const sig = Buffer.from(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${head}.${body}`))).toString("base64url");
  return `${head}.${body}.${sig}`;
}
assert.equal((await verifyIdToken(await token(), PROJECT))?.uid, "user-1", "正しいトークンは通る");
assert.equal(await verifyIdToken(await token({ exp: now - 3600 }), PROJECT), null, "期限切れ");
assert.equal(await verifyIdToken(await token({ iat: now + 3600 }), PROJECT), null, "未来に発行");
assert.equal(await verifyIdToken(await token({ aud: "other" }), PROJECT), null, "別のプロジェクト宛て");
assert.equal(await verifyIdToken(await token({ iss: "https://evil.example" }), PROJECT), null, "発行元が違う");
assert.equal(await verifyIdToken(await token({ sub: "" }), PROJECT), null, "uid が空");
assert.equal(await verifyIdToken(await token({}, { key: other.privateKey }), PROJECT), null, "別の鍵で署名");
assert.equal(await verifyIdToken(await token({}, { kid: "nope" }), PROJECT), null, "知らない鍵 ID");
assert.equal(await verifyIdToken(await token({}, { alg: "none" }), PROJECT), null, "alg=none");
const good = await token();
const [h, p, sg] = good.split(".");
assert.equal(await verifyIdToken(`${h}.${b64({ ...JSON.parse(Buffer.from(p, "base64url")), sub: "admin" })}.${sg}`, PROJECT), null, "中身の書き換え");
assert.equal(await verifyIdToken("garbage", PROJECT), null);

// ---------------- D1 (Node 内蔵の SQLite で代用) ----------------
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(await readFile(new URL("./migrations/0001_init.sql", import.meta.url), "utf8"));
const stmt = (sql, args = []) => ({
  bind: (...a) => stmt(sql, a),
  all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  first: async () => sqlite.prepare(sql).get(...args) ?? null,
  run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...args).changes) } }),
});
const authEnv = { ...env, DB: { prepare: sql => stmt(sql) }, FIREBASE_PROJECT_ID: PROJECT, FIREBASE_API_KEY: "test-key", FIREBASE_AUTH_DOMAIN: "x", FIREBASE_APP_ID: "y" };
const callAs = async (pathAndQuery, tok, init = {}) => {
  const url = new URL(pathAndQuery, "https://example.pages.dev");
  const headers = { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) };
  const res = await onRequest({ request: new Request(url, { ...init, headers }), env: authEnv, params: { path: url.pathname.replace(/^\/api\//, "").split("/") } });
  return { status: res.status, body: await res.json() };
};
const post = obj => ({ method: "POST", body: JSON.stringify(obj) });

r = await callAs("/api/config");
assert.equal(r.body.firebase.projectId, PROJECT, "設定を返す");
assert.equal((await callAs("/api/auth/me")).status, 401, "トークンなし");
assert.equal((await callAs("/api/auth/me", await token({ aud: "other" }))).status, 401, "不正なトークン");
r = await callAs("/api/auth/me", good);
assert.equal(r.body.id, "user-1");
assert.equal(r.body.name, "テスト太郎");

r = await callAs("/api/favorites", good, post({ horseName: "オグリキャップ" }));
assert.deepEqual(r.body.favoriteHorses, ["オグリキャップ"], "追加");
r = await callAs("/api/favorites", good, post({ horseName: "オグリキャップ" }));
assert.deepEqual(r.body.favoriteHorses, [], "もう一度押すと解除");
assert.equal((await callAs("/api/favorites", good, post({ horseName: 123 }))).status, 400, "不正な値");

r = await callAs("/api/notes", good, post({ raceId: "arima-2026", note: "内枠有利" }));
assert.equal(r.body.notes["arima-2026"], "内枠有利");
r = await callAs("/api/notes", good, post({ raceId: "arima-2026", note: "" }));
assert.equal(r.body.notes["arima-2026"], undefined, "空にすると削除");

const sim = { courseId: "tokyo", course: "東京", distance: 2000, surface: "芝", result: [{ name: "A", num: 1, waku: 1, time: 120.5, margin: "" }, { name: "B", num: 2, waku: 2, time: 121, margin: "3" }] };
assert.equal((await callAs("/api/sims", good, post(sim))).status, 200);
assert.equal((await callAs("/api/sims", good, post({ ...sim, result: [] }))).status, 400, "結果が空");
r = await callAs("/api/sims", good);
assert.equal(r.body.length, 1);
assert.equal(r.body[0].result[0].name, "A");

// 別のユーザーからは見えない
const other2 = await token({ sub: "user-2" });
assert.deepEqual((await callAs("/api/sims", other2)).body, [], "他人の履歴は見えない");
assert.deepEqual((await callAs("/api/auth/me", other2)).body.favoriteHorses, []);

console.log("Pages Functions: すべて OK");
