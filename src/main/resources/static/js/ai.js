// ==================================================================================
// ai.js — AI 予想 (Gemini / Claude) の画面
// ==================================================================================
// 流れ: レース情報を入力 → 使う AI ごとに /api/ai/predict/{gemini|claude} を同時に呼ぶ
//       → 届いた順に表示 → 全部そろったら 2 つの勝率を平均して「総合予想」を作り、履歴に保存する。
// API キーはサーバー (Kotlin) 側だけが持ち、この画面には届かない。
// main.js から initAi({ state, openHorse, sendToSim }) で 1 回だけ呼ばれる。
//
// 【安全のための決まり】AI の回答は外から来た文字列なので、HTML に入れるときは必ず esc() を通す。
import { $, $$, esc, icon, api, toast, debounce } from "./util.js";
import { coatName } from "./race-model.js";

const PROVIDERS = [["gemini", "Gemini"], ["claude", "Claude"]];
const NAME = Object.fromEntries(PROVIDERS);
const FORM_KEY = "kv-ai-form";
const MARK_COLOR = { "◎": "var(--danger)", "○": "var(--g1)", "◯": "var(--g1)", "▲": "var(--warn)", "☆": "var(--accent)" };

const ai = {
  settings: null,   // /api/ai/settings (キーの有無とモデル名。キーそのものは来ない)
  results: {},      // provider → AiResult
  pending: new Set(),
  tab: "total",
  entry: null,      // 表示中の予想 (履歴 1 件分)
  history: [],
  races: new Map(), // 競走名 → 競走一覧のデータ (入力補助)
  live: [],         // JRA の今週のレース一覧 (/api/live/races)
  card: null,       // 読み込んだ JRA の出馬表 { names: 出走馬名, coats: 馬名 → 毛色 }
  running: false,
};
// JRA の出馬表から作ったテキストの 1 行目。これで始まっている間は「出馬表を読み込んだ状態」とみなす
const CARD_MARK = "JRA 公式の出馬表";
let ctx;

export async function initAi(context) {
  ctx = context;
  $("#ai-venue").insertAdjacentHTML("beforeend", ctx.state.courses.map(c => `<option>${esc(c.short)}</option>`).join(""));
  $("#ai-date").value = today();
  const restored = restoreForm();

  $("#ai-run").addEventListener("click", run);
  $$("#ai-tabs button").forEach(b => b.addEventListener("click", () => { ai.tab = b.dataset.aiTab; render(); }));
  $("#ai-to-sim").addEventListener("click", toSim);
  $("#ai-name").addEventListener("change", fillFromCatalog);
  $("#ai-name").addEventListener("input", debounce(fillFromCatalog, 300));
  $("#ai-entries").addEventListener("input", debounce(lookup, 500));
  $(".ai-form").addEventListener("input", debounce(saveForm, 400));
  $(".ai-form").addEventListener("change", saveForm);
  $("#ai-settings-open").addEventListener("click", openSettings);
  $("#ai-dialog").addEventListener("close", closeSettings);
  $$("#ai-dialog [data-models]").forEach(b => b.addEventListener("click", () => fetchModels(b.dataset.models)));
  $("#ai-actual-dialog").addEventListener("close", saveActual);
  // <form method="dialog"> で Enter を押すと「最初のボタン」(キャンセル / キーを消す) が押されたことになるので、
  // 入力欄での Enter は「保存」として扱う。
  [$("#ai-dialog"), $("#ai-actual-dialog")].forEach(d => d.addEventListener("keydown", e => {
    if (e.key === "Enter" && e.target.matches("input") && !e.isComposing) { e.preventDefault(); d.close("save"); }
  }));

  try {
    ai.settings = await api("/api/ai/settings");
  } catch (_) {
    // Cloudflare Pages 版 (404) や、別の端末から開いた場合 (403) は使えない
    $("#ai-unavailable").hidden = false;
    $("#ai-run").disabled = true;
    $("#ai-settings-open").disabled = true;
    return;
  }
  if (!restored) {
    $("#ai-use-gemini").checked = ai.settings.gemini.configured || !ai.settings.claude.configured;
    $("#ai-use-claude").checked = ai.settings.claude.configured;
  }
  renderKeyStatus();
  render();
  lookup();
  loadCatalog();
  loadHistory();
  loadLive();
}

