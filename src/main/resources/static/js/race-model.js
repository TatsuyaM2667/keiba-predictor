// ==================================================================================
// 実際の出馬表 (JRA) から、モンテカルロ (Zig) に渡す値を作る予想モデル
// ==================================================================================
// 各馬の「平均的な出来」μ を、過去 4 走から次の式で作る (どれも説明できる単純な形):
//   1 走ごとの点   q = 着順の相対位置 (1 着 = 1、最下位 = 0) + 格の加点 − 0.04 × 勝ち馬とのタイム差 (秒)
//   近走の評価     form = Σ wₖ qₖ / Σ wₖ   (w = 0.4, 0.3, 0.2, 0.1。新しいレースほど重い)
//   距離・馬場     同じ馬場の過去走の平均距離から 400m 離れるごとに −0.02 (最大 −0.05)、
//                 同じ馬場を走ったことがなければ −0.03
//   μ = 1 + 0.25 × (form − 0.5) + 距離 + 馬場
// 脚質は過去走の 1 コーナー通過順位 ÷ 頭数 から推定する。
// 係数はすべて手で決めた値で、過去のレースで検証したものではない (ドキュメント「本物の予想へ」参照)。

export const STYLE_NAMES = ["逃げ", "先行", "差し", "追込"];
const W = [0.4, 0.3, 0.2, 0.1];
const CLASS_BONUS = { "GI": 0.12, "GII": 0.08, "GIII": 0.05, "L": 0.03, "J・GI": 0.05, "J・GII": 0.04, "J・GIII": 0.03 };

/** 1 頭分の特徴量 */
export function features(runner, race) {
  const runs = (runner.past || []).filter(p => p.place && p.field && p.field > 1).slice(0, 4);
  let sw = 0, s = 0;
  runs.forEach((p, k) => {
    const rel = 1 - (p.place - 1) / (p.field - 1);
    const behind = Math.max(0, p.diff ?? 0); // 勝ったレースは 2 着との差 (負) が入るので 0 とみなす
    s += W[k] * (rel + (CLASS_BONUS[p.grade] ?? 0) - 0.04 * Math.min(behind, 3));
    sw += W[k];
  });
  const form = sw ? s / sw : 0.4; // 過去走がない (新馬など) は平均より少し下と仮定
  const same = runs.filter(p => p.surface === race.surface && p.distance);
  let distFit = 0, surfFit = 0;
  if (same.length && race.distance) {
    const avg = same.reduce((a, p) => a + p.distance, 0) / same.length;
    distFit = -Math.min(0.05, (0.02 * Math.abs(race.distance - avg)) / 400);
  } else if (runs.length) surfFit = -0.03;
  const corners = runs.filter(p => p.corners?.length).map(p => p.corners[0] / p.field);
  const ratio = corners.length ? corners.reduce((a, b) => a + b, 0) / corners.length : null;
  const style = ratio == null ? 2 : ratio < 0.15 ? 0 : ratio < 0.4 ? 1 : ratio < 0.7 ? 2 : 3;
  return { form, distFit, surfFit, style, mu: 1 + 0.25 * (form - 0.5) + distFit + surfFit, runs: runs.length };
}

/** 逃げ・先行の頭数からペースを予想 (予想エンジン PredictorEngine.kt と同じ規則) */
export function paceOf(styles) {
  const nige = styles.filter(s => s === 0).length, senko = styles.filter(s => s === 1).length;
  if (nige >= 2 || (nige === 1 && senko >= 5)) return { value: 1.2, name: "ハイペース" };
  if (nige === 0 || (nige === 1 && senko <= 2)) return { value: 0.8, name: "スローペース" };
  return { value: 1.0, name: "ミドルペース" };
}

/** 単勝オッズ → 市場の予想確率 (逆数を合計で割って正規化。合計 1 にする) */
export function marketProbs(odds) {
  const inv = odds.map(o => (o > 0 ? 1 / o : 0));
  const sum = inv.reduce((a, b) => a + b, 0);
  return { probs: inv.map(v => (sum ? v / sum : 0)), takeout: sum ? 1 - 1 / sum : null };
}

