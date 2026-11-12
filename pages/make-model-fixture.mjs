// Kotlin のテスト (ModelServiceTest) 用の固定データを作る: node make-model-fixture.mjs results.json
// 画面の race-model.js で特徴量と勝率を計算し、その値を書いておく。Kotlin が同じ値を出せば、2 つの実装は一致している。
// 馬名は消す (テストに不要)。入力の results.json は /api/live/results の中身。
import { readFile, writeFile } from "node:fs/promises";
import { features, paceOf, featureVector, fittedProbs, normSurface } from "../src/main/resources/static/js/race-model.js";

// 出馬表に、結果に載っている馬 (取消・除外を除く) が全部そろっているレースだけを使う (Kotlin の ModelService.isComplete と同じ)
const complete = (r) => {
  const onCard = new Set(r.card.runners.map((x) => x.num));
  return r.result.order.filter((o) => o.num && !/取消|除外/.test(o.status)).every((o) => onCard.has(o.num));
};
const data = JSON.parse(await readFile(process.argv[2], "utf8")).filter(complete);
// 確かめたい場合を含むレースを選ぶ: 新馬 (過去走なし)・障害・ダート・多頭数
const pick = [
  data.find((r) => r.card.runners.some((x) => !x.past.length)),
  data.find((r) => /障害/.test(r.card.header.surface)),
  data.find((r) => r.card.header.surface === "ダート"),
  data.find((r) => r.card.runners.length >= 16),
].filter(Boolean);
// わざと 0 でない係数で、特徴量の部分の計算も確かめる
const params = { alpha: 0.9, mean: [0.5, -0.01, 0.2, 0.05, 0, 4.5], sd: [0.2, 0.01, 0.4, 0.2, 0.2, 2.3], beta: [0.6, 0.2, -0.3, -0.5, 0.4, -0.1] };
const races = pick.map((r) => {
  const out = new Set(r.result.order.filter((o) => /取消|除外/.test(o.status)).map((o) => o.num));
  const run = r.card.runners.filter((x) => !x.scratched && x.num && !out.has(x.num) && x.odds > 0);
  const cond = { surface: normSurface(r.card.header.surface), distance: r.card.header.distance };
  const f = run.map((x) => features(x, cond));
  const pace = paceOf(f.map((v) => v.style));
  const X = f.map((v, i) => featureVector(v, pace, run[i].waku));
  const inv = run.map((x) => 1 / x.odds), s = inv.reduce((a, b) => a + b, 0);
  const q = inv.map((v) => v / s);
  return {
    race: { ...r, card: { ...r.card, runners: r.card.runners.map((x) => ({ ...x, name: "" })) }, result: { order: r.result.order.map(({ place, status, num }) => ({ place, status, num })) } },
    expected: { pace: pace.value, styles: f.map((v) => v.style), X, q, p: fittedProbs(params, X, q) },
  };
});
await writeFile(new URL("../src/test/resources/model-fixture.json", import.meta.url), JSON.stringify({ params, races }, null, 1));
console.log(`${races.length} レースを書きました (${races.map((r) => `${r.race.card.header.surface}${r.race.card.header.distance}m ${r.expected.X.length}頭`).join(" / ")})`);