/* ---------------- JRA の出馬表から選ぶ ---------------- */
// レース予想と同じ自動取得のデータ (/api/live/*) を使う。出馬表がない日 (月〜木曜など) や
// オフラインのときは何も出さず、これまでどおり貼り付けで使う。
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const mdw = (iso) => {
  const d = new Date(`${iso}T00:00:00+09:00`);
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEK[d.getDay()]})`;
};

async function loadLive() {
  const live = await api("/api/live/races").catch(() => null);
  if (!live?.races?.length) return;
  ai.live = live.races;
  $("#ai-live").hidden = false;
  const dates = [...new Set(ai.live.map((r) => r.date))].sort();
  $("#ai-live-date").innerHTML = dates.map((d) => `<option value="${esc(d)}">${mdw(d)}</option>`).join("");
  $("#ai-live-date").addEventListener("change", fillLiveVenues);
  $("#ai-live-venue").addEventListener("change", fillLiveRaces);
  $("#ai-live-race").addEventListener("change", () => $("#ai-live-race").value && loadCard($("#ai-live-race").value));
  fillLiveVenues();
}
function fillLiveVenues() {
  const day = ai.live.filter((r) => r.date === $("#ai-live-date").value);
  const venues = [...new Map(day.map((r) => [r.venue, r.venueName])).entries()];
  $("#ai-live-venue").innerHTML = venues.map(([v, n]) => `<option value="${esc(v)}">${esc(n)}</option>`).join("");
  fillLiveRaces();
}
function fillLiveRaces() {
  const list = ai.live
    .filter((r) => r.date === $("#ai-live-date").value && r.venue === $("#ai-live-venue").value)
    .sort((a, b) => a.race_no - b.race_no);
  $("#ai-live-race").innerHTML =
    `<option value="">レースを選ぶ</option>` +
    list.map((r) => `<option value="${esc(r.id)}">${r.race_no}R ${esc(r.post_time || "")} ${esc(r.name)}${r.grade ? ` (${esc(r.grade)})` : ""}</option>`).join("");
}

// 1 レースの出馬表を読み込み、レース情報と「出走馬・メモ」を埋める (取消の馬も、取消と分かるように残す)
async function loadCard(id) {
  let r;
  try {
    r = await api(`/api/live/race?id=${encodeURIComponent(id)}`);
  } catch (_) {
    toast("出馬表を読み込めませんでした");
    return;
  }
  const hd = r.card?.header || {};
  const runners = r.card?.runners || [];
  if (!runners.length) {
    toast("このレースの出馬表はまだ発表されていません");
    return;
  }
  const surface = hd.surface || r.surface || "";
  fillForm({
    name: hd.name || r.name,
    date: r.date,
    venue: r.venueName,
    surface: surface.includes("ダ") ? "ダート" : surface.includes("芝") ? "芝" : "",
    distance: hd.distance || r.distance,
    going: $("#ai-going").value,
    entries: cardText(r, hd, runners),
  });
  ai.card = {
    names: runners.filter((x) => !x.scratched).map((x) => x.name),
    coats: new Map(runners.map((x) => [norm(x.name), coatName(x.color)])),
  };
  saveForm();
  lookup();
  toast(`${hd.name || r.name} の出馬表を読み込みました (${ai.card.names.length}頭)`);
}

// 出馬表 → AI に渡すテキスト。オッズ・人気・馬体重・血統と、近 4 走 (着順・人気・タイム・上がり・通過順) を 1 頭ずつ書く
function cardText(r, hd, runners) {
  const at = r.card_at ? `${new Date(+r.card_at).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 時点` : "";
  const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
  const lines = [
    `${CARD_MARK} (${at})`,
    [`${r.venueName} ${r.race_no}R`, hd.name || r.name, hd.grade || r.grade, `${hd.surface || r.surface || ""}${hd.distance || r.distance || ""}m`, hd.turn, hd.postTime || r.post_time ? `発走 ${hd.postTime || r.post_time}` : "", hd.cond || r.cond].filter(Boolean).join(" "),
    "",
  ];
  for (const x of runners) {
    const head = [
      `${x.waku ?? "-"}枠${x.num ?? "-"}番 ${x.name}`,
      x.sexAge,
      x.carry != null ? `${x.carry}kg` : "",
      x.jockey ? `騎手 ${x.jockey}` : "",
      x.trainer ? `調教師 ${x.trainer}${x.division ? ` (${x.division})` : ""}` : "",
      x.bodyWeight ? `馬体重 ${x.bodyWeight}${x.weightDiff != null ? `(${sign(x.weightDiff)})` : ""}` : "",
      x.odds != null ? `単勝 ${x.odds}倍${x.pop ? ` ${x.pop}番人気` : ""}` : "",
      [x.sire && `父 ${x.sire}`, x.dam && `母 ${x.dam}`, x.damSire && `母父 ${x.damSire}`].filter(Boolean).join(" / "),
    ].filter(Boolean);
    lines.push(head.join(" ・ ") + (x.scratched ? " 【出走取消】" : ""));
    for (const p of (x.past || []).slice(0, 4)) {
      lines.push(
        "  近走: " +
          [
            p.date,
            p.course,
            `${p.race}${p.grade ? `(${p.grade})` : ""}`,
            `${p.surface || ""}${p.distance ?? ""}m ${p.cond || ""}`.trim(),
            `${p.place ?? "-"}着/${p.field ?? "-"}頭`,
            p.pop ? `${p.pop}番人気` : "",
            p.time,
            p.f3 ? `上がり${p.f3}` : "",
            p.corners?.length ? `通過${p.corners.join("-")}` : "",
            p.diff != null ? `着差${p.diff}` : "",
          ].filter(Boolean).join(" "),
      );
    }
  }
  return lines.join("\n");
}

// いま「出走馬・メモ」が読み込んだ出馬表のままなら、その出走馬名 (名鑑の照合に使う)
const cardNames = () => ($("#ai-entries").value.startsWith(CARD_MARK) ? ai.card?.names || [] : []);

const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/* ---------------- 入力 ---------------- */
function readForm() {
  return {
    name: $("#ai-name").value.trim(),
    date: $("#ai-date").value,
    venue: $("#ai-venue").value,
    surface: $("#ai-surface").value,
    distance: +$("#ai-distance").value || null,
    going: $("#ai-going").value,
    entries: $("#ai-entries").value,
    webSearch: $("#ai-web").checked,
    test: $("#ai-test").checked,
  };
}
function fillForm(r) {
  $("#ai-name").value = r.name || "";
  if (r.date) $("#ai-date").value = r.date;
  $("#ai-venue").value = r.venue || "";
  $("#ai-surface").value = r.surface || "";
  $("#ai-distance").value = r.distance || "";
  $("#ai-going").value = r.going || "";
  $("#ai-entries").value = r.entries || "";
}
// 入力途中の内容は、このブラウザに覚えておく (開き直しても消えないように)。開催日は毎回「今日」から。
function saveForm() {
  const f = readForm();
  delete f.date;
  f.useGemini = $("#ai-use-gemini").checked;
  f.useClaude = $("#ai-use-claude").checked;
  try { localStorage.setItem(FORM_KEY, JSON.stringify(f)); } catch (_) {}
}
function restoreForm() {
  let f = null;
  try { f = JSON.parse(localStorage.getItem(FORM_KEY) || "null"); } catch (_) {}
  if (!f) return false;
  fillForm(f);
  $("#ai-web").checked = f.webSearch !== false;
  $("#ai-test").checked = !!f.test;
  $("#ai-use-gemini").checked = f.useGemini !== false;
  $("#ai-use-claude").checked = !!f.useClaude;
  return true;
}

// 競走一覧 (Wikipedia の 726 競走) を入力候補にし、選んだら競馬場・コース・距離を自動で入れる。
// 候補には記事名 (例: 「ジャパンカップ」) を出し、表示名 (「ジャパンカップ（国際招待）」) でも引けるようにする。
// 一覧 API は 1 回 500 件までなので、2 回に分けて取る。
async function loadCatalog() {
  try {
    const pages = await Promise.all([0, 500].map(o => api(`/api/catalog/races?limit=500&offset=${o}`)));
    pages.flatMap(p => p.items).forEach(r => {
      [r.title, r.name, r.name.replace(/[（(].*$/, "")].forEach(k => { if (k && !ai.races.has(k.trim())) ai.races.set(k.trim(), r); });
    });
    const titles = [...new Set(pages.flatMap(p => p.items).map(r => r.title))];
    $("#ai-race-list").innerHTML = titles.map(n => `<option value="${esc(n)}">`).join("");
  } catch (_) {}
}
function fillFromCatalog() {
  const r = ai.races.get($("#ai-name").value.trim());
  if (!r) return;
  const venue = (r.course || "").replace(/競馬場.*/, "");
  if ([...$("#ai-venue").options].some(o => o.value === venue)) $("#ai-venue").value = venue;
  if (r.surface?.includes("芝")) $("#ai-surface").value = "芝";
  else if (r.surface?.includes("ダート")) $("#ai-surface").value = "ダート";
  if (r.distance) $("#ai-distance").value = r.distance;
  saveForm();
}

// 貼り付けた出馬表の中から名鑑にいる馬を探して、チップで見せる (押すと詳細が開く)
async function lookup() {
  const text = $("#ai-entries").value;
  const box = $("#ai-matches");
  if (!ai.settings || text.trim().length < 3) { box.innerHTML = ""; return; }
  try {
    const list = await api("/api/ai/lookup", { method: "POST", body: JSON.stringify({ text, names: cardNames() }) });
    box.innerHTML = list.length
      ? `<span class="muted" style="font-size:12px;align-self:center">名鑑で見つかった馬 ${list.length}頭 (AI に戦績・血統を渡します):</span>` +
        list.map(m => `<button class="chip" type="button" data-lib="${esc(m.title)}" title="能力値 ${m.rating}">${esc(m.name)}<b>${m.rating}</b></button>`).join("")
      : "";
    $$("[data-lib]", box).forEach(b => b.addEventListener("click", () => ctx.openHorse(b.dataset.lib)));
  } catch (_) { box.innerHTML = ""; }
}

function renderKeyStatus() {
  const s = ai.settings;
  if (!s) return;
  const one = (id) => {
    const p = s[id];
    return `${NAME[id]}: ${p.configured ? `設定済み (${esc(p.keyHint)}${p.fromEnv ? "・環境変数" : ""}) ・ ${esc(p.model)}` : "未設定"}`;
  };
  $("#ai-key-status").innerHTML = `${one("gemini")}<br>${one("claude")}`;
}

/* ---------------- 実行 ---------------- */
async function run() {
  if (ai.running) return;
  const input = { ...readForm(), runnerNames: cardNames() };
  if (!input.name && !input.entries.trim()) { toast("レース名か出走馬を入力してください"); return; }
  const use = PROVIDERS.map(([id]) => id).filter(id => $(`#ai-use-${id}`).checked);
  if (!use.length) { toast("使う AI を1つ以上選んでください"); return; }
  const missing = input.test ? [] : use.filter(id => !ai.settings[id].configured);
  if (missing.length) {
    toast(`${missing.map(id => NAME[id]).join("・")} の API キーが未設定です`);
    openSettings();
    return;
  }

  ai.running = true;
  ai.results = {};
  ai.pending = new Set(use);
  ai.tab = "total";
  ai.entry = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: new Date().toISOString(), race: input, test: input.test, results: {}, consensus: [], actual: [] };
  $("#ai-run").disabled = true;
  const started = Date.now();
  const tick = () => {
    const names = [...ai.pending].map(id => NAME[id]).join("・");
    $("#ai-status").textContent = `${names} が予想中… ${Math.round((Date.now() - started) / 1000)}秒${input.webSearch && !input.test ? " (Web 検索ありだと1〜3分かかります)" : ""}`;
  };
  tick();
  const timer = setInterval(tick, 1000);
  render();

  await Promise.all(use.map(async id => {
    let r;
    try {
      r = await api(`/api/ai/predict/${id}`, { method: "POST", body: JSON.stringify(input) });
    } catch (e) {
      r = { provider: id, model: "", ok: false, error: `アプリのサーバーに接続できませんでした (${e.message})` };
    }
    ai.results[id] = r;
    ai.pending.delete(id);
    if (ai.pending.size) tick();
    render();
  }));

  clearInterval(timer);
  ai.running = false;
  $("#ai-run").disabled = false;
  const cons = consensus(ai.results);
  Object.assign(ai.entry, { results: ai.results, consensus: cons });
  if (cons.length) {
    $("#ai-status").textContent = `完了！ 総合の本命は ◎${label(cons[0])} です (履歴に保存しました)。`;
    try { await api("/api/ai/history", { method: "POST", body: JSON.stringify(ai.entry) }); } catch (_) { toast("履歴に保存できませんでした"); }
    loadHistory();
  } else {
    $("#ai-status").textContent = "予想を取得できませんでした。各 AI のタブでエラーの内容を確認してください。";
    ai.tab = use[0];
  }
  render();
}