/** 馬場の表記をそろえる (出馬表の見出しには「芝 内外」なども来る)。Kotlin の RaceFeatures.normSurface と同じ */
export const normSurface = (s) => (/ダート/.test(s || "") ? "ダート" : /障害/.test(s || "") ? "障害" : "芝");

// ==================================================================================
// 学習したモデル (Kotlin の ModelService が過去の実際のレースで最尤推定し、交差検証で選んだもの)
// ==================================================================================
//   勝率 pᵢ = exp(uᵢ) / Σⱼ exp(uⱼ)   (softmax。合計は必ず 1)
//   uᵢ = α · log(市場の確率 qᵢ) + Σₖ βₖ · (xᵢₖ − 平均ₖ) / 標準偏差ₖ
// 特徴量 x の並びと作り方は Kotlin (RaceFeatures.vector) と完全に同じ。一致は Kotlin のテストで確かめる。
// 交差検証で市場より良いモデルがなければ α = 1・β = 0 で、勝率 = 市場の確率になる。
export const featureVector = (f, pace, waku) => [f.form, f.distFit, f.surfFit < 0 ? 1 : 0, f.runs === 0 ? 1 : 0, (pace.value - 1) * (f.style - 1.5), waku ?? 4.5];
/** 学習したモデルの勝率。オッズがそろっていなければ null (呼び出し側は手動モデルを使う) */
export function fittedProbs(params, X, q) {
  if (!params || !q?.length || q.some((v) => !(v > 0))) return null;
  const u = X.map((x, i) => params.alpha * Math.log(q[i]) + x.reduce((s, v, j) => s + (params.beta[j] * (v - params.mean[j])) / params.sd[j], 0));
  const m = Math.max(...u), e = u.map((v) => Math.exp(v - m)), s = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / s);
}

/**
 * 勝率 p のモデル (softmax = Plackett–Luce モデル) で、1〜3 着を runs 回くじ引きする。
 * 各馬に「log pᵢ + Gumbel 分布の乱数」を付けて大きい順に並べると、1 着になる確率がちょうど pᵢ になり、
 * 2 着・3 着も同じモデル (Harville の式) どおりになる (Gumbel-max の性質)。戻り値の形は simulateOrders と同じ。
 */
export function sampleOrders(p, runs = 20000, seed = 20261109) {
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return (s + 0.5) / 4294967296; }; // 0 と 1 を含まない
  const lp = p.map((v) => Math.log(Math.max(v, 1e-12)));
  const out = new Uint8Array(runs * 3);
  for (let k = 0; k < runs; k++) {
    let a = -1, b = -1, c = -1, sa = -Infinity, sb = -Infinity, sc = -Infinity;
    for (let i = 0; i < lp.length; i++) {
      const v = lp[i] - Math.log(-Math.log(rnd()));
      if (v > sa) { c = b; sc = sb; b = a; sb = sa; a = i; sa = v; }
      else if (v > sb) { c = b; sc = sb; b = i; sb = v; }
      else if (v > sc) { c = i; sc = v; }
    }
    out[k * 3] = a; out[k * 3 + 1] = b; out[k * 3 + 2] = c;
  }
  return out;
}

/** ケリー基準で賭ける割合。期待値 pO ≤ 1 なら 0 (賭けない)。fraction は安全のための割引 */
export const kelly = (p, odds, fraction = 0.25) => (odds > 1 && p * odds > 1 ? fraction * (p * odds - 1) / (odds - 1) : 0);

/** 毛色の略称 (出馬表の「鹿」など) → アプリの毛色名 */
export function coatName(c) {
  return { "鹿": "鹿毛", "栗": "栗毛", "栃栗": "栃栗毛", "黒鹿": "黒鹿毛", "青鹿": "青鹿毛", "青": "青毛", "芦": "芦毛", "白": "白毛" }[c] || "鹿毛";
}