/* ---------------- 総合予想 ---------------- */
const norm = s => (s || "").normalize("NFKC").replace(/\s/g, "").toLowerCase();
function sameHorse(a, b) {
  const x = norm(a.horse), y = norm(b.horse);
  if (x && y && x === y) return true;
  return a.number != null && a.number === b.number && (!x || !y);
}
// 予想できた AI の勝率を平均する (ある AI が挙げていない馬は、その AI では 0%)
function consensus(results) {
  const ok = Object.entries(results).filter(([, r]) => r?.ok && r.predictions?.length);
  const rows = [];
  for (const [id, r] of ok) {
    for (const p of r.predictions) {
      let row = rows.find(x => sameHorse(x, p));
      if (!row) rows.push(row = { number: p.number ?? null, horse: p.horse, libraryTitle: p.libraryTitle ?? null, probs: {}, marks: {} });
      row.number ??= p.number ?? null;
      row.libraryTitle ??= p.libraryTitle ?? null;
      row.probs[id] = p.winProb;
      row.marks[id] = p.mark;
    }
  }
  const n = Math.max(1, ok.length);
  rows.forEach(r => (r.winProb = Object.values(r.probs).reduce((a, b) => a + b, 0) / n));
  rows.sort((a, b) => b.winProb - a.winProb);
  rows.forEach((r, i) => (r.mark = ["◎", "○", "▲", "△", "△"][i] || ""));
  return rows;
}
const topPick = preds => preds?.find(p => p.mark === "◎") || preds?.[0] || null;
const label = p => (p.number != null ? `${p.number} ${p.horse}` : p.horse);
const pct = v => `${(+v || 0).toFixed(1)}%`;