// ==================================================================================
// 馬券の種類と、組み合わせの確率 (予想の見解・3D の予想ゲーム・予想の成績で使う)
// ==================================================================================
// takeout は JRA の控除率 (売上のうち払い戻しに回らない割合)。picks は選ぶ頭数、ordered は着順どおりか。
export const BET_TYPES = [
  { key: "win", name: "単勝", picks: 1, ordered: false, takeout: 0.2, rule: "1着の馬を当てる" },
  { key: "place", name: "複勝", picks: 1, ordered: false, takeout: 0.2, rule: "3着までに入る馬を当てる (7頭以下は2着まで)" },
  { key: "umaren", name: "馬連", picks: 2, ordered: false, takeout: 0.225, rule: "1着・2着の2頭を当てる (順番は問わない)" },
  { key: "wide", name: "ワイド", picks: 2, ordered: false, takeout: 0.225, rule: "3着までに入る2頭を当てる" },
  { key: "umatan", name: "馬単", picks: 2, ordered: true, takeout: 0.25, rule: "1着・2着を順番どおりに当てる" },
  { key: "trio", name: "3連複", picks: 3, ordered: false, takeout: 0.25, rule: "1〜3着の3頭を当てる (順番は問わない)" },
  { key: "tierce", name: "3連単", picks: 3, ordered: true, takeout: 0.275, rule: "1〜3着を順番どおりに当てる" },
];
export const BET = Object.fromEntries(BET_TYPES.map((b) => [b.key, b]));

/**
 * 同じレースを runs 回走らせ、毎回の 1〜3 着 (出走表の何番目か) を記録する。
 * Zig の race_once (1 回分の出来を計算) を繰り返し呼ぶ。事前に set_horse で全馬を登録しておくこと。
 * 毎回の seed は、番号に黄金比の定数を掛けてばらけさせる (近い seed から似た乱数が出ないように)。
 */
export function simulateOrders(z, n, pace, runs = 20000, seed = 20261109) {
  const out = new Uint8Array(runs * 3);
  for (let k = 0; k < runs; k++) {
    z.race_once(n, pace, (Math.imul(k + 1, 0x9e3779b1) ^ seed) >>> 0 || 1);
    let a = -1, b = -1, c = -1, sa = -1e9, sb = -1e9, sc = -1e9;
    for (let i = 0; i < n; i++) {
      const s = z.race_score(i);
      if (s > sa) { c = b; sc = sb; b = a; sb = sa; a = i; sa = s; }
      else if (s > sb) { c = b; sc = sb; b = i; sb = s; }
      else if (s > sc) { c = i; sc = s; }
    }
    out[k * 3] = a; out[k * 3 + 1] = b; out[k * 3 + 2] = c;
  }
  return out;
}

/** 実際の 1〜3 着 (出走表の何番目か) で、その馬券が当たりかどうか。n は出走頭数 (複勝の範囲に使う) */
export function hits(type, picks, top3, n) {
  const [a, b, c] = top3;
  const inTop3 = (i) => i === a || i === b || i === c;
  switch (type) {
    case "win": return picks[0] === a;
    case "place": return n <= 7 ? picks[0] === a || picks[0] === b : inTop3(picks[0]);
    case "umaren": return (picks[0] === a && picks[1] === b) || (picks[0] === b && picks[1] === a);
    case "wide": return inTop3(picks[0]) && inTop3(picks[1]) && picks[0] !== picks[1];
    case "umatan": return picks[0] === a && picks[1] === b;
    case "trio": return picks.every(inTop3) && new Set(picks).size === 3;
    case "tierce": return picks[0] === a && picks[1] === b && picks[2] === c;
  }
  return false;
}

/** シミュレーションの記録から、その馬券が当たる確率 (当たった回数 ÷ 回数) */
export function probOf(orders, n, type, picks) {
  const runs = orders.length / 3;
  let hit = 0;
  for (let k = 0; k < runs; k++) if (hits(type, picks, orders.subarray(k * 3, k * 3 + 3), n)) hit++;
  return hit / runs;
}

/** 確率 → オッズ。控除率を引いた残りを当たった人で分ける (パリミュチュエル方式) と、オッズ = (1 − 控除率) ÷ 確率 */
export function oddsFrom(p, takeout) {
  if (!(p > 0)) return 9999.9;
  return Math.min(9999.9, Math.max(1.0, Math.floor(((1 - takeout) / p) * 10) / 10));
}

/**
 * 市場 (単勝オッズ) から、組み合わせ馬券の市場の確率を推定する (Harville の公式)。
 * 1 着 i・2 着 j の確率 = qᵢ × qⱼ / (1 − qᵢ)。単勝以外のオッズは取り込んでいないので、その推定に使う。
 */