/* ---------------- 表示 ---------------- */
function render() {
  $$("#ai-tabs button").forEach(b => b.classList.toggle("on", b.dataset.aiTab === ai.tab));
  const race = ai.entry?.race;
  $("#ai-result-title").textContent = race ? `予想 ・ ${race.name || "レース名なし"}` : "予想";
  $("#ai-out").innerHTML = ai.tab === "total" ? renderTotal() : renderProvider(ai.tab);
  $$("#ai-out [data-lib]").forEach(b => b.addEventListener("click", () => ctx.openHorse(b.dataset.lib)));
  $("#ai-to-sim").disabled = !simPicks().length;
}

const libBtn = t => (t ? `<button class="lib" type="button" data-lib="${esc(t)}">名鑑</button>` : "");
const probCell = (v, max) => `<div class="prob"><div class="bar"><i style="width:${Math.min(100, (v / Math.max(max, 1)) * 100)}%"></i></div><span>${pct(v)}</span></div>`;
const markCell = m => `<td class="mark" style="color:${MARK_COLOR[m] || "var(--ink-3)"}">${esc(m || "")}</td>`;
const betsHtml = bets => `<div class="bets">${bets.map(b => `<div class="bet"><span class="type">${esc(b.type)}</span><span class="combo">${esc(b.selection)}</span><span></span><p>${esc(b.comment)}</p></div>`).join("")}</div>`;