export function harville(q, type, picks) {
  const n = q.length;
  const ex = (i, j) => (i === j ? 0 : (q[i] * q[j]) / Math.max(1e-9, 1 - q[i]));
  const tri = (i, j, k) => (i === j || j === k || i === k ? 0 : ex(i, j) * (q[k] / Math.max(1e-9, 1 - q[i] - q[j])));
  const perms = (x, y, z) => tri(x, y, z) + tri(x, z, y) + tri(y, x, z) + tri(y, z, x) + tri(z, x, y) + tri(z, y, x);
  const [a, b, c] = picks;
  switch (type) {
    case "win": return q[a];
    case "umaren": return ex(a, b) + ex(b, a);
    case "umatan": return ex(a, b);
    case "trio": return perms(a, b, c);
    case "tierce": return tri(a, b, c);
    case "place": case "wide": {
      let s = 0;
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) {
        const t = tri(i, j, k);
        if (t && hits(type, picks, [i, j, k], n)) s += t;
      }
      return s;
    }
  }
  return 0;
}

/**
 * 買い方の比較。印 (勝率の高い順の出走表の番号 order) から、代表的な 7 つの買い方を作り、
 *   的中率 … シミュレーションで、どれか 1 点でも当たる割合
 *   回収率 … 1 点 100 円ずつ買ったときに戻ってくる額の期待値 ÷ 投資額 (1 を超えれば得)
 * を計算する。単勝は本物のオッズ、それ以外は市場の確率 (Harville) から推定したオッズを使う。
 */
export function strategies(orders, n, order, q, winOdds) {
  const plans = planTickets(order).filter((p) => p.tickets.every(([, picks]) => picks.every((i) => i < n)));
  const runs = orders.length / 3;
  return plans.map((p) => {
    const tickets = p.tickets.map(([type, picks]) => ({
      type, picks,
      odds: type === "win" && winOdds[picks[0]] ? winOdds[picks[0]] : oddsFrom(harville(q, type, picks), BET[type].takeout),
      estimated: !(type === "win" && winOdds[picks[0]]),
    }));
    let anyHit = 0, back = 0;
    for (let k = 0; k < runs; k++) {
      const top3 = orders.subarray(k * 3, k * 3 + 3);
      let hit = false;
      for (const t of tickets) if (hits(t.type, t.picks, top3, n)) { hit = true; back += t.odds; }
      if (hit) anyHit++;
    }
    return { ...p, tickets, points: tickets.length, hitRate: anyHit / runs, returnRate: back / runs / tickets.length };
  });
}

/**
 * 予想の見解 (なぜその馬を推すか) を、特徴量・勝率・市場の確率から組み立てる。
 * horses[i] = { name, odds, popularity }、f[i] = features() の戻り値、p / q = 予想と市場の勝率 (0〜1)。
 */