function renderTotal() {
  if (!ai.entry) return `<p class="muted">レース情報を入れて「AI に予想させる」を押してください。</p>`;
  const rows = consensus(ai.results);
  const used = PROVIDERS.map(([id]) => id).filter(id => ai.results[id] || ai.pending.has(id));
  if (!rows.length) return ai.pending.size ? `<p class="muted">AI が考えています…</p>` : `<div class="ai-msg err">予想を取得できた AI がありませんでした。各 AI のタブでエラーを確認してください。</div>`;
  const max = rows[0].winProb;
  const okIds = used.filter(id => ai.results[id]?.ok);
  let html = ai.pending.size ? `<div class="ai-msg info">${[...ai.pending].map(id => NAME[id]).join("・")} がまだ考え中です。届いた分だけで暫定の総合予想を出しています。</div>` : "";
  html += `<p class="ai-meta">${okIds.map(id => NAME[id]).join(" + ")} の勝率を平均${ai.entry.test ? " ・ <b>テストモード</b>" : ""}</p>`;
  html += `<div class="table-wrap"><table class="table ai-table"><thead><tr><th>順位</th><th>印</th><th>馬番</th><th>馬名</th><th>総合勝率</th>${okIds.map(id => `<th>${NAME[id]}</th>`).join("")}</tr></thead><tbody>`;
  html += rows.map((r, i) => `<tr><td class="num">${i + 1}</td>${markCell(r.mark)}<td class="num">${r.number ?? ""}</td>
    <td><strong>${esc(r.horse)}</strong>${libBtn(r.libraryTitle)}</td><td>${probCell(r.winProb, max)}</td>
    ${okIds.map(id => `<td class="num">${id in r.probs ? `${pct(r.probs[id])} <span style="color:${MARK_COLOR[r.marks[id]] || "inherit"}">${esc(r.marks[id] || "")}</span>` : "-"}</td>`).join("")}</tr>`).join("");
  html += `</tbody></table></div><div class="ai-sec">`;
  const picks = okIds.map(id => [id, topPick(ai.results[id].predictions)]);
  if (picks.length) {
    html += `<h4>AI ごとの本命</h4><p>${picks.map(([id, p]) => `${NAME[id]}: ◎${esc(label(p))}`).join("　")}</p>`;
    if (picks.length === 2) {
      const same = sameHorse(picks[0][1], picks[1][1]);
      html += `<p class="ai-agree ${same ? "same" : ""}">${same ? "→ 2つの AI の本命が一致しました。軸として信頼度の高い馬です。" : "→ 本命が割れました。両方を軸にしたワイドや馬連も考えられます。"}</p>`;
    }
  }
  okIds.forEach(id => { if (ai.results[id].bets?.length) html += `<h4>${NAME[id]} のおすすめ買い目</h4>${betsHtml(ai.results[id].bets)}`; });
  const failed = used.filter(id => ai.results[id] && !ai.results[id].ok);
  if (failed.length) html += `<div class="ai-msg err" style="margin-top:14px">${failed.map(id => NAME[id]).join("・")} は予想を取得できなかったため、総合予想に含めていません。</div>`;
  return html + `</div>`;
}

function renderProvider(id) {
  if (ai.pending.has(id)) return `<p class="muted">${NAME[id]} が考えています…</p>`;
  const r = ai.results[id];
  if (!r) return `<p class="muted">${ai.entry ? "今回は使っていません。" : "まだ予想していません。"}</p>`;
  let html = `<p class="ai-meta"><span>モデル <b>${esc(r.model || "-")}</b></span><span>自信度 <b>${esc(r.confidence || "-")}</b></span><span>${(+r.elapsedSec || 0).toFixed(0)}秒</span>${r.test ? "<span><b>テストモード</b></span>" : ""}</p>`;
  if (r.error) html += `<div class="ai-msg err">${esc(r.error)}</div>`;
  if (r.notice) html += `<div class="ai-msg info">${esc(r.notice)}</div>`;
  const preds = r.predictions || [];
  if (preds.length) {
    const max = Math.max(...preds.map(p => p.winProb));
    html += `<div class="table-wrap"><table class="table ai-table"><thead><tr><th>印</th><th>馬番</th><th>馬名</th><th>騎手</th><th>勝率</th></tr></thead><tbody>${preds.map(p =>
      `<tr>${markCell(p.mark)}<td class="num">${p.number ?? ""}</td><td><strong>${esc(p.horse)}</strong>${libBtn(p.libraryTitle)}</td><td>${esc(p.jockey)}</td><td>${probCell(p.winProb, max)}</td></tr>`).join("")}</tbody></table></div>`;
  }
  html += `<div class="ai-sec">`;
  if (r.outlook) html += `<h4>展望</h4><p>${esc(r.outlook)}</p>`;
  if (r.pace) html += `<h4>展開・ペース</h4><p>${esc(r.pace)}</p>`;
  if (preds.some(p => p.reason)) html += `<h4>各馬の評価</h4><ul class="ai-evals">${preds.filter(p => p.reason).map(p => `<li>${p.mark ? `<span class="mk">${esc(p.mark)}</span>` : ""}<b>${esc(label(p))}</b> (${pct(p.winProb)}) ${esc(p.reason)}</li>`).join("")}</ul>`;
  if (r.bets?.length) html += `<h4>おすすめの買い目</h4>${betsHtml(r.bets)}`;
  if (r.notes) html += `<h4>注意点</h4><p class="muted">${esc(r.notes)}</p>`;
  if (r.raw) html += `<h4>AI の回答 (そのまま)</h4><div class="ai-raw">${esc(r.raw)}</div>`;
  if (r.sources?.length) html += `<h4>参照した情報源</h4><ol class="ai-src">${r.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a></li>`).join("")}</ol>`;
  return html + `</div>`;
}

/* ---------------- 3D へ ---------------- */
function simPicks() {
  if (!ai.entry) return [];
  if (ai.tab === "total") return consensus(ai.results);
  return ai.results[ai.tab]?.predictions || [];
}
function toSim() {
  const picks = simPicks();
  if (!picks.length) return;
  const race = ai.entry.race;
  const coats = ai.card?.coats;
  ctx.sendToSim({
    picks: picks.map((p) => ({ ...p, coat: coats?.get(norm(p.horse)) })),
    venue: race.venue,
    surface: race.surface,
    distance: race.distance,
  });
}

/* ---------------- 履歴と成績 ---------------- */
async function loadHistory() {
  try { ai.history = await api("/api/ai/history"); } catch (_) { ai.history = []; }
  renderHistory();
}
function picksOf(e) {
  const out = {};
  PROVIDERS.forEach(([id]) => { const r = e.results?.[id]; out[id] = r?.ok ? topPick(r.predictions) : null; });
  out.total = e.consensus?.[0] || null;
  return out;
}
function matchActual(pick, token) {
  if (!pick) return false;
  const t = norm(token);
  if (!t) return false;
  if (/^\d+$/.test(t)) return pick.number != null && +t === +pick.number;
  const n = norm(pick.horse);
  return !!n && (t === n || (t.length >= 2 && (n.includes(t) || t.includes(n))));
}
function renderHistory() {
  const keys = [["gemini", "Gemini"], ["claude", "Claude"], ["total", "総合"]];
  const stats = Object.fromEntries(keys.map(([k]) => [k, { n: 0, win: 0, place: 0 }]));
  const rows = ai.history.map(e => {
    const p = picksOf(e);
    const actual = e.actual || [];
    let hit = false;
    if (actual.length && !e.test) {
      keys.forEach(([k]) => {
        if (!p[k]) return;
        const s = stats[k];
        s.n++;
        if (matchActual(p[k], actual[0])) { s.win++; hit = true; }
        if (actual.slice(0, 3).some(a => matchActual(p[k], a))) s.place++;
      });
    }
    const r = e.race || {};
    const when = new Date(e.createdAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const cell = x => (x ? `◎${esc(label(x))}` : "-");
    return `<tr class="${hit ? "hit" : ""}"><td class="num">${when}</td>
      <td>${e.test ? `<span class="chip">テスト</span> ` : ""}<strong>${esc(r.name || "レース名なし")}</strong><span class="sub">${esc([r.date, r.venue, r.surface && r.distance ? `${r.surface}${r.distance}m` : ""].filter(Boolean).join(" ・ "))}</span></td>
      <td>${cell(p.gemini)}</td><td>${cell(p.claude)}</td><td>${cell(p.total)}</td>
      <td>${actual.length ? esc(actual.join(", ")) : `<span class="muted">未入力</span>`}</td>
      <td><div class="ai-hist-actions"><button class="btn ghost" type="button" data-show="${esc(e.id)}">表示</button><button class="btn ghost" type="button" data-actual="${esc(e.id)}">着順</button><button class="btn ghost" type="button" data-del="${esc(e.id)}" aria-label="削除">${icon("trash")}</button></div></td></tr>`;
  });
  $("#ai-stats").innerHTML = keys.map(([k, n]) => {
    const s = stats[k];
    return `<div class="ai-stat"><strong>${n}</strong>${s.n ? `<b>${Math.round((s.win / s.n) * 100)}%</b><span>1着的中 ${s.win}/${s.n}</span><span>3着以内 ${s.place}/${s.n}</span>` : `<span class="muted" style="margin:0">まだデータがありません</span>`}</div>`;
  }).join("");
  $("#ai-history").innerHTML = ai.history.length
    ? `<thead><tr><th>予想日時</th><th>レース</th><th>Gemini</th><th>Claude</th><th>総合</th><th>結果</th><th></th></tr></thead><tbody>${rows.join("")}</tbody>`
    : `<tbody><tr><td class="muted">まだ予想の履歴がありません。</td></tr></tbody>`;
  $$("#ai-history [data-show]").forEach(b => b.addEventListener("click", () => showEntry(b.dataset.show)));
  $$("#ai-history [data-actual]").forEach(b => b.addEventListener("click", () => openActual(b.dataset.actual)));
  $$("#ai-history [data-del]").forEach(b => b.addEventListener("click", () => deleteEntry(b.dataset.del)));
}
function showEntry(id) {
  const e = ai.history.find(x => x.id === id);
  if (!e || ai.running) return;
  ai.entry = e;
  ai.results = e.results || {};
  ai.pending = new Set();
  ai.tab = "total";
  fillForm(e.race || {});
  render();
  $("#ai-status").textContent = `履歴の予想を表示しています (${new Date(e.createdAt).toLocaleString("ja-JP")})`;
  $(".ai-result").scrollIntoView({ behavior: "smooth", block: "start" });
}
function openActual(id) {
  const e = ai.history.find(x => x.id === id);
  if (!e) return;
  const d = $("#ai-actual-dialog");
  d.dataset.id = id;
  $("#ai-actual-race").textContent = e.race?.name || "レース名なし";
  $("#ai-actual").value = (e.actual || []).join(", ");
  d.showModal();
}
async function saveActual() {
  const d = $("#ai-actual-dialog");
  if (d.returnValue !== "save") return;
  const e = ai.history.find(x => x.id === d.dataset.id);
  if (!e) return;
  e.actual = $("#ai-actual").value.split(/[,、，/／\s]+/).map(s => s.trim()).filter(Boolean);
  try { await api("/api/ai/history", { method: "POST", body: JSON.stringify(e) }); toast("着順を保存しました"); }
  catch (_) { toast("保存できませんでした"); }
  renderHistory();
}
async function deleteEntry(id) {
  const e = ai.history.find(x => x.id === id);
  if (!e || !confirm(`「${e.race?.name || "レース名なし"}」の予想を履歴から削除しますか？ (元に戻せません)`)) return;
  try { await api(`/api/ai/history/${encodeURIComponent(id)}`, { method: "DELETE" }); } catch (_) { toast("削除できませんでした"); }
  loadHistory();
}

/* ---------------- API キーとモデル ---------------- */
function openSettings() {
  const s = ai.settings;
  if (!s) return;
  $("#ai-gem-key").value = "";
  $("#ai-cla-key").value = "";
  $("#ai-gem-hint").textContent = s.gemini.configured ? `設定済み ${s.gemini.keyHint}${s.gemini.fromEnv ? " (環境変数)" : ""}` : "未設定";
  $("#ai-cla-hint").textContent = s.claude.configured ? `設定済み ${s.claude.keyHint}${s.claude.fromEnv ? " (環境変数)" : ""}` : "未設定";
  $("#ai-gem-model").value = s.gemini.model;
  $("#ai-cla-model").value = s.claude.model;
  $("#ai-store-path").textContent = s.storedAt;
  $("#ai-dialog").showModal();
}
async function postSettings(body) {
  ai.settings = await api("/api/ai/settings", { method: "POST", body: JSON.stringify(body) });
  renderKeyStatus();
}
async function closeSettings() {
  const v = $("#ai-dialog").returnValue;
  try {
    if (v === "save") {
      await postSettings({ geminiKey: $("#ai-gem-key").value, claudeKey: $("#ai-cla-key").value, geminiModel: $("#ai-gem-model").value, claudeModel: $("#ai-cla-model").value });
      toast("保存しました");
    } else if (v === "clear" && confirm("保存してある Gemini と Claude の API キーを消しますか？ (環境変数のキーは消えません)")) {
      await postSettings({ clearGemini: true, clearClaude: true });
      toast("キーを消しました");
    }
  } catch (_) { toast("保存できませんでした"); }
  $("#ai-gem-key").value = "";
  $("#ai-cla-key").value = "";
}
// 入力中のキーがあれば先に保存してから、使えるモデルの一覧を取る
async function fetchModels(provider) {
  const keyInput = provider === "gemini" ? $("#ai-gem-key") : $("#ai-cla-key");
  try {
    if (keyInput.value.trim()) {
      await postSettings(provider === "gemini" ? { geminiKey: keyInput.value } : { claudeKey: keyInput.value });
      keyInput.value = "";
      openSettingsHints();
    }
    const res = await fetch(`/api/ai/models?provider=${provider}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    $(provider === "gemini" ? "#ai-gem-models" : "#ai-cla-models").innerHTML = data.map(m => `<option value="${esc(m)}">`).join("");
    toast(`${data.length} 件のモデルを取得しました。モデル欄で選んでください`);
  } catch (e) {
    alert(`モデルの一覧を取得できませんでした。\n${e.message}`);
  }
}
function openSettingsHints() {
  const s = ai.settings;
  $("#ai-gem-hint").textContent = s.gemini.configured ? `設定済み ${s.gemini.keyHint}` : "未設定";
  $("#ai-cla-hint").textContent = s.claude.configured ? `設定済み ${s.claude.keyHint}` : "未設定";
}