export function commentary({ horses, f, p, q, pace, race, pModel = null }) {
  const n = horses.length;
  const rank = (arr, i) => 1 + arr.filter((v) => v > arr[i]).length;
  const forms = f.map((v) => v.form);
  const order = p.map((_, i) => i).sort((i, j) => p[j] - p[i]);
  const nige = f.filter((v) => v.style === 0).length, senko = f.filter((v) => v.style === 1).length;
  const favored = pace.value > 1 ? [2, 3] : pace.value < 1 ? [0, 1] : [];
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const reasons = (i) => {
    const r = [], v = f[i], last = horses[i].past?.[0];
    r.push(`近 4 走の評価 ${v.form.toFixed(2)} は出走馬中 ${rank(forms, i)} 位${last?.place ? ` (前走 ${last.grade ? `${last.grade} ` : ""}${last.place}着/${last.field}頭)` : ""}`);
    if (v.runs === 0) r.push("過去の出走がなく、力が未知数");
    if (v.surfFit < 0) r.push(`${race.surface}を走るのは初めて`);
    else if (v.distFit <= -0.03) r.push(`今回の ${race.distance}m は経験してきた距離と差がある`);
    else if (v.runs) r.push("距離・馬場の経験は十分");
    if (favored.includes(v.style)) r.push(`${STYLE_NAMES[v.style]}の馬で、${pace.name}なら展開が向く`);
    else if (favored.length) r.push(`${STYLE_NAMES[v.style]}の馬で、${pace.name}の展開は向かない`);
    // pModel があるとき: 表示の勝率は市場をもとにした採用モデルなので、市場との比較は「能力モデルの意見」として書く
    const pm = pModel ?? p, who = pModel ? "能力モデル (手動) の勝率" : "予想勝率";
    if (q[i]) {
      const ratio = pm[i] / q[i];
      if (ratio >= 1.25) r.push(`${who} ${pct(pm[i])} は市場 (${pct(q[i])}) より高い${pModel ? "" : `。オッズ ${horses[i].odds}倍は割安`}`);
      else if (ratio <= 0.8) r.push(`${who} ${pct(pm[i])} は市場 (${pct(q[i])}) より低い`);
      else r.push(`${who} ${pct(pm[i])} は市場 (${pct(q[i])}) とほぼ同じ`);
    }
    return r;
  };
  const marks = ["◎", "◯", "▲", "△", "△"];
  return {
    pace: `逃げ ${nige} 頭・先行 ${senko} 頭で${pace.name}の予想。${favored.length ? `${favored.map((s) => STYLE_NAMES[s]).join("・")}の馬に有利な流れ` : "脚質による有利不利は小さい"}です。`,
    picks: order.slice(0, Math.min(5, n)).map((i, k) => ({ index: i, mark: marks[k], reasons: reasons(i) })),
    // 人気 (3 番人気以内) なのに、予想勝率が市場の 7 割に届かない馬
    danger: horses.map((h, i) => i).filter((i) => horses[i].popularity && horses[i].popularity <= 3 && q[i] && (pModel ?? p)[i] / q[i] < 0.7)
      .map((i) => ({ index: i, text: `${horses[i].popularity}番人気ですが、${pModel ? "能力モデル (手動) の勝率" : "予想勝率"} ${pct((pModel ?? p)[i])} は市場 ${pct(q[i])} を大きく下回ります` })),
  };
}

/**
 * 出馬表 → 各馬の勝率 (0〜1)。レース予想と「予想の成績」の答え合わせで同じ計算を使う。
 * runners は取消・除外を除いた出走馬、cond = { surface, distance }。Zig は 18 頭まで。
 */
export function modelProbs(z, runners, cond, runs = 100000, seed = 20261109) {
  const f = runners.map((x) => features(x, cond));
  const pace = paceOf(f.map((v) => v.style));
  const n = Math.min(18, runners.length);
  let p = runners.map(() => 1 / runners.length); // Zig が読めないときは全馬同じ
  if (z) {
    f.slice(0, n).forEach((v, i) => z.set_horse(i, Math.round(v.mu * 1000) / 10, 0.7, v.style));
    z.simulate(n, runs, pace.value, seed);
    p = runners.map((_, i) => (i < n ? z.win_rate(i) / 100 : 0));
  }
  return { f, pace, p };
}

/** 印の順 (勝率の高い順の出走表の番号) → 7 つの代表的な買い方の買い目 */
export function planTickets(order) {
  const [A, B, C, D] = order;
  return [
    { name: "単勝 ◎", style: "堅実", tickets: [["win", [A]]] },
    { name: "複勝 ◎", style: "堅実", tickets: [["place", [A]]] },
    { name: "ワイド ◎-◯", style: "堅実", tickets: [["wide", [A, B]]] },
    { name: "馬連 ◎→◯▲△", style: "バランス", tickets: [B, C, D].map((x) => ["umaren", [A, x]]) },
    { name: "馬単 ◎→◯▲△", style: "バランス", tickets: [B, C, D].map((x) => ["umatan", [A, x]]) },
    { name: "3連複 ◎◯▲△ ボックス", style: "高配当", tickets: [[A, B, C], [A, B, D], [A, C, D], [B, C, D]].map((t) => ["trio", t]) },
    { name: "3連単 ◎ 1着固定 → ◯▲△", style: "高配当", tickets: [[B, C], [B, D], [C, B], [C, D], [D, B], [D, C]].map(([x, y]) => ["tierce", [A, x, y]]) },
  ].filter((p) => p.tickets.every(([, picks]) => picks.every((i) => i != null)));
}

