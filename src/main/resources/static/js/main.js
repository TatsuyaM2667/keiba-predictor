// ==================================================================================
// main.js — 画面全体の動き (index.html から <script type="module"> で読み込まれる)
// ==================================================================================
// このファイルの構成:
//   起動演出 (splash) → ルーティング (route) → テーマ → WebAssembly の読み込み
//   → 各画面 (init.home / init.races / init.sim / ...) → アカウント → boot (起動処理)
// 画面は 1 枚の HTML の中に全部入っていて、URL の # 以降 (#/horses など) で表示を切り替える
// 「シングルページアプリ」。各画面は初めて開いたときに 1 回だけ init.画面名() で準備する。
//
// 【安全のための決まり】Wikipedia など外から来た文字列を HTML に入れるときは必ず esc() を通す。
import {
  $,
  $$,
  esc,
  icon,
  api,
  toast,
  debounce,
  photo,
  wikiUrl,
  wakuOf,
  wakuBadge,
  wakuCss,
  gradeBadge,
  coatOf,
  horseSvg,
  fmtYen,
  seeded,
  setTokenProvider,
} from "./util.js";
import { marketProbs, kelly, coatName, simulateOrders, strategies, commentary, BET, BET_TYPES, hits, probOf, oddsFrom, modelProbs, planTickets, payoutOf, features } from "./race-model.js";
import { initAi } from "./ai.js";

// Firebase の Web SDK (公式 CDN)。/api/config に設定がある環境 (Cloudflare Pages 版) だけで読み込む
const FIREBASE_SDK = "https://www.gstatic.com/firebasejs/13.2.0/";

// アプリ全体で共有する状態 (データの置き場)。画面をまたいで使う値はすべてここに入れる。
const state = {
  courses: [],
  weather: new Map(),
  user: null,
  engines: { c: null, zig: null, odin: null },
  race: null, // レース予想で表示中の分析
  raceSort: "num",
  mcPace: 1.0,
  horses: { offset: 0, total: 0, loading: false },
  catalog: { offset: 0, total: 0 },
  field: [], // シミュレーションの出走馬
  sim: null,
  simReady: null,
};
// OS の「視差効果を減らす / アニメーションを減らす」設定。有効なら演出を最小限にする (アクセシビリティ)。
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
const STYLE_NAMES = ["逃げ", "先行", "差し", "追込"];

/* ============================================================
   起動: 発馬ゲートの演出
   ============================================================ */
// 起動演出: 8 枠の発馬ゲートを並べ、読み込みが終わったら扉を開いて本編に切り替える。
// 戻り値:
//   track(説明, Promise) … 読み込み処理を登録。終わるたびに進捗バーを伸ばして説明を表示
//   finish()             … すべて終わったら呼ぶ。最低 1.9 秒は見せてから開く (一瞬で消えないように)
function splash() {
  const el = $("#splash"),
    bar = $("#splash-bar"),
    status = $("#splash-status");
  const gate = $("#gate");
  gate.innerHTML = Array.from(
    { length: 8 },
    (_, i) =>
      `<div class="stall" data-n="${i + 1}" style="--c:var(--w${i + 1});--t:var(--w${i + 1}t)"><div class="door l"></div><div class="door r"></div></div>`,
  ).join("");
  const started = performance.now();
  let total = 0,
    done = 0,
    closed = false;
  // 扉を開く。左の枠から 45ms ずつ遅らせて、ゲートが順番に開くように見せる。
  // アニメーションが終わったら splash の要素ごと消す (裏に残してクリックを邪魔しないように)。
  const close = () => {
    if (closed) return;
    closed = true;
    $$(".stall", gate).forEach((s, i) =>
      $$(".door", s).forEach((d) => (d.style.transitionDelay = `${i * 45}ms`)),
    );
    el.classList.add("open");
    requestAnimationFrame(() => el.classList.add("leave"));
    document.body.classList.add("ready");
    setTimeout(() => el.remove(), reduceMotion ? 50 : 1400);
  };
  $("#splash-skip").addEventListener("click", close);
  addEventListener("keydown", (e) => e.key === "Escape" && close(), {
    once: true,
  });
  return {
    track(label, promise) {
      total++;
      return promise.finally(() => {
        done++;
        bar.style.width = `${(done / total) * 100}%`;
        status.textContent = label;
      });
    },
    finish() {
      setTimeout(
        close,
        Math.max(0, (reduceMotion ? 0 : 1900) - (performance.now() - started)),
      );
    },
  };
}

/* ============================================================
   ルーティング (#/view)
   ============================================================ */
// URL の # → 表示する画面。例: #/horses → <section id="view-horses"> を表示し、ほかを隠す。
// 知らない名前ならホームを表示する。
// init[画面名] は「その画面を初めて開いたとき」だけ呼ぶ (2 回目以降は表示の切り替えだけ)。
// 3D シミュレーションは表示中だけ描画させ、ほかの画面では止めて CPU / GPU を休ませる。
const views = {};
function route() {
  const name = (location.hash.match(/^#\/(\w+)/) || [])[1] || "home";
  const target = $(`#view-${name}`) ? name : "home";
  $$(".view").forEach((v) =>
    v.classList.toggle("on", v.id === `view-${target}`),
  );
  $$("#nav a").forEach((a) =>
    a.classList.toggle("on", a.dataset.view === target),
  );
  movePill();
  state.sim?.setVisible(target === "sim");
  if (!views[target]?.loaded) {
    views[target] = { loaded: true };
    init[target]?.();
  }
  if (target !== "sim")
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "instant" });
}
// サイドメニューの「選択中」の背景 (ピル) を、選ばれた項目の位置と大きさに動かす。
// CSS の transition でなめらかに移動する。
function movePill() {
  const a = $("#nav a.on"),
    pill = $("#nav-pill");
  if (!a) return;
  pill.style.transform = `translate(${a.offsetLeft}px, ${a.offsetTop}px)`;
  pill.style.width = `${a.offsetWidth}px`;
  pill.style.height = `${a.offsetHeight}px`;
}

/* ============================================================
   テーマ
   ============================================================ */
// テーマの切り替え。mode は "light" / "dark" / "auto" (OS に合わせる)。
// 選んだ値は localStorage (このブラウザ内の保存領域) に覚える。
// プライベートブラウズなどで保存できない環境もあるので try / catch で囲む。
// document.startViewTransition: 対応ブラウザでは前後の画面をなめらかに切り替える。
// 3D シミュレーションにも昼 / ナイターの切り替えを伝える。
function setTheme(mode) {
  try {
    mode === "auto"
      ? localStorage.removeItem("kv-theme")
      : localStorage.setItem("kv-theme", mode);
  } catch (_) {}
  const next =
    mode === "auto"
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : mode;
  const apply = () => {
    document.documentElement.dataset.theme = next;
    state.sim?.applyTheme();
    syncThemeSeg();
  };
  if (
    document.startViewTransition &&
    !reduceMotion &&
    next !== document.documentElement.dataset.theme
  )
    document.startViewTransition(apply);
  else apply();
}
function syncThemeSeg() {
  let saved = null;
  try {
    saved = localStorage.getItem("kv-theme");
  } catch (_) {}
  $$("#theme-seg button").forEach((b) =>
    b.classList.toggle("on", b.dataset.themeSet === (saved || "auto")),
  );
}

/* ============================================================
   WebAssembly エンジン (C / Zig / Odin)
   ============================================================ */
// 3 つの WebAssembly (C / Zig / Odin) を同時に読み込む。
// Promise.allSettled: 1 つが失敗しても残りは使えるようにする (Promise.all だと 1 つの失敗で全部失敗になる)。
// 読み込めなかったエンジンを使う機能だけが「読み込めませんでした」と表示される。
async function loadEngines() {
  const load = async (name) =>
    (
      await WebAssembly.instantiate(
        await (await fetch(`/static/wasm/${name}.wasm`)).arrayBuffer(),
      )
    ).instance.exports;
  const [c, zig, odin] = await Promise.allSettled([
    load("keiba_physics"),
    load("montecarlo"),
    load("pedigree"),
  ]);
  state.engines = { c: c.value, zig: zig.value, odin: odin.value };
  const names = [
    ["C (直線物理・期待値)", c],
    ["Zig (勝率シミュレーション)", zig],
    ["Odin (血量計算)", odin],
  ];
  $("#engine-status").textContent = names
    .map(
      ([n, r]) =>
        `${n}: ${r.status === "fulfilled" ? "稼働中" : "読み込み失敗"}`,
    )
    .join(" / ");
}

/* ============================================================
   ホーム
   ============================================================ */
// サーバーから届く馬場状態の英語名 → [日本語, 色分け用の CSS クラス]。
const COND = {
  FIRM: ["良", "cond-good"],
  GOOD: ["稍重", "cond-wet"],
  YIELDING: ["重", "cond-wet"],
  SOFT: ["不良", "cond-bad"],
};
const init = {};

// ホーム画面。大きな写真は「日付ごとに違う競馬場」を表示する (日付 % 写真のある競馬場の数)。
init.home = async () => {
  const d = new Date();
  $("#hero-date").textContent = d.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
  });
  const withPhoto = state.courses.filter((c) => c.image);
  const pick = withPhoto[d.getDate() % Math.max(1, withPhoto.length)];
  if (pick) {
    const img = $("#hero-img");
    img.onload = () => img.classList.add("loaded");
    img.src = photo(pick.image, 1920);
    img.alt = pick.name;
    credit([pick.image], $("#hero-credit"), pick.name);
  }
  renderWeatherGrid();
  try {
    const [st, top] = await Promise.all([
      api("/api/library/status"),
      api("/api/horses?sort=rating&photo=1&limit=12"),
    ]);
    $("#home-stats").innerHTML = [
      [st.horses.toLocaleString(), "頭の競走馬"],
      [st.horsesWithPhoto.toLocaleString(), "頭は写真付き"],
      [st.races.toLocaleString(), "の競走"],
      [st.courses, "の競馬場"],
    ]
      .map(([n, l]) => `<div class="stat"><b>${n}</b><span>${l}</span></div>`)
      .join("");
    $("#home-horses").innerHTML = top.items.map(horseCard).join("");
    bindHorseCards($("#home-horses"));
  } catch (e) {
    console.error(e);
  }
};

// 25 場の天気をまとめて取得し、競馬場 ID をキーにした Map に入れる (ホーム・競馬場画面で共用)。
async function loadWeather() {
  try {
    const list = await api("/api/weather");
    list.forEach((w) => state.weather.set(w.id, w));
  } catch (e) {
    console.warn("天気を取得できませんでした", e);
  }
}

function renderWeatherGrid() {
  $("#weather-grid").innerHTML = state.courses
    .map((c) => {
      const w = state.weather.get(c.id);
      const [cond, cls] = w ? COND[w.trackCondition] : ["—", ""];
      return `<a class="wx" href="#/courses" data-course="${c.id}">
      <strong>${esc(c.short)}</strong>${icon(w?.icon || "cloud")}
      <span class="t">${w ? `${w.temperatureC.toFixed(0)}°` : "—"}</span>
      <span class="c">${w ? esc(w.description) : "取得できません"} ・ 推定 <b class="${cls}">${cond}</b></span></a>`;
    })
    .join("");
  $$("#weather-grid .wx").forEach((a) =>
    a.addEventListener("click", () =>
      setTimeout(() => openCourse(a.dataset.course), 50),
    ),
  );
}

/* ============================================================
   写真のクレジット (作者とライセンスの表示)
   ============================================================ */
// 写真の作者とライセンスを、写真の下に表示する (CC BY-SA などの利用条件)。
// クレジットの取得に失敗しても、写真や画面の表示は止めない。
async function credit(files, el, prefix = "") {
  if (!files.length || !el) return;
  try {
    const list = await api(
      `/api/media?files=${encodeURIComponent(files.join("|"))}`,
    );
    const c = list[0];
    if (!c) return;
    el.innerHTML = `${prefix ? esc(prefix) + " ・ " : ""}写真: ${esc(c.artist || "不明")} / <a href="${esc(c.pageUrl)}" target="_blank" rel="noopener">${esc(c.license || "Wikimedia Commons")}</a>`;
  } catch (_) {
    /* クレジット取得に失敗しても表示は続ける */
  }
}

/* ============================================================
   競走馬名鑑
   ============================================================ */
// 名鑑のカード 1 枚分の HTML。写真がない馬は毛色に合わせたシルエットを表示する。
// 画像の読み込みに失敗したら (onerror) img を消して、灰色の背景だけにする。
// loading="lazy": 画面に入りそうになるまで画像を読み込まない (たくさんの写真を一度に読まない)。
function horseCard(v) {
  const h = v.horse;
  const [body, , , hair] = coatOf(h.color);
  const wins = h.bigWins
    .slice(0, 3)
    .map((w) => gradeBadge(w.grade))
    .join("");
  return `<button class="hcard" type="button" data-title="${esc(h.title)}">
    <div class="ph">${h.image ? `<img loading="lazy" alt="${esc(h.name)}" src="${photo(h.image, 500)}" onload="this.classList.add('loaded')" onerror="this.remove()">` : ""}${h.image ? "" : horseSvg(body, hair)}</div>
    <span class="rating num" title="戦績から算出した参考値">${v.rating}</span>
    <div class="body">
      <span class="name">${esc(h.name)}</span>
      <span class="meta">${[h.birthYear && `${h.birthYear}年`, h.sex, h.color, h.sire && `父 ${h.sire}`].filter(Boolean).map(esc).join(" ・ ")}</span>
      ${wins ? `<span class="wins">${wins}<span class="meta">${esc(h.bigWins[0].race)}${h.bigWins.length > 1 ? ` ほか${h.bigWins.length - 1}` : ""}</span></span>` : `<span class="meta">${esc(h.recordText.split(" / ")[0] || "")}</span>`}
    </div></button>`;
}
function bindHorseCards(root) {
  $$(".hcard", root).forEach((b) =>
    b.addEventListener("click", () => openHorse(b.dataset.title)),
  );
}

// 名鑑画面。検索欄は入力が止まってから 250ms 後に検索する (debounce)。
// 並び順や絞り込みを変えたら 1 ページ目から読み直す。
init.horses = () => {
  const reload = debounce(() => loadHorses(true), 250);
  ["#horse-q"].forEach((s) => $(s).addEventListener("input", reload));
  ["#horse-sort", "#horse-sex", "#horse-surface", "#horse-photo"].forEach((s) =>
    $(s).addEventListener("change", () => loadHorses(true)),
  );
  $("#horse-more").addEventListener("click", () => loadHorses(false));
  loadHorses(true);
};

// 名鑑を 48 頭ずつ読み込む。reset = true なら最初から、false なら続き (「さらに表示」)。
// loading フラグで、読み込み中にもう一度呼ばれても二重に読まないようにする。
// 読み込み中は灰色の仮カード (skeleton) を表示する。
async function loadHorses(reset) {
  const st = state.horses;
  if (st.loading) return;
  st.loading = true;
  if (reset) {
    st.offset = 0;
    $("#horse-grid").innerHTML = Array(8)
      .fill('<div class="skeleton"></div>')
      .join("");
  }
  const p = new URLSearchParams({
    q: $("#horse-q").value,
    sort: $("#horse-sort").value,
    sex: $("#horse-sex").value,
    surface: $("#horse-surface").value,
    photo: $("#horse-photo").checked ? "1" : "0",
    offset: st.offset,
    limit: 48,
  });
  try {
    const page = await api(`/api/horses?${p}`);
    st.total = page.total;
    const html = page.items.map(horseCard).join("");
    if (reset)
      $("#horse-grid").innerHTML =
        html || `<p class="empty">条件に合う馬が見つかりませんでした</p>`;
    else $("#horse-grid").insertAdjacentHTML("beforeend", html);
    bindHorseCards($("#horse-grid"));
    st.offset += page.items.length;
    $("#horse-count").textContent = `${page.total.toLocaleString()} 頭`;
    $("#horse-more").hidden = st.offset >= page.total;
  } catch (e) {
    $("#horse-grid").innerHTML = `<p class="empty">読み込めませんでした</p>`;
  } finally {
    st.loading = false;
  }
}

// 馬の詳細を右側のシートに表示する。まず「読み込み中」を出してから、データが届いたら中身を差し替える。
// facts は [項目名, 値] の一覧で、値が空の項目は表示しない。
async function openHorse(title) {
  openSheet(
    `<div class="detail-photo"></div><div class="detail-body"><p class="muted">読み込み中</p></div>`,
  );
  try {
    const { view: v, summary } = await api(
      `/api/horses/detail?title=${encodeURIComponent(title)}`,
    );
    const h = v.horse;
    const [body, , , hair] = coatOf(h.color);
    const fav = state.user?.favoriteHorses?.includes(h.title);
    const facts = [
      [
        "生年",
        [
          h.birthYear && `${h.birthYear}年`,
          h.deathYear && `(${h.deathYear}年没)`,
        ]
          .filter(Boolean)
          .join(" "),
      ],
      ["性・毛色", [h.sex, h.color].filter(Boolean).join(" ・ ")],
      [
        "血統",
        [
          h.sire && `父 ${h.sire}`,
          h.dam && `母 ${h.dam}`,
          h.damSire && `母父 ${h.damSire}`,
        ]
          .filter(Boolean)
          .join(" / "),
      ],
      ["調教師", h.trainer],
      ["馬主", h.owner],
      ["生産", h.breeder],
      ["生国", h.country],
      ["成績", h.recordText],
      ["獲得賞金", h.earningsText],
      [
        "適性 (推定)",
        [
          v.surface !== "不明" && v.surface,
          v.bestDistance && `${v.bestDistance}m 前後`,
        ]
          .filter(Boolean)
          .join(" ・ "),
      ],
    ].filter(([, val]) => val);
    $("#sheet-body").innerHTML = `
      <div class="detail-photo">${h.image ? `<img alt="${esc(h.name)}" src="${photo(h.image, 960)}" onerror="this.remove()">` : horseSvg(body, hair)}</div>
      ${h.image ? `<p class="credit photo-credit" id="detail-credit">${esc(h.imageCaption)}</p>` : ""}
      <div class="detail-body">
        <h2>${esc(h.name)}</h2>
        ${h.nameEn ? `<p class="en">${esc(h.nameEn)}</p>` : ""}
        <div class="meter"><b>${v.rating}</b><div class="bar"><i style="width:${v.rating}%"></i></div><span class="muted" style="font-size:12px">能力値 (参考)</span></div>
        <dl class="facts">${facts.map(([k, val]) => `<dt>${esc(k)}</dt><dd>${esc(val)}</dd>`).join("")}</dl>
        ${h.bigWins.length ? `<h3 style="margin-bottom:10px">主な勝ち鞍</h3><ul class="wins-list">${h.bigWins.map((w) => `<li>${gradeBadge(w.grade)}${esc(w.race)}</li>`).join("")}</ul>` : ""}
        ${summary ? `<p class="summary">${esc(summary)}</p><p class="fine">出典: <a href="${wikiUrl(h.title)}" target="_blank" rel="noopener">Wikipedia「${esc(h.title)}」</a> (CC BY-SA 4.0)</p>` : ""}
        <div class="btn-row" style="margin-top:18px">
          <button class="btn primary small" id="add-to-sim" type="button">${icon("plus")}シミュレーションに追加</button>
          <button class="btn ghost small star ${fav ? "on" : ""}" id="fav-btn" type="button">${icon("star")}${fav ? "お気に入り済み" : "お気に入り"}</button>
          <a class="btn ghost small" href="${wikiUrl(h.title)}" target="_blank" rel="noopener">${icon("external-link")}Wikipedia</a>
        </div>
      </div>`;
    if (h.image) credit([h.image], $("#detail-credit"), h.imageCaption);
    $("#add-to-sim").addEventListener("click", () => {
      addToField(v);
      closeSheet();
      location.hash = "#/sim";
    });
    $("#fav-btn").addEventListener("click", () => toggleFavorite(h.title));
  } catch (e) {
    $("#sheet-body").innerHTML =
      `<div class="detail-body"><p class="muted">読み込めませんでした</p></div>`;
  }
}

// 右から出てくる詳細シート。hidden を外してから次のフレームで .on を付けると、
// CSS のスライドインのアニメーションが確実に再生される。
// キーボード操作の人のために、閉じるボタンにフォーカスを移す。
function openSheet(html) {
  $("#sheet-body").innerHTML = html;
  const s = $("#sheet");
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add("on"));
  $(".sheet-close", s).focus({ preventScroll: true });
}
function closeSheet() {
  const s = $("#sheet");
  s.classList.remove("on");
  setTimeout(() => (s.hidden = true), 400);
}

/* ============================================================
   競馬場
   ============================================================ */
init.courses = () => {
  renderCourses("");
  $$("#course-filter button").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#course-filter button").forEach((x) =>
        x.classList.toggle("on", x === b),
      );
      renderCourses(b.dataset.cat);
    }),
  );
};
function renderCourses(cat) {
  $("#course-grid").innerHTML = state.courses
    .filter((c) => !cat || c.category === cat)
    .map((c) => {
      const w = state.weather.get(c.id);
      return `<button class="ccard" type="button" data-id="${c.id}">
      <div class="ph">${c.image ? `<img loading="lazy" alt="${esc(c.name)}" src="${photo(c.image, 500)}" onerror="this.remove()">` : ""}
        <span class="tag">${esc(c.category)}</span>
        ${w ? `<span class="wxs">${icon(w.icon)}${w.temperatureC.toFixed(0)}°</span>` : ""}</div>
      <div class="body"><h3>${esc(c.name)}</h3>
        <div class="specs"><span>${esc(c.region)}</span><span>${c.turn === "直線" ? "直線" : `${esc(c.turn)}回り`}</span><span>直線 <b>${c.straightMeters}</b>m</span></div></div>
    </button>`;
    })
    .join("");
  $$("#course-grid .ccard").forEach((b) =>
    b.addEventListener("click", () => openCourse(b.dataset.id)),
  );
}

// 競馬場の簡単なコース図 (SVG)。楕円の大きさは直線の長さに比例させる。
// 左回りなら右から左へ、右回りなら左から右へホームストレッチを描き、端にゴール線を引く。
// 高低差データがある競馬場 (東京・中山・京都・阪神) は下に高低差のグラフも描く。
// ばんえい (帯広) は直線コースなので別の図にする。
function courseSvg(c) {
  const W = 320,
    cx = W / 2,
    cy = 70;
  if (c.turn === "直線") {
    return `<svg class="course-svg" viewBox="0 0 ${W} 110" role="img" aria-label="${esc(c.name)} 直線コース">
      <rect x="20" y="40" width="280" height="30" rx="4" class="dirt"/><line x1="40" y1="55" x2="290" y2="55" class="straight"/>
      <line x1="290" y1="34" x2="290" y2="76" class="goal"/><text x="290" y="92" text-anchor="middle">ゴール</text>
      <text x="40" y="92">スタート (直線 200m・障害2か所)</text></svg>`;
  }
  const rx = 95 + Math.min(1, c.straightMeters / 660) * 50,
    ry = 42;
  const left = c.turn === "左";
  const x1 = cx - rx * 0.55,
    x2 = cx + rx * 0.55,
    y = cy + ry;
  const [from, to] = left ? [x2, x1] : [x1, x2];
  const prof = c.elevationProfile || [];
  const pMax = Math.max(...prof, 1),
    px = (i) => 20 + (i / Math.max(1, prof.length - 1)) * (W - 40),
    py = (v) => 200 - (v / pMax) * 26;
  const line = prof
    .map((v, i) => `${i ? "L" : "M"}${px(i).toFixed(1)} ${py(v).toFixed(1)}`)
    .join(" ");
  return `<svg class="course-svg" viewBox="0 0 ${W} ${prof.length ? 210 : 140}" role="img" aria-label="${esc(c.name)} ${esc(c.turn)}回り 直線${c.straightMeters}m">
    <ellipse cx="${cx}" cy="${cy}" rx="${rx + 9}" ry="${ry + 9}" class="outer"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" class="${c.surfaces.includes("芝") ? "turf" : "dirt"}"/>
    <ellipse cx="${cx}" cy="${cy}" rx="${rx - 14}" ry="${ry - 12}" class="inner"/>
    <line x1="${from}" y1="${y + 4}" x2="${to}" y2="${y + 4}" class="straight"/>
    <line x1="${to}" y1="${y - 8}" x2="${to}" y2="${y + 14}" class="goal"/>
    <text x="${to}" y="${y + 26}" text-anchor="middle">ゴール</text>
    <text x="${cx}" y="${cy + 4}" text-anchor="middle">${esc(c.turn)}回り ・ 直線 ${c.straightMeters}m</text>
    ${prof.length ? `<path d="${line} L${px(prof.length - 1)} 202 L${px(0)} 202 Z" class="elev-fill"/><path d="${line}" class="elev"/><text x="20" y="165">高低差 (向こう正面→ゴール、模式)</text>` : ""}
  </svg>`;
}

// 競馬場の詳細シート: 写真・コース図・天気・特徴、その競馬場で行われる競走の一覧。
// 「このコースで走らせる」は 3D シミュレーションに競馬場を設定して移動する。
async function openCourse(id) {
  const c = state.courses.find((x) => x.id === id);
  if (!c) return;
  const w = state.weather.get(c.id);
  openSheet(`<div class="course-detail">
    <div class="detail-photo">${c.image ? `<img alt="${esc(c.name)}" src="${photo(c.image, 960)}" onerror="this.remove()">` : ""}</div>
    ${c.image ? `<p class="credit photo-credit" id="course-credit"></p>` : ""}
    <div class="detail-body">
      <p class="eyebrow">${esc(c.category)} ・ ${esc(c.region)}</p>
      <h2>${esc(c.name)}</h2>
      ${courseSvg(c)}
      <dl class="facts">
        <dt>主催</dt><dd>${esc(c.organizer)}</dd>
        <dt>コース</dt><dd>${esc(c.surfaces)} ・ ${c.turn === "直線" ? "直線" : esc(c.turn) + "回り"}</dd>
        <dt>最後の直線</dt><dd class="num">${c.straightMeters}m (参考値)</dd>
        ${w ? `<dt>現在の天気</dt><dd>${esc(w.description)} ${w.temperatureC.toFixed(1)}℃ ・ 風 ${w.windKmh.toFixed(0)}km/h ・ 推定 ${COND[w.trackCondition][0]}</dd>` : ""}
        <dt>特徴</dt><dd>${esc(c.note)}</dd>
      </dl>
      <div class="btn-row">
        <button class="btn primary small" id="course-sim" type="button">${icon("rotate-3d")}このコースで走らせる</button>
        <button class="btn ghost small" id="course-live" type="button">${icon("tv")}中継</button>
        <a class="btn ghost small" href="${esc(c.website)}" target="_blank" rel="noopener">${icon("external-link")}公式サイト</a>
      </div>
      <h3 style="margin:24px 0 8px">この競馬場の主な競走</h3>
      <div id="course-races"><p class="muted">読み込み中</p></div>
    </div></div>`);
  if (c.image) credit([c.image], $("#course-credit"));
  $("#course-sim").addEventListener("click", () => {
    closeSheet();
    presetSim({ course: c.id });
    location.hash = "#/sim";
  });
  $("#course-live").addEventListener("click", () => {
    closeSheet();
    location.hash = "#/live";
    setTimeout(() => playLive(c.id), 100);
  });
  try {
    const page = await api(
      `/api/catalog/races?course=${encodeURIComponent(c.name)}&limit=40`,
    );
    $("#course-races").innerHTML = page.items.length
      ? `<ul class="wins-list">${page.items.map((r) => `<li>${gradeBadge(r.grade)}<a href="${wikiUrl(r.title)}" target="_blank" rel="noopener">${esc(r.name)}</a><span class="muted">${esc(r.surface)} ${r.distance ?? ""}${r.distance ? "m" : ""}</span></li>`).join("")}</ul>`
      : `<p class="muted">記事のある競走は見つかりませんでした</p>`;
  } catch (_) {
    $("#course-races").innerHTML = "";
  }
}

/* ============================================================
   競走一覧
   ============================================================ */
// 競走一覧画面。条件を変えるたびに 1 ページ目 (100 件) から読み直す。
init.catalog = () => {
  $("#catalog-course").insertAdjacentHTML(
    "beforeend",
    state.courses
      .map((c) => `<option value="${esc(c.name)}">${esc(c.name)}</option>`)
      .join(""),
  );
  $("#catalog-q").addEventListener(
    "input",
    debounce(() => loadCatalog(true)),
  );
  ["#catalog-course", "#catalog-grade", "#catalog-surface"].forEach((s) =>
    $(s).addEventListener("change", () => loadCatalog(true)),
  );
  $("#catalog-more").addEventListener("click", () => loadCatalog(false));
  loadCatalog(true);
};
async function loadCatalog(reset) {
  const st = state.catalog;
  if (reset) st.offset = 0;
  const p = new URLSearchParams({
    q: $("#catalog-q").value,
    course: $("#catalog-course").value,
    grade: $("#catalog-grade").value,
    surface: $("#catalog-surface").value,
    offset: st.offset,
    limit: 100,
  });
  const page = await api(`/api/catalog/races?${p}`);
  const rows = page.items
    .map(
      (r) => `<tr>
    <td>${gradeBadge(r.grade)}</td>
    <td><a href="${wikiUrl(r.title)}" target="_blank" rel="noopener"><strong>${esc(r.name)}</strong></a>${r.nameEn ? `<span class="sub">${esc(r.nameEn)}</span>` : ""}</td>
    <td>${esc(r.course.replace("競馬場", "")) || "—"}</td>
    <td class="num">${esc(r.surface)} ${r.distance ? r.distance + "m" : ""}</td>
    <td class="num">${esc(r.prize)}</td>
    <td>${simButtonFor(r)}</td></tr>`,
    )
    .join("");
  const head = `<thead><tr><th>格付け</th><th>競走名</th><th>競馬場</th><th>コース</th><th>1着賞金</th><th></th></tr></thead>`;
  if (reset) $("#catalog-table").innerHTML = head + `<tbody>${rows}</tbody>`;
  else $("#catalog-table tbody").insertAdjacentHTML("beforeend", rows);
  st.offset += page.items.length;
  $("#catalog-count").textContent = `${page.total.toLocaleString()} 競走`;
  $("#catalog-more").hidden = st.offset >= page.total;
  $$("#catalog-table [data-sim]").forEach(
    (b) =>
      (b.onclick = () => {
        presetSim({
          course: b.dataset.course,
          distance: +b.dataset.distance || undefined,
          surface: b.dataset.surface || undefined,
        });
        location.hash = "#/sim";
      }),
  );
}
// その競走の条件 (競馬場・距離・馬場) で 3D シミュレーションを準備するボタン。
// 競馬場が現役 25 場に含まれない (廃止された競馬場など) 競走にはボタンを出さない。
function simButtonFor(r) {
  const c = state.courses.find((x) => r.course.startsWith(x.name));
  if (!c) return "";
  return `<button class="btn ghost small" type="button" data-sim data-course="${c.id}" data-distance="${r.distance || ""}" data-surface="${r.surface.includes("ダート") ? "ダート" : r.surface.includes("芝") ? "芝" : ""}" title="この条件で3Dシミュレーション">${icon("rotate-3d")}</button>`;
}

/* ============================================================
   レース予想 (サンプルの出馬表)
   ============================================================ */
// レース予想画面。JRA の出馬表を自動で取り込めていればそれを、なければサンプルの出馬表を表示する。
init.races = async () => {
  $$("#mc-pace button").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#mc-pace button").forEach((x) => x.classList.toggle("on", x === b));
      state.mcPace = +b.dataset.pace;
      renderMonteCarlo();
    }),
  );
  $$("#table-sort button").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#table-sort button").forEach((x) =>
        x.classList.toggle("on", x === b),
      );
      state.raceSort = b.dataset.sort;
      renderEntries();
    }),
  );
  $("#race-to-sim").addEventListener("click", raceToSim);
  $("#note-open").addEventListener("click", openNote);
  const schedule = api("/api/live/schedule").catch(() => null);
  renderSchedule(schedule);
  const live = await api("/api/live/races").catch(() => null);
  if (live?.races?.length) return setupLive(live);
  if (live) return showNextMeeting(await schedule);
  // サンプルの出馬表 (自動取得の仕組みがない環境。ローカル版で Cloudflare 版に接続できないときなど)
  const races = await api("/api/races");
  $("#race-tabs").innerHTML = races
    .map(
      (r, i) =>
        `<button type="button" data-id="${r.id}" class="${i ? "" : "on"}">${esc(r.name.replace(/\s*\(.*\)/, ""))}</button>`,
    )
    .join("");
  $$("#race-tabs button").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#race-tabs button").forEach((x) => x.classList.toggle("on", x === b));
      loadRace(b.dataset.id);
    }),
  );
  if (races[0]) loadRace(races[0].id);
};

/* ---------- JRA の実際のレース (keiba-vision-sync Worker が自動で取り込んだもの) ---------- */
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
const mdw = (iso) => {
  const d = new Date(`${iso}T00:00:00+09:00`);
  return `${d.getMonth() + 1}/${d.getDate()} (${WEEK[d.getDay()]})`;
};
const GRADE_RANK = { GI: 6, "J・GI": 5, GII: 4, "J・GII": 3, GIII: 3, "J・GIII": 2, L: 1 };
// 日本時間の今日 "YYYY-MM-DD" と、今の時刻 "HH:MM"
const jstNow = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).split("T");
const hhmm = (ms) =>
  new Date(+ms).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });

// 開催日 → 競馬場 → レース (1R〜12R) の 3 段で選ぶ。最初は「今日 (なければ次の開催日) の一番格の高いレース」。
function setupLive(live) {
  state.live = { races: live.races, date: null, venue: null, id: null, cardAt: 0 };
  $("#race-tabs").hidden = true;
  $("#live-pick").hidden = false;
  // これからの出馬表がまだない (月〜木曜) ときは、前回の開催を確定オッズで振り返れるようにする
  if (live.dates.every((d) => d < jstNow()[0]))
    $("#live-pick").insertAdjacentHTML("afterbegin", `<p class="note">次の開催の出馬表は、ふつう開催の前々日の午後に発表され、自動でここに切り替わります。今は前回の開催 (発走後のオッズ) を表示しています。</p>`);
  const best = bestRace(live.races);
  pickLive(best.date, best.venue, best.id);
  // 画面を開いている間は 2 分ごとに、レースの一覧とオッズを取り直す (サーバー側は Worker が JRA から自動更新)。
  // 新しい開催日・レースが増えたら選択肢を作り直す。見ていたレースが一覧から消えたら次の開催の主なレースへ移る。
  setInterval(async () => {
    if (document.visibilityState !== "visible" || !location.hash.startsWith("#/races")) return;
    const live = await api("/api/live/races").catch(() => null);
    const L = state.live;
    if (live?.races?.length && live.races.map((r) => r.id).join() !== L.races.map((r) => r.id).join()) {
      L.races = live.races;
      $("#live-pick .note")?.remove();
      renderSchedule(api("/api/live/schedule").catch(() => null)); // 「出馬表」へのリンクも更新
      const keep = live.races.find((r) => r.id === L.id) || bestRace(live.races);
      return pickLive(keep.date, keep.venue, keep.id);
    }
    if (L.id) loadLiveRace(L.id, true);
  }, 120_000);
}
// 一番早い開催日の、一番格の高いレース (重賞がなければメインの 11R)
const bestRace = (races) =>
  [...races].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (GRADE_RANK[b.grade] ?? 0) - (GRADE_RANK[a.grade] ?? 0) ||
      (b.race_no === 11) - (a.race_no === 11),
  )[0];

function pickLive(date, venue, id) {
  const L = state.live;
  const dayRaces = L.races.filter((r) => r.date === date);
  const venues = [...new Set(dayRaces.map((r) => r.venue))];
  L.date = date;
  L.venue = venues.includes(venue) ? venue : venues[0];
  const list = dayRaces.filter((r) => r.venue === L.venue);
  L.id = list.some((r) => r.id === id) ? id : (list.find((r) => r.race_no === 11) || list[0]).id;
  const dates = [...new Set(L.races.map((r) => r.date))];
  $("#live-dates").innerHTML = dates
    .map((d) => `<button type="button" data-date="${d}" class="${d === date ? "on" : ""}">${mdw(d)}</button>`)
    .join("");
  $("#live-venues").innerHTML = venues
    .map((v) => `<button type="button" data-venue="${v}" class="${v === L.venue ? "on" : ""}">${esc(dayRaces.find((r) => r.venue === v).venueName)}</button>`)
    .join("");
  $("#live-races").innerHTML = list
    .map(
      (r) => `<button type="button" class="live-race ${r.id === L.id ? "on" : ""}" data-id="${r.id}">
        <b class="num">${r.race_no}R</b><span class="num">${esc(r.post_time)}</span>
        <span class="nm">${gradeBadge(r.grade)}${esc(r.name)}</span></button>`,
    )
    .join("");
  $$("#live-dates button").forEach((b) => b.addEventListener("click", () => pickLive(b.dataset.date, L.venue)));
  $$("#live-venues button").forEach((b) => b.addEventListener("click", () => pickLive(L.date, b.dataset.venue)));
  $$("#live-races button").forEach((b) => b.addEventListener("click", () => pickLive(L.date, L.venue, b.dataset.id)));
  loadLiveRace(L.id);
}

// 1 レース分を読み込んで、予想モデル → Zig のモンテカルロ → 出馬表・買い目 を描く。
// quiet = true は自動更新。オッズが前回から変わっていなければ何もしない。
async function loadLiveRace(id, quiet = false) {
  let r;
  try {
    r = await api(`/api/live/race?id=${encodeURIComponent(id)}`);
  } catch (e) {
    if (!quiet) toast("レースを読み込めませんでした");
    return;
  }
  if (id !== state.live.id || (quiet && r.card_at === state.live.cardAt)) return;
  state.live.cardAt = r.card_at;
  const hd = r.card?.header || {};
  const course = COURSE_BY_SHORT(r.venueName);
  const w = course && state.weather.get(course.id);
  const runners = (r.card?.runners || []).filter((x) => !x.scratched);
  const a = runners.length ? liveAnalysis(r, runners) : null;
  const [today, nowHm] = jstNow();
  const done = r.date < today || (r.date === today && nowHm > (hd.postTime || r.post_time || "99"));
  if (a) a.done = done;
  state.race = a;
  $("#race-hero").innerHTML = `<div>
      <div class="race-meta">${gradeBadge(hd.grade || r.grade)}<span>${esc(r.venueName)} ${r.race_no}R</span><span>${esc(hd.surface || r.surface)} ${hd.distance || r.distance || ""}m</span>${hd.turn ? `<span>${esc(hd.turn)}</span>` : ""}<span class="num">${mdw(r.date)} 発走 ${esc(hd.postTime || r.post_time)}</span></div>
      <h2>${esc(hd.name || r.name)}</h2><p class="muted">${esc([hd.edition, hd.cond || r.cond].filter(Boolean).join(" ・ "))}</p>
      <div class="race-facts"><div>出走<b>${runners.length || r.field || "-"}頭</b></div><div>想定ペース<b>${a ? esc(a.paceForecast) : "-"}</b></div><div>${done ? "状態" : a?.hasOdds ? "オッズ" : "出馬表"}<b>${done ? "発走済み" : r.card_at ? hhmm(r.card_at) : "-"}</b></div></div>
      <p class="fine">出典: JRA 公式サイト ・ ${r.card_at ? `${mdw(new Date(+r.card_at + 9 * 3600e3).toISOString().slice(0, 10))} ${hhmm(r.card_at)} 時点のデータ。` : ""}${done ? "発走後のオッズで計算した振り返りです" : "レース当日は 20 分ごとに自動で更新します"}</p>
    </div>
    ${w ? `<div class="wx-box">${icon(w.icon || "cloud")}<div><b>${w.temperatureC.toFixed(1)}°</b><span class="muted">${esc(w.description)} ・ 推定 ${COND[w.trackCondition][0]}</span></div></div>` : ""}`;
  if (!a) {
    const msg = `<p class="muted">出馬表はまだ発表されていません。発表されると自動で表示されます。</p>`;
    $("#mc").innerHTML = msg;
    $("#mc-meta").textContent = "";
    $("#bets").innerHTML = "";
    $("#entry-table").innerHTML = "";
    $("#outlook").hidden = true;
    return;
  }
  $$("#mc-pace button").forEach((x) => x.classList.toggle("on", +x.dataset.pace === a.paceValue));
  state.mcPace = a.paceValue;
  renderLiveBets(a);
  renderOutlook(a);
  renderMonteCarlo();
  renderEntries();
}

// 予想の見解: 印の馬を推す理由 (特徴量と市場との比較から自動で作る文章) と、7 つの買い方の的中率・回収率。
const MARK_CLASS = { "◎": "m1", "◯": "m2", "▲": "m3", "△": "m4" };
function renderOutlook(a) {
  const box = $("#outlook");
  box.hidden = !a?.live || !a.orders;
  if (box.hidden) return;
  const H = a.race.horses;
  const p = a.predictions.map((x) => x.winProbability / 100);
  const cm = commentary({ horses: H, f: a.f, p, q: a.market, pace: { value: a.paceValue, name: a.paceForecast }, race: a.cond });
  $("#outlook-meta").textContent = a.done ? "発走済み (振り返り)" : "";
  $("#outlook-pace").textContent = cm.pace;
  $("#outlook-picks").innerHTML = cm.picks
    .map(({ index, mark, reasons }) => {
      const h = H[index];
      return `<div class="pick"><span class="mark ${MARK_CLASS[mark]}">${mark}</span>${wakuBadge(h.horseNumber, h.postPosition)}<b>${esc(h.name)}</b><span class="muted num">${h.odds ? `${h.odds}倍・${h.popularity}番人気` : ""}</span>
        <ul>${reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul></div>`;
    })
    .join("");
  $("#outlook-danger").innerHTML = cm.danger.length
    ? `<p class="note warn">${icon("info")}<span><b>危険な人気馬</b> ${cm.danger.map((d) => `${esc(H[d.index].name)}: ${esc(d.text)}`).join(" / ")}</span></p>`
    : "";
  const order = p.map((_, i) => i).sort((i, j) => p[j] - p[i]);
  const plans = strategies(a.orders, H.length, order, a.market, H.map((h) => h.odds || 0));
  const num = (i) => H[i].horseNumber;
  const combo = (t) => t.picks.map(num).join(BET[t.type].ordered ? "→" : "-");
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const best = plans.filter((x) => x.returnRate > 1).sort((x, y) => y.returnRate - x.returnRate)[0];
  const safest = [...plans].sort((x, y) => y.hitRate - x.hitRate)[0];
  $("#plan-verdict").innerHTML = !a.hasOdds
    ? "オッズの発表前なので、的中率だけを表示しています。"
    : best
      ? `${icon("lightbulb")}<span>おすすめは <b>${esc(best.name)}</b> (${best.points}点・的中率 ${pct(best.hitRate)}・回収率 ${pct(best.returnRate)})。</span>`
      : `${icon("lightbulb")}<span>どの買い方も回収率が 100% を下回るので、<b>見送り</b> が予想上の最善です。楽しむなら的中率の高い <b>${esc(safest.name)}</b> (的中率 ${pct(safest.hitRate)}) が損をしにくい買い方です。</span>`;
  $("#plan-table").innerHTML = `<thead><tr><th>買い方</th><th>タイプ</th><th>点数</th><th>買い目</th><th>的中率</th><th>回収率</th></tr></thead><tbody>${plans
    .map(
      (x) => `<tr class="${x === best ? "best" : ""}"><td><b>${esc(x.name)}</b></td><td>${esc(x.style)}</td><td class="num">${x.points}</td>
      <td class="num combos">${x.tickets.map((t) => `${combo(t)}<small>${a.hasOdds ? ` ${t.odds}倍${t.estimated ? "*" : ""}` : ""}</small>`).join("<br>")}</td>
      <td class="num">${pct(x.hitRate)}<div class="bar"><i style="width:${x.hitRate * 100}%"></i></div></td>
      <td class="num ${a.hasOdds && x.returnRate > 1 ? "plus" : ""}">${a.hasOdds ? pct(x.returnRate) : "-"}</td></tr>`,
    )
    .join("")}</tbody>`;
}

// 出馬表 → サンプルと同じ形の「分析」 (renderMonteCarlo / renderEntries / raceToSim がそのまま使える)。
// 勝率は Zig のモンテカルロ (想定ペースで 100,000 回) で出し、印と買い目をそこから決める。
function liveAnalysis(r, runners) {
  const hd = r.card.header;
  const cond = { surface: hd.surface || r.surface, distance: hd.distance || r.distance };
  const z = state.engines.zig;
  const { f, pace, p: winP } = modelProbs(z, runners, cond);
  const horses = runners.map((x, i) => ({
    horseNumber: x.num,
    postPosition: x.waku,
    name: x.name,
    sire: x.sire,
    damSire: x.damSire,
    sexAge: x.sexAge,
    weightCarry: x.carry,
    horseWeight: x.bodyWeight,
    weightDiff: x.weightDiff,
    jockey: x.jockey,
    trainer: x.trainer,
    odds: x.odds,
    popularity: x.pop,
    speedIndex: Math.round(f[i].mu * 1000) / 10,
    runningStyle: Object.keys(STYLE_CODE)[f[i].style],
    coat: coatName(x.color),
    past: x.past,
  }));
  const win = winP.map((v) => v * 100);
  // 組み合わせ馬券 (馬連・3連単など) の確率用に、毎回の 1〜3 着も記録する (2 万回)
  const orders = z ? simulateOrders(z, Math.min(18, horses.length), pace.value, 20000) : null;
  const max = Math.max(...win, 1e-9);
  const order = win.map((w, i) => i).sort((i, j) => win[j] - win[i]);
  const marks = ["◎", "◯", "▲", "△", "△"];
  const predictions = horses.map((h, i) => ({
    horseNumber: h.horseNumber,
    winProbability: win[i],
    totalScore: Math.round((win[i] / max) * 100),
    mark: marks[order.indexOf(i)] || "",
  }));
  const market = marketProbs(horses.map((h) => h.odds || 0));
  return {
    live: true,
    orders,
    f,
    cond,
    hasOdds: horses.some((h) => h.odds),
    takeout: market.takeout,
    market: market.probs,
    race: {
      name: hd.name || r.name,
      racecourse: r.venueName,
      courseType: cond.surface === "ダート" ? "DIRT" : "TURF",
      distanceMeters: cond.distance,
      horses,
    },
    paceForecast: pace.name,
    paceValue: pace.value,
    predictions,
  };
}

// 買い目: 予想勝率 p と単勝オッズ O で期待値 pO が 1 を超える馬だけ、ケリー基準 (1/4) で配分する。
// 超える馬がいなければ「見送り」。控除率 (約 20%) のぶん、市場より大きく見ている馬にしか印が付かない。
function renderLiveBets(a) {
  if (!a.hasOdds) {
    $("#bets").innerHTML = `<p class="muted">オッズの発表前です。発表されると自動で買い目を計算します。</p>`;
    return;
  }
  const rows = a.race.horses
    .map((h, i) => {
      const p = a.predictions[i].winProbability / 100;
      return { h, p, q: a.market[i], ev: p * (h.odds || 0), k: kelly(p, h.odds || 0) };
    })
    .filter((x) => x.k > 0)
    .sort((x, y) => y.k - x.k)
    .slice(0, 3);
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const head = `${a.done ? `<p class="note">このレースは発走済みです。以下は発走後のオッズで計算した振り返りです。</p>` : ""}<p class="fine">控除率 ${a.takeout != null ? pct(a.takeout) : "-"} (オッズから逆算)。期待値 = 予想勝率 × オッズ が 1 を超える馬だけを買います。</p>`;
  if (!rows.length) {
    $("#bets").innerHTML = `${head}<div class="bet"><span class="type">見送り</span><span class="combo">-</span><span class="alloc">0%</span><p>期待値が 1 を超える馬がいません。このレースは買わないのが予想上の最善です。</p></div>`;
    return;
  }
  const total = rows.reduce((s, x) => s + x.k, 0);
  $("#bets").innerHTML =
    head +
    rows
      .map(
        (x) =>
          `<div class="bet"><span class="type">単勝</span><span class="combo">${x.h.horseNumber} ${esc(x.h.name)}</span><span class="alloc">${Math.round((x.k / total) * 100)}%</span><p>予想勝率 ${pct(x.p)} ・ 市場 ${pct(x.q)} ・ 期待値 ${x.ev.toFixed(2)} ・ ${x.h.odds}倍 ・ 資金の ${pct(x.k)} (ケリーの 1/4)</p></div>`,
      )
      .join("");
}

// 出馬表がまだ 1 つもない (開催の前の月〜木曜など) とき: 次の開催日と重賞を出し、予想の欄は隠す。
// 出馬表が発表されると Worker が自動で取り込むので、2 分ごとに確かめて、届いたら画面を作り直す。
function showNextMeeting(days) {
  const next = days?.[0];
  $("#race-tabs").hidden = true;
  [$("#mc").closest(".grid-2"), $("#entry-table").closest(".card"), $("#race-to-sim").closest(".actions")].forEach((el) => (el.style.display = "none"));
  $("#race-hero").innerHTML = next
    ? `<div><div class="race-meta"><span>次の開催</span><span class="num">${mdw(next.date)}</span></div>
      <h2>${next.graded.length ? next.graded.map((g) => `${gradeBadge(g.grade)} ${esc(g.name)}`).join(" ・ ") : esc(next.meetings.join(" ・ "))}</h2>
      <p class="muted">${esc(next.meetings.join(" ・ "))}</p>
      <p class="fine">出馬表とオッズは JRA から発表され次第 (ふつうは開催の前々日の午後)、自動でここに表示されます。</p></div>`
    : `<div><h2>出馬表を準備しています</h2><p class="muted">JRA 公式サイトから自動で取り込み中です。</p></div>`;
  const timer = setInterval(async () => {
    const live = await api("/api/live/races").catch(() => null);
    if (!live?.races?.length) return;
    clearInterval(timer);
    renderSchedule(api("/api/live/schedule").catch(() => null));
    [$("#mc").closest(".grid-2"), $("#entry-table").closest(".card"), $("#race-to-sim").closest(".actions")].forEach((el) => (el.style.display = ""));
    setupLive(live);
  }, 120_000);
}

// これからの開催 (今日から 10 週間)。開催場と重賞を日ごとに並べ、出馬表がある日は押すとその日を開く。
async function renderSchedule(promise) {
  const days = await promise;
  if (!days?.length) {
    $("#schedule").innerHTML = `<p class="muted">${days ? "開催日程を取り込み中です。数分後に自動で表示されます。" : "この環境では開催日程を表示できません (Cloudflare 版のみ)。"}</p>`;
    return;
  }
  $("#schedule").innerHTML = days
    .map(
      (d) => `<${d.hasRaces ? `button type="button" data-date="${d.date}"` : "div"} class="sched-day">
      <span class="sched-date num">${mdw(d.date)}</span>
      <span class="sched-venues">${d.meetings.map((m) => `<span class="chip">${esc(m)}</span>`).join("")}</span>
      <span class="sched-graded">${d.graded.map((g) => `<span>${gradeBadge(g.grade)}${esc(g.name)}<small>${esc(g.venue)}</small></span>`).join("")}</span>
      ${d.hasRaces ? `<span class="sched-go">出馬表${icon("chevron-right")}</span>` : ""}
    </${d.hasRaces ? "button" : "div"}>`,
    )
    .join("");
  $$("#schedule button[data-date]").forEach((b) =>
    b.addEventListener("click", () => {
      if (!state.live) return;
      pickLive(b.dataset.date, state.live.venue);
      $("#live-pick").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
    }),
  );
}

// 脚質の英語名 → Zig に渡す番号 (0 逃げ / 1 先行 / 2 差し / 3 追込)。
// TRAINING は調教評価 → スタミナ (0〜1) への換算表。
const STYLE_CODE = { NIGE: 0, SENKO: 1, SASHI: 2, OIKOMI: 3 };
const TRAINING = { S: 1.0, "A+": 0.9, A: 0.8, B: 0.65, C: 0.5 };

async function loadRace(id) {
  const a = (state.race = await api(`/api/races/${id}/analysis`));
  $("#outlook").hidden = true; // 見解は JRA の実際のレースだけ
  const r = a.race,
    w = r.weather;
  $("#race-hero").innerHTML = `<div>
      <div class="race-meta">${gradeBadge(r.grade === "G1" ? "GI" : r.grade)}<span>${esc(r.racecourse)}</span><span>${r.courseType === "TURF" ? "芝" : "ダート"} ${r.distanceMeters}m</span><span>${esc(r.turnDirection)}</span><span class="num">発走 ${esc(r.postTime)}</span></div>
      <h2>${esc(r.name)}</h2><p class="muted">${esc(r.subtitle)}</p>
      <div class="race-facts"><div>1着賞金<b>${(r.prizeFirstYen / 1e8).toFixed(0)}億円</b></div><div>出走<b>${r.horses.length}頭</b></div><div>想定ペース<b>${esc(a.paceForecast)}</b></div></div>
    </div>
    ${w ? `<div class="wx-box">${icon(w.weatherIcon)}<div><b>${w.temperatureC.toFixed(1)}°</b><span class="muted">${esc(w.weatherDescription)} ・ 推定 ${COND[r.condition][0]}${w.isLive ? "" : " (推定値)"}</span></div></div>` : ""}`;
  $("#bets").innerHTML = a.betRecommendations
    .map(
      (b) =>
        `<div class="bet"><span class="type">${esc(b.betType)}</span><span class="combo">${esc(b.combination)}</span><span class="alloc">${b.allocationPercent}%</span><p>${esc(b.reason)} ・ 想定 ${b.oddsEstimate}倍</p></div>`,
    )
    .join("");
  renderMonteCarlo();
  renderEntries();
}

// Zig の WebAssembly で同じレースを 100,000 回走らせて、勝率と 3 着以内率を棒グラフにする。
// seed (20261109) を固定しているので、同じ条件なら毎回同じ結果になる。
// 棒の長さは「3 着以内率の最大値」を 100% としてそろえる。
function renderMonteCarlo() {
  const z = state.engines.zig,
    a = state.race;
  if (!a) return;
  if (!z) {
    $("#mc").innerHTML =
      `<p class="muted">計算エンジン (Zig) を読み込めませんでした</p>`;
    return;
  }
  const list = a.race.horses.slice(0, 18);
  list.forEach((h, i) =>
    z.set_horse(
      i,
      h.speedIndex,
      TRAINING[h.trainingScore] ?? 0.7,
      STYLE_CODE[h.runningStyle] ?? 2,
    ),
  );
  const t0 = performance.now();
  z.simulate(list.length, 100000, state.mcPace, 20261109);
  const ms = performance.now() - t0;
  const rows = list
    .map((h, i) => ({ h, w: z.win_rate(i), p: z.place_rate(i) }))
    .sort((x, y) => y.w - x.w);
  const max = Math.max(...rows.map((r) => r.p), 1);
  $("#mc").innerHTML = rows
    .map(
      (
        r,
      ) => `<div class="mc-row">${wakuBadge(r.h.horseNumber, r.h.postPosition)}<span class="n">${esc(r.h.name)}</span>
    <div class="mc-track"><i class="p" style="width:${(r.p / max) * 100}%"></i><i class="w" style="width:${(r.w / max) * 100}%"></i></div>
    <span class="v">${r.w.toFixed(1)}%<small>${r.p.toFixed(1)}%</small></span></div>`,
    )
    .join("");
  $("#mc-meta").textContent =
    `100,000 回の計算に ${ms.toFixed(0)} ms (Zig → WebAssembly)`;
}

// 出馬表。「妙味」は C の WebAssembly (calculate_ev_index) で、勝率とオッズから期待値の目安を計算する。
// 読み込めていなければサーバーが計算した値を使う。
function renderEntries() {
  const a = state.race;
  if (!a) return;
  const c = state.engines.c;
  const pred = new Map(a.predictions.map((p) => [p.horseNumber, p]));
  const rows = a.race.horses.map((h) => {
    const p = pred.get(h.horseNumber);
    const ev =
      c && p && h.odds
        ? c.calculate_ev_index(h.odds, p.winProbability)
        : (p?.expectedValueScore ?? 0);
    return { h, p, ev };
  });
  const by = {
    num: (x, y) => x.h.horseNumber - y.h.horseNumber,
    score: (x, y) => (y.p?.totalScore ?? 0) - (x.p?.totalScore ?? 0),
    odds: (x, y) => (x.h.odds || 1e9) - (y.h.odds || 1e9),
    ev: (x, y) => y.ev - x.ev,
  };
  rows.sort(by[state.raceSort]);
  const markColor = (m) =>
    ({
      "◎": "var(--danger)",
      "◯": "var(--g1)",
      "▲": "var(--warn)",
      "☆": "var(--accent)",
    })[m] || "var(--ink-3)";
  $("#entry-table").innerHTML =
    `<thead><tr><th></th><th>馬番</th><th>印</th><th>馬名</th><th>性齢・斤量</th><th>騎手</th><th>単勝</th><th>指数</th><th>脚質</th><th>評価</th></tr></thead><tbody>${rows
      .map(({ h, p, ev }) => {
        const fav = state.user?.favoriteHorses?.includes(h.name);
        return `<tr>
      <td><button class="star ${fav ? "on" : ""}" type="button" data-fav="${esc(h.name)}" aria-label="お気に入り">${icon("star")}</button></td>
      <td>${wakuBadge(h.horseNumber, h.postPosition)}</td>
      <td class="mark" style="color:${markColor(p?.mark)}">${esc(p?.mark || "")}</td>
      <td><strong>${esc(h.name)}</strong><span class="sub">${esc(h.sire)} × ${esc(h.damSire)}</span></td>
      <td>${esc(h.sexAge)} ・ <span class="num">${h.weightCarry}</span><span class="sub num">${h.horseWeight ? `${h.horseWeight}kg${h.weightDiff != null ? ` (${h.weightDiff >= 0 ? "+" : ""}${h.weightDiff})` : ""}` : "馬体重 発表前"}</span></td>
      <td>${esc(h.jockey)}<span class="sub">${esc(h.trainer)}</span></td>
      <td class="num"><strong>${h.odds ?? "-"}</strong><span class="sub">${h.popularity ? `${h.popularity}番人気` : ""}</span></td>
      <td class="num">${h.speedIndex}</td>
      <td>${STYLE_NAMES[STYLE_CODE[h.runningStyle]] || ""}</td>
      <td><div class="num" style="display:flex;justify-content:space-between;gap:8px;font-size:12px"><strong>${p ? p.totalScore : "-"}</strong><span class="muted">妙味 ${ev.toFixed(0)}</span></div><div class="bar"><i style="width:${p ? p.totalScore : 0}%"></i></div></td>
    </tr>`;
      })
      .join("")}</tbody>`;
  $$("#entry-table [data-fav]").forEach((b) =>
    b.addEventListener("click", () => toggleFavorite(b.dataset.fav)),
  );
}

const COURSE_BY_SHORT = (s) => state.courses.find((c) => c.short === s);

// レース予想の出走馬を、そのまま 3D シミュレーションの出走表にする。
// 名鑑に同じ名前の馬がいれば毛色を使う (いなければ鹿毛)。
// スピードはサンプル出馬表のスピード指数をそのまま使う (effectiveSpeed の f.speed)。
async function raceToSim() {
  const r = state.race?.race;
  if (!r) return;
  const course = COURSE_BY_SHORT(r.racecourse);
  // 名鑑にいれば毛色・写真を使う
  const looked = await Promise.all(
    r.horses.map((h) =>
      api(`/api/horses?q=${encodeURIComponent(h.name)}&limit=5&photo=0`)
        .then((p) => p.items.find((v) => v.horse.name === h.name))
        .catch(() => null),
    ),
  );
  state.field = r.horses.slice(0, 18).map((h, i) => ({
    key: h.name,
    name: h.name,
    title: looked[i]?.horse.title,
    coat: h.coat || looked[i]?.horse.color || "鹿毛",
    rating: Math.round(55 + (h.speedIndex - 100) * 2),
    speed: h.speedIndex,
    style: STYLE_CODE[h.runningStyle] ?? 2,
    stamina: TRAINING[h.trainingScore] ?? 0.7,
    num: h.horseNumber,
    waku: h.postPosition,
  }));
  // 本物の馬番・枠のまま走らせる (テンプレートと同じ扱い。馬を足したり外したりすると 1 から振り直す)
  state.template = { title: r.name, sub: `${r.racecourse} ${r.courseType === "TURF" ? "芝" : "ダート"}${r.distanceMeters}m`, sig: fieldSig(), replay: null, on: false };
  if ($("#tpl-banner")) renderTemplateBanner();
  presetSim({
    course: course?.id,
    distance: r.distanceMeters,
    surface: r.courseType === "TURF" ? "芝" : "ダート",
    pace: a2pace(state.race.paceForecast),
  });
  location.hash = "#/sim";
}
const a2pace = (s) =>
  s === "ハイペース" ? "1.2" : s === "スローペース" ? "0.8" : "1.0";

// はじめての競馬 (チュートリアル)。中身は learn.js
init.learn = () => import("./learn.js").then((m) => m.renderLearn());

/* ============================================================
   予想の成績 (過去のレースで、予想モデルがどれだけ当たったか)
   ============================================================ */
// Worker が集めた過去のレース (結果 + レース前の出馬表) を、レース予想と同じモデルで予想し直し、
// 実際の着順・払戻金と比べる。予想に使うのは発走前に分かる情報 (確定オッズと過去 4 走) だけ。
const SERIES = [
  { key: "honmei", name: "◎の単勝", cls: "s1" },
  { key: "app", name: "アプリの買い目", cls: "s2" },
  { key: "fav", name: "1番人気の単勝", cls: "s3" },
];
init.results = async () => {
  const data = await api("/api/live/results").catch(() => null);
  if (!data) {
    $("#res-stats").innerHTML = `<p class="muted">この環境では表示できません (Cloudflare 版のデータが必要です)。</p>`;
    return;
  }
  if (!data.length) {
    $("#res-stats").innerHTML = `<p class="muted">答え合わせ用の過去のレースを、JRA 公式サイトから自動で集めています。1 分に 1 件ずつなので、最初の結果が出るまで数十分かかります。</p>`;
    return;
  }
  $("#res-stats").innerHTML = `<p class="muted">${data.length} レースを予想し直しています</p>`;
  const z = state.engines.zig;
  const rows = [];
  for (let k = 0; k < data.length; k++) {
    const e = evalRace(z, data[k]);
    if (e) rows.push(e);
    if (k % 20 === 19) await new Promise((r) => setTimeout(r)); // 画面を固めない
  }
  rows.sort((a, b) => a.r.date.localeCompare(b.r.date) || a.r.id.localeCompare(b.r.id));
  state.resRows = rows;
  renderResults();
  $$("#res-filter button").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#res-filter button").forEach((x) => x.classList.toggle("on", x === b));
      renderResTable(b.dataset.f);
    }),
  );
};

function evalRace(z, r) {
  const { result: res, card } = r;
  const out = new Set(res.order.filter((o) => /取消|除外/.test(o.status)).map((o) => o.num));
  const runners = card.runners.filter((x) => !x.scratched && x.num && !out.has(x.num));
  if (runners.length < 4 || !res.payouts?.win?.length) return null;
  const cond = { surface: card.header.surface, distance: card.header.distance };
  const { p } = modelProbs(z, runners, cond, 20000);
  const order = p.map((_, i) => i).sort((i, j) => p[j] - p[i]);
  const num = (i) => runners[i].num;
  const placeOf = new Map(res.order.map((o) => [o.num, o.place]));
  const odds = runners.map((x) => x.odds || 0);
  const fav = odds.reduce((b, o, i) => (o && (b < 0 || o < odds[b]) ? i : b), -1);
  const q = marketProbs(odds).probs;
  const win = (i) => (i >= 0 ? payoutOf(res.payouts, "win", [num(i)]) : 0);
  const plans = planTickets(order).map((pl) => ({
    name: pl.name,
    cost: pl.tickets.length * 100,
    back: pl.tickets.reduce((s, [type, picks]) => s + payoutOf(res.payouts, type, picks.map(num)), 0),
  }));
  const evPicks = runners.map((_, i) => i).filter((i) => odds[i] && kelly(p[i], odds[i]) > 0);
  plans.push({ name: "アプリの買い目 (期待値 1 超えの単勝)", cost: evPicks.length * 100, back: evPicks.reduce((s, i) => s + win(i), 0) });
  plans.push({ name: "1番人気の単勝 (比較用)", cost: fav >= 0 ? 100 : 0, back: win(fav) });
  const w = runners.findIndex((x) => placeOf.get(x.num) === 1);
  const ll = (v) => -Math.log(Math.max(v, 1e-4));
  return {
    r, runners, order, p, placeOf, fav, plans,
    profit: { honmei: plans[0].back - plans[0].cost, app: plans.at(-2).back - plans.at(-2).cost, fav: plans.at(-1).back - plans.at(-1).cost },
    winner: w, llModel: w >= 0 ? ll(p[w]) : null, llMarket: w >= 0 ? ll(q[w]) : null,
  };
}

function renderResults() {
  const rows = state.resRows;
  const n = rows.length;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  const rate = (f) => rows.filter(f).length / n;
  const at = (e, i) => (i >= 0 ? e.placeOf.get(e.runners[i].num) : null);
  const ll = rows.filter((e) => e.llModel != null);
  const mean = (k) => ll.reduce((s, e) => s + e[k], 0) / Math.max(1, ll.length);
  const tile = (label, value, sub) => `<div class="stat card"><span class="label">${label}</span><b class="num">${value}</b><span class="fine">${sub}</span></div>`;
  $("#res-stats").innerHTML = [
    tile("検証したレース", `${n}`, `${esc(rows[0].r.date)} 〜 ${esc(rows[n - 1].r.date)}`),
    tile("◎ の勝率", pct(rate((e) => at(e, e.order[0]) === 1)), `1番人気は ${pct(rate((e) => at(e, e.fav) === 1))}`),
    tile("◎ の 3 着以内率", pct(rate((e) => (at(e, e.order[0]) ?? 99) <= 3)), `1番人気は ${pct(rate((e) => (at(e, e.fav) ?? 99) <= 3))}`),
    tile("予想の精度 (対数損失)", mean("llModel").toFixed(3), `市場 (オッズ) は ${mean("llMarket").toFixed(3)}。小さいほど正確`),
  ].join("");
  $("#res-count").textContent = `${n} レース`;
  // 買い方ごとの合計
  const names = rows[0].plans.map((x) => x.name);
  const sums = names.map((name, k) => {
    const list = rows.map((e) => e.plans[k]).filter((x) => x.cost);
    const cost = list.reduce((s, x) => s + x.cost, 0), back = list.reduce((s, x) => s + x.back, 0);
    return { name, races: list.length, hit: list.filter((x) => x.back > 0).length, cost, back };
  });
  $("#res-plans").innerHTML = `<thead><tr><th>買い方</th><th>買ったレース</th><th>的中率</th><th>投資</th><th>払戻</th><th>回収率</th></tr></thead><tbody>${sums
    .map((x) => `<tr><td><b>${esc(x.name)}</b></td><td class="num">${x.races}</td><td class="num">${x.races ? pct(x.hit / x.races) : "-"}</td>
      <td class="num">${yen(x.cost)}</td><td class="num">${yen(x.back)}</td><td class="num ${x.back > x.cost ? "plus" : "minus"}">${x.cost ? `${((x.back / x.cost) * 100).toFixed(0)}%` : "-"}</td></tr>`)
    .join("")}</tbody>`;
  renderResChart(rows);
  renderResTable("all");
}

// 累積収支の折れ線 (3 本)。凡例と線の端のラベルで見分けられるようにし、ホバーで各レースの値を出す。
function renderResChart(rows) {
  const W = 760, H = 240, L = 56, R = 120, T = 14, B = 26;
  const cum = SERIES.map((s) => {
    let v = 0;
    return [0, ...rows.map((e) => (v += e.profit[s.key]))];
  });
  const all = cum.flat();
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  const x = (i) => L + (i / Math.max(1, rows.length)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - T - B);
  const ticks = [lo, 0, hi].filter((v, i, a) => a.indexOf(v) === i);
  const fmt = (v) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(Math.round(v)).toLocaleString()}円`;
  // 線の端のラベルが重ならないよう、近すぎるものは縦にずらす
  const ends = cum.map((c, k) => ({ k, y: y(c.at(-1)) })).sort((a, b) => a.y - b.y);
  ends.forEach((e, i) => { if (i && e.y - ends[i - 1].y < 14) e.y = ends[i - 1].y + 14; });
  $("#res-chart").innerHTML = `<div class="legend">${SERIES.map((s) => `<span><i class="sw ${s.cls}"></i>${s.name}</span>`).join("")}</div>
    <div class="chart-box"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="累積収支の推移 (1 レース 100 円ずつ)">
      ${ticks.map((v) => `<line class="${v === 0 ? "zero" : "grid"}" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="axis" x="${L - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v)}</text>`).join("")}
      ${cum.map((c, k) => `<polyline class="line ${SERIES[k].cls}" points="${c.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ")}"/>`).join("")}
      ${ends.map((e) => `<text class="end" x="${W - R + 6}" y="${e.y + 4}">${SERIES[e.k].name} ${fmt(cum[e.k].at(-1))}</text>`).join("")}
      <line class="cross" id="res-cross" y1="${T}" y2="${H - B}" visibility="hidden"/>
      <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}"/>
    </svg><div class="tip" id="res-tip" hidden></div></div>`;
  const svg = $("#res-chart svg"), tip = $("#res-tip"), cross = $("#res-cross");
  const move = (ev) => {
    const box = svg.getBoundingClientRect();
    const px = ((ev.clientX - box.left) / box.width) * W;
    const i = Math.max(1, Math.min(rows.length, Math.round(((px - L) / (W - L - R)) * rows.length)));
    const e = rows[i - 1];
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.innerHTML = `<b>${esc(e.r.date)} ${esc(e.r.venueName)}${e.r.race_no}R ${esc(e.r.name)}</b>${SERIES.map((s, k) => `<span><i class="sw ${s.cls}"></i>${s.name} <b class="num">${fmt(cum[k][i])}</b></span>`).join("")}`;
    const left = (x(i) / W) * box.width;
    tip.style.left = `${Math.min(left + 12, box.width - tip.offsetWidth - 4)}px`;
  };
  svg.addEventListener("pointermove", move);
  svg.addEventListener("pointerleave", () => { tip.hidden = true; cross.setAttribute("visibility", "hidden"); });
}

function renderResTable(filter) {
  const rows = [...state.resRows].reverse().filter((e) =>
    filter === "graded" ? /G/.test(e.r.grade) : filter === "hit" ? (e.placeOf.get(e.runners[e.order[0]].num) ?? 99) <= 3 : true,
  );
  const cell = (e, i, mark) => {
    if (i == null || i < 0) return "-";
    const h = e.runners[i], pl = e.placeOf.get(h.num);
    return `${mark ? `<span class="mark ${MARK_CLASS[mark]}">${mark}</span>` : ""}${esc(h.name)}<span class="sub">${h.pop ?? "-"}番人気 → <b class="${pl && pl <= 3 ? "plus" : ""}">${pl ? `${pl}着` : "-"}</b></span>`;
  };
  const money = (v) => `<span class="${v > 0 ? "plus" : v < 0 ? "minus" : ""}">${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toLocaleString()}</span>`;
  $("#res-table").innerHTML = `<thead><tr><th>日付</th><th>レース</th><th>◎</th><th>◯</th><th>1番人気</th><th>勝ち馬</th><th>単勝</th><th>◎の単勝</th><th>アプリの買い目</th></tr></thead><tbody>${rows
    .slice(0, 300)
    .map((e) => {
      const wi = e.winner;
      return `<tr><td class="num">${esc(e.r.date.slice(5).replace("-", "/"))}</td><td>${gradeBadge(e.r.grade)} ${esc(e.r.venueName)}${e.r.race_no}R<span class="sub">${esc(e.r.name)}</span></td>
      <td>${cell(e, e.order[0], "◎")}</td><td>${cell(e, e.order[1], "◯")}</td><td>${cell(e, e.fav)}</td>
      <td>${wi >= 0 ? `${esc(e.runners[wi].name)}<span class="sub">${e.runners[wi].pop ?? "-"}番人気</span>` : "-"}</td>
      <td class="num">${(e.r.result.payouts.win[0]?.yen ?? 0).toLocaleString()}円</td>
      <td class="num">${money(e.profit.honmei)}</td><td class="num">${e.plans.at(-2).cost ? money(e.profit.app) : `<span class="muted">見送り</span>`}</td></tr>`;
    })
    .join("") || `<tr><td colspan="9" class="muted">該当するレースがありません</td></tr>`}</tbody>`;
}

/* ============================================================
   AI 予想 (画面の中身は ai.js)
   ============================================================ */
init.ai = () => initAi({ state, openHorse, sendToSim: aiToSim });

// AI 予想の上位の馬 (最大 18 頭) を 3D シミュレーションの出走表にする。
// 名鑑にいる馬は能力値・適性・毛色をそのまま使い、いない馬は AI の勝率から仮の能力値を作る
// (勝率 0% → 55、20% → 85 くらい。上限 95)。JRA の出馬表から予想したときは毛色も出馬表のものを使う。
async function aiToSim({ picks, venue, surface, distance }) {
  const list = picks.slice(0, 18);
  const views = await Promise.all(
    list.map((p) =>
      p.libraryTitle
        ? api(`/api/horses/detail?title=${encodeURIComponent(p.libraryTitle)}`)
            .then((d) => d.view)
            .catch(() => null)
        : null,
    ),
  );
  state.field = list.map((p, i) => {
    const v = views[i];
    if (v)
      return {
        key: v.horse.title,
        title: v.horse.title,
        name: v.horse.name,
        coat: p.coat || v.horse.color,
        rating: v.rating,
        surface: v.surface,
        bestDistance: v.bestDistance,
        style: defaultStyle(v),
        stamina: 0.8,
      };
    return {
      key: `ai-${i}-${p.horse}`,
      name: p.horse,
      coat: p.coat || "鹿毛",
      rating: Math.round(Math.min(95, 55 + (p.winProb || 0) * 1.5)),
      style: [1, 2, 1, 2, 3, 0][i % 6],
      stamina: 0.8,
    };
  });
  presetSim({
    course: COURSE_BY_SHORT(venue)?.id,
    distance: distance || undefined,
    surface: surface || undefined,
  });
  location.hash = "#/sim";
}

/* ============================================================
   3D シミュレーション
   ============================================================ */
// 名鑑の馬には脚質のデータがないので、仮の脚質を決める (画面で変更できる)。
// 得意距離が短い馬は先行、長い馬は差し。分からない馬は名前から計算した数で振り分ける
// (毎回同じ馬が同じ脚質になるように、乱数ではなく名前のハッシュ値を使う)。
function defaultStyle(v) {
  const d = v.bestDistance;
  if (d && d < 1500) return 1;
  if (d && d > 2300) return 2;
  let hsh = 0;
  for (const ch of v.horse.title) hsh = (hsh * 31 + ch.charCodeAt(0)) | 0;
  const x = Math.abs(hsh) % 100;
  return x < 12 ? 0 : x < 52 ? 1 : x < 85 ? 2 : 3;
}
// 名鑑の馬を出走表に追加する。最大 18 頭 (フルゲート)、同じ馬は 2 回入れない。
function addToField(v) {
  if (state.field.length >= 18) {
    toast("出走できるのは18頭までです");
    return;
  }
  if (state.field.some((f) => f.title === v.horse.title)) {
    toast(`${v.horse.name} はすでに出走表にいます`);
    return;
  }
  state.field.push({
    key: v.horse.title,
    title: v.horse.title,
    name: v.horse.name,
    coat: v.horse.color,
    rating: v.rating,
    surface: v.surface,
    bestDistance: v.bestDistance,
    style: defaultStyle(v),
    stamina: 0.8,
  });
  renderField();
  toast(`${v.horse.name} を追加しました`);
}

// シミュレーション画面の出走表。脚質を変えたり馬を外したりしたら、すぐにレースを組み直す。
// 2 頭以上いないとスタートできない。
// 出走表の i 番目の馬番と枠。実際のレースのテンプレートなら本物の馬番・枠 (取消があると番号が飛ぶ)、それ以外は 1 から順番
const fieldNum = (i) => state.field[i]?.num ?? i + 1;
const fieldWaku = (i) => state.field[i]?.waku ?? wakuOf(i + 1, state.field.length);

function renderField() {
  const n = state.field.length;
  $("#sim-count").textContent = `${n} / 18`;
  $("#sim-field").innerHTML =
    state.field
      .map(
        (f, i) => `<li>
    ${wakuBadge(fieldNum(i), fieldWaku(i))}<span class="nm" title="${esc(f.name)}">${esc(f.name)}</span>
    <select data-style="${i}" aria-label="${esc(f.name)} の脚質">${STYLE_NAMES.map((s, k) => `<option value="${k}" ${k === f.style ? "selected" : ""}>${s}</option>`).join("")}</select>
    <button type="button" data-remove="${i}" aria-label="外す">${icon("x")}</button></li>`,
      )
      .join("") ||
    `<li class="muted" style="grid-template-columns:1fr">まだ出走馬がいません</li>`;
  $$("#sim-field [data-style]").forEach((s) =>
    s.addEventListener("change", () => {
      state.field[+s.dataset.style].style = +s.value;
      prepareSim();
    }),
  );
  $$("#sim-field [data-remove]").forEach((b) =>
    b.addEventListener("click", () => {
      state.field.splice(+b.dataset.remove, 1);
      renderField();
      prepareSim();
    }),
  );
  $("#sim-start").disabled = n < 2;
}

// シミュレーションの条件を外から設定する (競走一覧・競馬場・レース予想から呼ばれる)。
// シミュレーション画面がまだ一度も開かれていない (選択肢が作られていない) ときは、
// いったん state.preset に預けて、init.sim の中で適用する。
function presetSim(preset = {}) {
  if (!$("#sim-course").options.length) {
    state.preset = preset;
    return;
  } // シミュレーション画面の初期化後に適用
  const { course, distance, surface, pace } = preset;
  if (course) $("#sim-course").value = course;
  if (distance) $("#sim-distance").value = distance;
  if (surface) $("#sim-surface").value = surface;
  if (pace) $("#sim-pace").value = pace;
  renderField();
  prepareSim();
}

// 能力値 45〜99 → スピード 92〜120 (レース予想のスピード指数とだいたい同じ範囲) に換算し、
// 得意でない馬場なら -4、得意距離から 250m 離れるごとに -1 (最大 -6) する。
/** 能力値と、距離・馬場の向き不向きから Zig に渡す「スピード」を作る */
function effectiveSpeed(f, distance, surface) {
  if (f.speed) return f.speed;
  let s = 70 + f.rating * 0.5;
  if (f.surface && f.surface !== "不明" && !f.surface.includes(surface)) s -= 4;
  if (f.bestDistance)
    s -= Math.min(6, Math.abs(distance - f.bestDistance) / 250);
  return s;
}

// 条件や出走馬が変わるたびにレースを組み直す。
//   1. Zig の race_once で各馬の「その日の出来」を計算 (毎回違う seed なので毎回違う展開)
//   2. 枠番・勝負服の色を決めて、3D シーンを作り直す (sim.setup)
// prepareToken: 3D の準備を待っている間に次の変更が来たら、古いほうの処理は途中で捨てる。
// Zig が読み込めなかったときは、JS の乱数で代わりの「出来」を作る。
let prepareToken = 0;
let gameOrders = null;
async function prepareSim() {
  if (!state.sim) return;
  const token = ++prepareToken;
  await state.simReady;
  if (token !== prepareToken || state.field.length < 2) return;
  const course =
    state.courses.find((c) => c.id === $("#sim-course").value) ||
    state.courses[0];
  const distance = Math.max(
    200,
    Math.min(4000, +$("#sim-distance").value || 2000),
  );
  const surface = $("#sim-surface").value;
  const pace = +$("#sim-pace").value;
  const z = state.engines.zig;
  const n = state.field.length;
  const seed = (Math.random() * 2 ** 31) | 0;
  let scores;
  const tpl = state.template;
  if (tpl && tpl.sig !== fieldSig()) {
    // テンプレートから馬を足したり外したりしたら、ふつうのレースに戻す (馬番も 1 から振り直す)
    state.field.forEach((f) => { delete f.num; delete f.waku; });
    state.template = null;
    renderField();
    renderTemplateBanner();
  }
  if (z) {
    state.field.forEach((f, i) =>
      z.set_horse(
        i,
        effectiveSpeed(f, distance, surface),
        f.stamina ?? 0.8,
        f.style,
      ),
    );
    z.race_once(n, pace, seed);
    scores = state.field.map((_, i) => z.race_score(i));
    // 予想ゲームのオッズ用に、同じ条件で 2 万回走らせた 1〜3 着を記録 (上の 1 回分の結果とは別の乱数)
    gameOrders = simulateOrders(z, n, pace, 20000, (seed ^ 0x5bd1e995) >>> 0);
  } else {
    const rnd = seeded(seed);
    scores = state.field.map(
      (f) => effectiveSpeed(f, distance, surface) / 100 + (rnd() - 0.5) * 0.2,
    );
  }
  const field = state.field.map((f, i) => {
    const waku = fieldWaku(i);
    return {
      name: f.name,
      coat: f.coat,
      style: f.style,
      num: fieldNum(i),
      waku,
      silk: wakuCss(waku) || "#ffffff",
    };
  });
  const replay = state.template?.replay && state.template.on;
  if (replay) scores = state.template.replay; // 本物の着順とタイム差
  state.lastReplay = replay ? state.template : null;
  state.sim.setup({ course, distance, surface, field, scores });
  gamePrepared(z ? gameOrders : null);
  state.lastSim = {
    courseId: course.id,
    course: course.short,
    distance: course.category === "ばんえい" ? 200 : distance,
    surface: course.category === "ばんえい" ? "ばんえい" : surface,
  };
  $("#sim-result").hidden = true;
  $("#sim-hud").hidden = false;
  $("#hud-course").textContent =
    `${course.short} ${course.category === "ばんえい" ? "ばんえい 200m" : `${surface}${distance}m`}`;
  updateHud({
    order: field.map((_, i) => i),
    remain: course.category === "ばんえい" ? 200 : distance,
    t: 0,
  });
}

/* ---------- テンプレート (実際のレース・名馬の夢の対決) ---------- */
// 実際のレース: Worker が集めた過去の JRA のレース (結果つき) と、今週の出馬表。
//   競馬場・距離・馬場・出走馬・馬番・毛色・脚質は本物。能力 (スピード) はレース予想と同じモデルで出馬表から計算する。
//   「実際の結果を再現」を選ぶと、乱数の代わりに本物の着順と走破タイムの差で走らせる。
// 名馬の夢の対決: 名鑑の「主な勝ち鞍」から、同じ GI を勝った馬を集めて、そのレースの舞台で走らせる。
const DREAM = [
  { title: "歴代の日本ダービー馬", races: ["東京優駿"], course: "tokyo", distance: 2400, surface: "芝" },
  { title: "歴代の有馬記念馬", races: ["有馬記念"], course: "nakayama", distance: 2500, surface: "芝" },
  { title: "歴代のジャパンカップ馬", races: ["ジャパンカップ", "ジャパンC"], course: "tokyo", distance: 2400, surface: "芝" },
  { title: "歴代の天皇賞 (秋) 馬", races: ["天皇賞（秋）"], course: "tokyo", distance: 2000, surface: "芝" },
  { title: "歴代の天皇賞 (春) 馬", races: ["天皇賞（春）"], course: "kyoto", distance: 3200, surface: "芝" },
  { title: "歴代の宝塚記念馬", races: ["宝塚記念"], course: "hanshin", distance: 2200, surface: "芝" },
  { title: "歴代の皐月賞馬", races: ["皐月賞"], course: "nakayama", distance: 2000, surface: "芝" },
  { title: "歴代の菊花賞馬", races: ["菊花賞"], course: "kyoto", distance: 3000, surface: "芝" },
  { title: "歴代の桜花賞馬", races: ["桜花賞"], course: "hanshin", distance: 1600, surface: "芝" },
  { title: "歴代のオークス馬", races: ["優駿牝馬"], course: "tokyo", distance: 2400, surface: "芝" },
  { title: "歴代の安田記念馬", races: ["安田記念"], course: "tokyo", distance: 1600, surface: "芝" },
  { title: "歴代のスプリンターズS 馬", races: ["スプリンターズS", "スプリンターズステークス"], course: "nakayama", distance: 1200, surface: "芝" },
  { title: "歴代のフェブラリーS 馬", races: ["フェブラリーS", "フェブラリーステークス"], course: "tokyo", distance: 1600, surface: "ダート" },
  { title: "歴代の東京大賞典馬", races: ["東京大賞典"], course: "ohi", distance: 2000, surface: "ダート" },
  { title: "三冠馬の対決", races: ["皐月賞"], all: ["皐月賞", "東京優駿", "菊花賞"], course: "tokyo", distance: 2400, surface: "芝", note: "皐月賞・日本ダービー・菊花賞をすべて勝った馬" },
  { title: "牝馬三冠馬の対決", races: ["桜花賞"], all: ["桜花賞", "優駿牝馬", "秋華賞"], course: "kyoto", distance: 2000, surface: "芝", note: "桜花賞・オークス・秋華賞をすべて勝った馬" },
  { title: "グランプリ制覇の馬", races: ["有馬記念"], all: ["有馬記念", "宝塚記念"], course: "nakayama", distance: 2500, surface: "芝", note: "有馬記念と宝塚記念の両方を勝った馬" },
];
const fieldSig = () => state.field.map((f) => f.name).join("|");
const toSeconds = (t) => {
  const m = /^(?:(\d+):)?(\d+(?:\.\d+)?)$/.exec(t || "");
  return m ? (+m[1] || 0) * 60 + +m[2] : null;
};

async function openTemplates() {
  openSheet(`<div class="tpl"><p class="eyebrow">Templates</p><h2>テンプレートから選ぶ</h2>
    <div class="seg small" id="tpl-tabs"><button data-t="real" class="on" type="button">実際のレース</button><button data-t="dream" type="button">名馬の夢の対決</button></div>
    <div id="tpl-list"><p class="muted">読み込み中</p></div></div>`);
  const show = async (t) => {
    $$("#tpl-tabs button").forEach((b) => b.classList.toggle("on", b.dataset.t === t));
    $("#tpl-list").innerHTML = t === "real" ? await realTemplatesHtml() : dreamTemplatesHtml();
    $$("#tpl-list [data-res]").forEach((b) => b.addEventListener("click", () => loadResultTemplate(b.dataset.res)));
    $$("#tpl-list [data-live]").forEach((b) => b.addEventListener("click", () => loadLiveTemplate(b.dataset.live)));
    $$("#tpl-list [data-dream]").forEach((b) => b.addEventListener("click", () => loadDreamTemplate(DREAM[+b.dataset.dream])));
  };
  $$("#tpl-tabs button").forEach((b) => b.addEventListener("click", () => show(b.dataset.t)));
  show("real");
}

let tplResults = null; // 過去のレース (一度読んだら使い回す)
async function realTemplatesHtml() {
  tplResults ??= await api("/api/live/results?limit=120").catch(() => []);
  const live = await api("/api/live/races").catch(() => null);
  const card = (attr, id, top, title, sub) =>
    `<button type="button" class="tpl-card" ${attr}="${esc(id)}"><span class="fine">${top}</span><b>${title}</b><span class="muted">${sub}</span></button>`;
  const past = tplResults
    .slice()
    .sort((a, b) => (/G/.test(b.grade) ? 1 : 0) - (/G/.test(a.grade) ? 1 : 0) || b.date.localeCompare(a.date))
    .map((r) => {
      const win = r.result.order.find((o) => o.place === 1);
      const h = r.card.header;
      return card("data-res", r.id, `${esc(r.date.replaceAll("-", "/"))} ${esc(r.venueName)} ${r.race_no}R`, `${gradeBadge(r.grade)} ${esc(r.name || h.name)}`,
        `${esc((h.surface || "").split(/\s/)[0])}${h.distance}m ・ ${r.card.runners.length}頭${win ? ` ・ 勝ち馬は ${win.pop ?? "-"}番人気` : ""}`); // 馬名は出さない (予想ゲームのネタバレになるため)
    });
  const week = (live?.races || [])
    .filter((r) => r.hasCard && r.date >= jstNow()[0])
    .sort((a, b) => (GRADE_RANK[b.grade] ?? 0) - (GRADE_RANK[a.grade] ?? 0) || a.date.localeCompare(b.date))
    .slice(0, 24)
    .map((r) => card("data-live", r.id, `${mdw(r.date)} ${esc(r.venueName)} ${r.race_no}R ・ これから`, `${gradeBadge(r.grade)} ${esc(r.name)}`, `${esc(r.surface)}${r.distance ?? ""}m ・ ${r.field ?? "-"}頭`));
  return `
    ${week.length ? `<h3 class="sub-title">今週のレース (出馬表)</h3><p class="fine">本物の出走馬で、予想 (乱数) どおりに走らせます。</p><div class="tpl-grid">${week.join("")}</div>` : ""}
    <h3 class="sub-title">過去のレース (結果つき)</h3>
    <label class="check"><input type="checkbox" id="tpl-replay" checked> 実際の結果を再現する (本物の着順とタイム差で走らせる)</label>
    ${past.length ? `<div class="tpl-grid">${past.join("")}</div>` : `<p class="muted">過去のレースを JRA 公式サイトから自動で集めています。しばらくすると表示されます。</p>`}
    <p class="fine">出典: JRA 公式サイト。能力はレース予想と同じモデルで、レース前の出馬表 (過去 4 走) から計算しています。勝負服の柄は馬名から自動で決めたもので、実際の馬主の服色ではありません。</p>`;
}

function dreamTemplatesHtml() {
  return `<p class="fine">競走馬名鑑の「主な勝ち鞍」から、同じ GI を勝った馬を能力値の高い順に最大 18 頭集め、そのレースの舞台で走らせます。年代の違う名馬どうしの、実際にはなかった対決です。</p>
    <div class="tpl-grid">${DREAM.map((d, i) => {
      const c = state.courses.find((x) => x.id === d.course);
      return `<button type="button" class="tpl-card" data-dream="${i}"><span class="fine">${esc(c?.short ?? "")} ${d.surface}${d.distance}m</span><b>${esc(d.title)}</b><span class="muted">${esc(d.note ?? `${d.races[0]} を勝った馬`)}</span></button>`;
    }).join("")}</div>`;
}

// 実際のレースの出馬表 → 出走表。取消・除外は外す。脚質と能力はレース予想と同じモデル
function fieldFromCard(card, cond, out = new Set()) {
  const runners = card.runners.filter((x) => !x.scratched && x.num && !out.has(x.num)).slice(0, 18);
  return runners.map((x) => {
    const f = features(x, cond);
    return { key: x.name, name: x.name, coat: coatName(x.color), speed: Math.round(f.mu * 1000) / 10, style: f.style, stamina: 0.7, num: x.num, waku: x.waku };
  });
}
function applyTemplate({ title, sub, course, distance, surface, field, replay = null, real = null }) {
  state.field = field;
  state.template = { title, sub, sig: fieldSig(), replay, real, on: !!replay };
  closeSheet();
  renderTemplateBanner();
  presetSim({ course, distance, surface, pace: "1.0" });
  toast(`${title} を読み込みました`);
}

function loadResultTemplate(id) {
  const r = tplResults.find((x) => x.id === id);
  if (!r) return;
  const h = r.card.header;
  const cond = { surface: h.surface === "ダート" ? "ダート" : "芝", distance: h.distance };
  const out = new Set(r.result.order.filter((o) => /取消|除外/.test(o.status)).map((o) => o.num));
  const field = fieldFromCard(r.card, cond, out);
  // 本物の走破タイム → 「出来」。3D は T = 基準 × (1 + (1着の出来 − 出来) × 0.12) なので、
  // 出来 = 1 − (タイム ÷ 1着のタイム − 1) ÷ 0.12 とすれば、タイムの比が本物と同じになる。同タイムは着順で並べる
  const byNum = new Map(r.result.order.map((o) => [o.num, o]));
  const times = field.map((f) => toSeconds(byNum.get(f.num)?.time));
  const best = Math.min(...times.filter((t) => t != null));
  const worst = Math.max(...times.filter((t) => t != null));
  const replay = field.map((f, i) => {
    const o = byNum.get(f.num);
    const t = times[i] ?? worst + 3; // 競走中止などタイムのない馬は最後に
    return 1 - (t / best - 1) / 0.12 - (o?.place ?? 99) * 1e-5;
  });
  const wantReplay = $("#tpl-replay")?.checked ?? true;
  const real = new Map(r.result.order.map((o) => [o.num, { time: o.time, margin: o.margin }]));
  applyTemplate({
    title: `${r.name || h.name}`,
    sub: `${r.date.replaceAll("-", "/")} ${r.venueName} ${(h.surface || "").split(/\s/)[0]}${h.distance}m`,
    course: COURSE_BY_SHORT(r.venueName)?.id,
    distance: h.distance,
    surface: cond.surface,
    field,
    replay: Number.isFinite(best) ? replay : null,
    real,
  });
  if (!wantReplay && state.template) { state.template.on = false; renderTemplateBanner(); prepareSim(); }
}

async function loadLiveTemplate(id) {
  const r = await api(`/api/live/race?id=${encodeURIComponent(id)}`).catch(() => null);
  if (!r?.card) return toast("出馬表を読み込めませんでした");
  const h = r.card.header;
  const cond = { surface: (h.surface || r.surface) === "ダート" ? "ダート" : "芝", distance: h.distance || r.distance };
  applyTemplate({ title: h.name || r.name, sub: `${r.date.replaceAll("-", "/")} ${r.venueName} ${cond.surface}${cond.distance}m (これから)`, course: COURSE_BY_SHORT(r.venueName)?.id, distance: cond.distance, surface: cond.surface, field: fieldFromCard(r.card, cond) });
}

async function loadDreamTemplate(d) {
  const pages = await Promise.all(d.races.map((q) => api(`/api/horses?q=${encodeURIComponent(q)}&limit=200&sort=rating`).catch(() => ({ items: [] }))));
  const isGI = (w) => /^(G|Jpn)I$/.test(w.grade);
  const won = (v, race) => v.horse.bigWins.some((w) => w.race === race && isGI(w));
  const seen = new Set();
  const list = pages
    .flatMap((p) => p.items)
    .filter((v) => !seen.has(v.horse.title) && seen.add(v.horse.title))
    .filter((v) => (d.all ? d.all.every((r) => won(v, r)) : d.races.some((r) => won(v, r))))
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 18);
  if (list.length < 2) return toast("名鑑に該当する馬が 2 頭以上いません");
  applyTemplate({
    title: d.title,
    sub: `${state.courses.find((c) => c.id === d.course)?.short ?? ""} ${d.surface}${d.distance}m ・ ${list.length}頭`,
    course: d.course,
    distance: d.distance,
    surface: d.surface,
    field: list.map((v) => ({ key: v.horse.title, title: v.horse.title, name: v.horse.name, coat: v.horse.color, rating: v.rating, surface: v.surface, bestDistance: v.bestDistance, style: defaultStyle(v), stamina: 0.8 })),
  });
}

// 選んでいるテンプレートの表示と、「実際の結果を再現 / 予想 (乱数) で走らせる」の切り替え
function renderTemplateBanner() {
  const t = state.template, el = $("#tpl-banner");
  el.hidden = !t;
  if (!t) return;
  el.innerHTML = `<div><b>${esc(t.title)}</b><span class="fine">${esc(t.sub)}</span></div>
    ${t.replay ? `<div class="seg small" role="radiogroup" aria-label="走らせ方"><button type="button" data-rp="1" class="${t.on ? "on" : ""}">実際の結果を再現</button><button type="button" data-rp="0" class="${t.on ? "" : "on"}">予想 (乱数) で走らせる</button></div>` : ""}
    <button type="button" class="tpl-clear" aria-label="テンプレートをやめる">${icon("x")}</button>`;
  $$("#tpl-banner [data-rp]").forEach((b) =>
    b.addEventListener("click", () => {
      t.on = b.dataset.rp === "1";
      renderTemplateBanner();
      prepareSim();
    }),
  );
  $("#tpl-banner .tpl-clear").addEventListener("click", () => {
    state.field.forEach((f) => { delete f.num; delete f.waku; });
    state.template = null;
    renderTemplateBanner();
    renderField();
    prepareSim();
  });
}

/* ---------- 予想ゲーム (仮想のお金で馬券を買い、3D のレース結果で払い戻す) ---------- */
// 所持金と通算成績はこのブラウザの中だけに保存する (localStorage。使えない環境ではページを閉じるまで)。
const GAME_KEY = "kv-game";
const game = { wallet: 10000, races: 0, spent: 0, back: 0, best: 0, type: "win", sel: [], slip: [], orders: null, n: 0, locked: false };
try {
  Object.assign(game, JSON.parse(localStorage.getItem(GAME_KEY) || "{}"));
} catch {}
game.slip = [];
game.sel = [];
const saveGame = () => {
  try {
    // まだ結果の出ていない馬券の代金は、所持金に戻した額で保存する (途中でページを閉じても失わないように)
    const { races, spent, back, best } = game;
    const wallet = game.wallet + game.slip.reduce((s, t) => s + t.amount, 0);
    localStorage.setItem(GAME_KEY, JSON.stringify({ wallet, races, spent, back, best }));
  } catch {}
};
const yen = (v) => `${Math.round(v).toLocaleString()}円`;

function setupGame() {
  $("#bet-type").innerHTML = BET_TYPES.map((b) => `<button type="button" data-type="${b.key}" class="${b.key === game.type ? "on" : ""}">${b.name}</button>`).join("");
  $$("#bet-type button").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#bet-type button").forEach((x) => x.classList.toggle("on", x === b));
      game.type = b.dataset.type;
      game.sel = [];
      renderGame();
    }),
  );
  $("#bet-add").addEventListener("click", buyTicket);
  $("#bet-amount").addEventListener("input", renderGame);
  renderGame();
}

// 出走表や条件が変わってレースが組み直されたら、オッズが変わるので、まだ走っていない馬券は取り消して返金する
function gamePrepared(orders) {
  if (game.slip.length) {
    game.wallet += game.slip.reduce((s, t) => s + t.amount, 0);
    game.slip = [];
    saveGame();
    toast("条件が変わったので、買った馬券を取り消して返金しました");
  }
  game.orders = orders;
  game.n = state.field.length;
  game.sel = game.sel.filter((i) => i < game.n);
  lockGame(false);
}

function lockGame(on) {
  game.locked = on;
  $("#game")?.classList.toggle("locked", on);
  renderGame();
}

const gameOdds = (type, picks) => oddsFrom(probOf(game.orders, game.n, type, picks), BET[type].takeout);

function renderGame() {
  if (!$("#game")) return;
  const bt = BET[game.type];
  $("#game-wallet").textContent = `所持金 ${yen(game.wallet)}`;
  $("#bet-rule").textContent = `${bt.name}: ${bt.rule}${bt.ordered ? "。1着から順に選んでください" : ""}`;
  const ready = !!game.orders && !game.locked && game.n === state.field.length;
  // 馬のボタン (単勝オッズと、モデルの印を添える)
  const win = ready ? state.field.map((_, i) => probOf(game.orders, game.n, "win", [i])) : [];
  const rank = win.map((_, i) => i).sort((i, j) => win[j] - win[i]);
  const marks = ["◎", "◯", "▲"];
  $("#bet-horses").innerHTML = state.field
    .map((f, i) => {
      const k = game.sel.indexOf(i);
      const m = marks[rank.indexOf(i)];
      return `<button type="button" data-i="${i}" class="${k >= 0 ? "on" : ""}" ${ready ? "" : "disabled"} aria-pressed="${k >= 0}">
        ${wakuBadge(fieldNum(i), fieldWaku(i))}<span class="nm">${esc(f.name)}</span>
        <span class="od num">${ready ? `${gameOdds("win", [i])}倍` : ""}</span>${m ? `<span class="mk ${MARK_CLASS[m]}" title="モデルの印">${m}</span>` : ""}
        ${k >= 0 && bt.ordered ? `<span class="ord">${k + 1}着</span>` : ""}</button>`;
    })
    .join("");
  $$("#bet-horses button").forEach((b) =>
    b.addEventListener("click", () => {
      const i = +b.dataset.i;
      const k = game.sel.indexOf(i);
      if (k >= 0) game.sel.splice(k, 1);
      else if (game.sel.length < bt.picks) game.sel.push(i);
      else game.sel = [...game.sel.slice(1), i]; // いっぱいなら古い選択を外す
      renderGame();
    }),
  );
  const full = game.sel.length === bt.picks;
  const amount = Math.floor((+$("#bet-amount").value || 0) / 100) * 100;
  $("#bet-pick").innerHTML = full
    ? `<b>${bt.name} ${game.sel.map(fieldNum).join(bt.ordered ? " → " : " - ")}</b> <span class="num">${gameOdds(game.type, game.sel)}倍</span>`
    : `あと ${bt.picks - game.sel.length} 頭選んでください`;
  $("#bet-add").disabled = !ready || !full || amount < 100 || amount > game.wallet;
  $("#bet-slip").innerHTML = game.slip
    .map(
      (t, k) => `<li><span>${BET[t.type].name} ${t.picks.map(fieldNum).join(BET[t.type].ordered ? "→" : "-")}</span>
      <span class="num">${t.odds}倍 × ${yen(t.amount)}</span>${game.locked ? "" : `<button type="button" data-rm="${k}" aria-label="取り消す">${icon("x")}</button>`}</li>`,
    )
    .join("");
  $$("#bet-slip [data-rm]").forEach((b) =>
    b.addEventListener("click", () => {
      const [t] = game.slip.splice(+b.dataset.rm, 1);
      game.wallet += t.amount;
      saveGame();
      renderGame();
    }),
  );
}

function buyTicket() {
  const bt = BET[game.type];
  const amount = Math.floor((+$("#bet-amount").value || 0) / 100) * 100;
  if (game.locked || !game.orders || game.sel.length !== bt.picks || amount < 100 || amount > game.wallet) return;
  game.slip.push({ type: game.type, picks: [...game.sel], amount, odds: gameOdds(game.type, game.sel) });
  game.wallet -= amount;
  game.sel = [];
  saveGame();
  renderGame();
  toast(`${bt.name}を ${yen(amount)} 買いました`);
}

// ゴールしたら払い戻す (払戻 = 金額 × オッズ。JRA と同じく 10 円未満は切り捨て)。結果の欄に追加する HTML を返す
function settleGame(results) {
  if (!game.slip.length) return `<p class="fine game-hint">${icon("ticket")}スタート前に右の「予想ゲーム」で馬券を買うと、当たったかどうかと払戻がここに出ます。</p>`;
  const top3 = results.slice(0, 3).map((r) => r.index);
  let spent = 0, back = 0;
  const rows = game.slip.map((t) => {
    const hit = hits(t.type, t.picks, top3, game.n);
    const pay = hit ? Math.floor((t.amount * t.odds) / 10) * 10 : 0;
    spent += t.amount;
    back += pay;
    return `<li class="${hit ? "hit" : ""}">${icon(hit ? "circle-check" : "circle-x")}<span>${BET[t.type].name} ${t.picks.map(fieldNum).join(BET[t.type].ordered ? "→" : "-")}</span><span class="num">${hit ? `+${yen(pay)}` : `−${yen(t.amount)}`}</span></li>`;
  });
  game.wallet += back;
  game.races += 1;
  game.spent += spent;
  game.back += back;
  game.best = Math.max(game.best, back);
  game.slip = [];
  saveGame();
  lockGame(false);
  const diff = back - spent;
  return `<div class="game-result"><h3>${back ? "的中!" : "はずれ"}</h3><ul class="game-tickets">${rows.join("")}</ul>
    <p class="num"><b class="${diff >= 0 ? "plus" : "minus"}">収支 ${diff >= 0 ? "+" : "−"}${yen(Math.abs(diff))}</b> ・ 所持金 ${yen(game.wallet)}</p>
    <p class="fine">通算 ${game.races} レース ・ 回収率 ${game.spent ? ((game.back / game.spent) * 100).toFixed(0) : 0}% ・ 最高払戻 ${yen(game.best)}</p>
    ${game.wallet < 100 ? `<button class="btn ghost small" id="game-reset" type="button">${icon("refresh-cw")}所持金を 10,000円 に戻す</button>` : ""}</div>`;
}

function resetWallet() {
  Object.assign(game, { wallet: 10000, races: 0, spent: 0, back: 0, best: 0 });
  saveGame();
  renderGame();
  $("#game-reset")?.remove();
  toast("所持金を 10,000円 に戻しました");
}

// 左上の順位表 (HUD)。毎フレーム HTML を作り直すと重いので、0.12 秒に 1 回だけ更新する
// (force = true のときは必ず更新。ゴールした瞬間など)。
let hudAt = 0;
function updateHud({ order, remain, t }, force) {
  const now = performance.now();
  if (!force && now - hudAt < 120) return;
  hudAt = now;
  const n = state.field.length;
  $("#hud-remain").textContent =
    remain > 0 ? `残り ${Math.ceil(remain / 10) * 10}m` : "ゴール";
  $("#hud-clock").textContent =
    `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;
  $("#hud-order").innerHTML = order
    .slice(0, 18)
    .map(
      (i, k) =>
        `<li><span class="pos">${k + 1}</span>${wakuBadge(i + 1, wakuOf(i + 1, n))}<span class="nm">${esc(state.field[i]?.name || "")}</span></li>`,
    )
    .join("");
}

// 結果パネル。1 着は走破タイム、2 着以下は前の馬との着差を表示する。
// 「もう一度」は新しい展開で、「リプレイ」は同じ展開でもう一度走らせる。
function showResult(results) {
  $("#sim-result").innerHTML =
    `<h3>結果</h3><ol class="result-list">${results.map((r, k) => `<li><span class="pos">${k + 1}</span>${wakuBadge(r.num, r.waku)}<span>${esc(r.name)}</span><span class="gap">${state.lastReplay?.real?.get(r.num) ? esc(k === 0 ? state.lastReplay.real.get(r.num).time : state.lastReplay.real.get(r.num).margin) : k === 0 ? `${Math.floor(r.time / 60)}:${(r.time % 60).toFixed(1).padStart(4, "0")}` : esc(r.margin)}</span></li>`).join("")}</ol>
    <div class="btn-row"><button class="btn primary small" id="sim-again" type="button">${icon("refresh-cw")}もう一度 (別の展開)</button><button class="btn ghost small" id="sim-replay" type="button">${icon("rotate-ccw")}リプレイ</button></div>`;
  if (state.lastReplay)
    $("#sim-result").insertAdjacentHTML("beforeend", `<p class="fine replay-note">${icon("info")}${esc(state.lastReplay.title)} の実際の着順とタイム差で再現しました (出典: JRA 公式サイト)。</p>`);
  $("#sim-result").insertAdjacentHTML("beforeend", settleGame(results));
  $("#sim-result").hidden = false;
  $("#game-reset")?.addEventListener("click", resetWallet);
  $("#sim-again").onclick = async () => {
    await prepareSim();
    $("#sim-result").hidden = true;
    lockGame(true);
    state.sim.start();
  };
  $("#sim-replay").onclick = () => {
    $("#sim-result").hidden = true;
    state.sim.start(); // リプレイは同じ結果なので、馬券は買えない (払戻も済んでいる)
  };
}

// 3D シミュレーション画面の準備。
// three.js は大きい (約 700KB) ので、この画面を初めて開いたときにだけ読み込む (import())。
// 出走馬がいなければ「名馬でおまかせ」で 14 頭を自動で選ぶ。
init.sim = async () => {
  $("#sim-course").innerHTML = ["中央", "地方", "ばんえい"]
    .map(
      (cat) =>
        `<optgroup label="${cat}">${state.courses
          .filter((c) => c.category === cat)
          .map((c) => `<option value="${c.id}">${esc(c.name)}</option>`)
          .join("")}</optgroup>`,
    )
    .join("");
  $("#sim-course").value = "tokyo";
  if (state.preset) {
    const p = state.preset;
    state.preset = null;
    if (p.course) $("#sim-course").value = p.course;
    if (p.distance) $("#sim-distance").value = p.distance;
    if (p.surface) $("#sim-surface").value = p.surface;
    if (p.pace) $("#sim-pace").value = p.pace;
  }
  ["#sim-course", "#sim-distance", "#sim-surface", "#sim-pace"].forEach((s) =>
    $(s).addEventListener("change", prepareSim),
  );
  $("#sim-course").addEventListener("change", () => {
    const c = state.courses.find((x) => x.id === $("#sim-course").value);
    if (c && !c.surfaces.includes("芝")) $("#sim-surface").value = "ダート";
  });
  $("#sim-start").addEventListener("click", () => {
    $("#sim-result").hidden = true;
    lockGame(true);
    state.sim.start();
  });
  setupGame();
  $("#tpl-open").addEventListener("click", openTemplates);
  $("#sim-clear").addEventListener("click", () => {
    state.field = [];
    renderField();
  });
  $("#sim-auto").addEventListener("click", autoField);
  $$("#sim-cams [data-cam]").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#sim-cams [data-cam]").forEach((x) =>
        x.classList.toggle("on", x === b),
      );
      state.sim.setCamera(b.dataset.cam);
    }),
  );
  $$("#sim-cams [data-speed]").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#sim-cams [data-speed]").forEach((x) =>
        x.classList.toggle("on", x === b),
      );
      state.sim.setSpeed(+b.dataset.speed);
    }),
  );
  setupSuggest();
  renderField();

  const { RaceSim } = await import("./sim3d.js");
  state.sim = new RaceSim($("#sim-canvas"), {
    onFrame: (f) => updateHud(f),
    onFinish: (r) => {
      updateHud(
        { order: r.map((x) => x.index), remain: 0, t: r[r.length - 1].time },
        true,
      );
      showResult(r);
      saveSim(r);
    },
    onLost: () => {
      $("#sim-loading").textContent =
        "3D 描画が中断されました。ページを再読み込みしてください";
      $("#sim-loading").classList.remove("done");
    },
  });
  state.sim.setVisible(true);
  state.simReady = state.sim
    .init()
    .then(() => $("#sim-loading").classList.add("done"))
    .catch((e) => {
      console.error(e);
      $("#sim-loading").textContent =
        "3D を表示できませんでした (WebGL に対応したブラウザが必要です)";
    });
  if (state.field.length < 2) await autoField();
  else prepareSim();
};

// 能力値上位 80 頭 (選んだ馬場が得意な馬) からランダムに 14 頭を選ぶ。
async function autoField() {
  const surface = $("#sim-surface").value;
  const page = await api(
    `/api/horses?sort=rating&surface=${encodeURIComponent(surface)}&limit=80`,
  );
  const rnd = seeded(Date.now() & 0xffff);
  const pool = page.items.slice();
  state.field = [];
  while (state.field.length < 14 && pool.length) {
    const v = pool.splice(Math.floor(rnd() * pool.length), 1)[0];
    state.field.push({
      key: v.horse.title,
      title: v.horse.title,
      name: v.horse.name,
      coat: v.horse.color,
      rating: v.rating,
      surface: v.surface,
      bestDistance: v.bestDistance,
      style: defaultStyle(v),
      stamina: 0.8,
    });
  }
  renderField();
  prepareSim();
}

// 「名鑑から馬を追加」の入力補完。↑↓ で候補を選び、Enter で追加、Esc で閉じる。
// クリックは mousedown で拾う (click だと、入力欄の blur で候補が先に消えてしまうため)。
function setupSuggest() {
  const input = $("#sim-search"),
    list = $("#sim-suggest");
  let items = [],
    active = -1;
  const show = () => {
    list.innerHTML = items
      .map(
        (v, i) =>
          `<li data-i="${i}" class="${i === active ? "on" : ""}"><span>${esc(v.horse.name)}</span><small>${esc([v.horse.birthYear, v.horse.sex, v.rating].filter(Boolean).join(" ・ "))}</small></li>`,
      )
      .join("");
    list.hidden = !items.length;
  };
  const pick = (i) => {
    if (items[i]) {
      addToField(items[i]);
      prepareSim();
      input.value = "";
      items = [];
      show();
    }
  };
  input.addEventListener(
    "input",
    debounce(async () => {
      const q = input.value.trim();
      if (!q) {
        items = [];
        show();
        return;
      }
      items = (
        await api(`/api/horses?q=${encodeURIComponent(q)}&limit=8&sort=rating`)
      ).items;
      active = -1;
      show();
    }, 200),
  );
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      active = Math.min(items.length - 1, active + 1);
      show();
      e.preventDefault();
    }
    if (e.key === "ArrowUp") {
      active = Math.max(0, active - 1);
      show();
      e.preventDefault();
    }
    if (e.key === "Enter") {
      pick(active < 0 ? 0 : active);
      e.preventDefault();
    }
    if (e.key === "Escape") {
      items = [];
      show();
    }
  });
  list.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li");
    if (li) pick(+li.dataset.i);
  });
  input.addEventListener("blur", () =>
    setTimeout(() => (list.hidden = true), 150),
  );
}

/* ============================================================
   中継
   ============================================================ */
// 中継画面。YouTube の埋め込みプレーヤーで、各競馬場の公式チャンネルを表示する。
//   live   … https://www.youtube.com/embed/live_stream?channel=ID  (配信中のライブ)
//   latest … https://www.youtube.com/embed/videoseries?list=UU...   (チャンネルの最新の動画一覧)
// 「UU + チャンネルIDの3文字目以降」は、そのチャンネルのアップロード動画一覧を表す YouTube の決まり。
let liveCourse = null,
  liveMode = "latest"; // ライブは配信中しか映らないので、既定は最新の映像
init.live = () => {
  $("#live-grid").innerHTML = state.courses
    .map(
      (c) => `<button class="live-item" type="button" data-id="${c.id}">
    <span class="ic">${icon(c.youtubeChannel ? "monitor-play" : "external-link")}</span>
    <span><strong>${esc(c.name)}</strong><small>${esc(c.youtubeLabel)}</small></span></button>`,
    )
    .join("");
  $$("#live-grid .live-item").forEach((b) =>
    b.addEventListener("click", () => playLive(b.dataset.id)),
  );
  $$("#player-mode button").forEach((b) =>
    b.addEventListener("click", () => {
      $$("#player-mode button").forEach((x) =>
        x.classList.toggle("on", x === b),
      );
      liveMode = b.dataset.mode;
      if (liveCourse) playLive(liveCourse);
    }),
  );
};
function playLive(id) {
  if (!views.live?.loaded) {
    views.live = { loaded: true };
    init.live();
  }
  const c = state.courses.find((x) => x.id === id);
  if (!c) return;
  liveCourse = id;
  $$("#live-grid .live-item").forEach((b) =>
    b.classList.toggle("on", b.dataset.id === id),
  );
  $("#player-title").textContent = c.name;
  $("#player-sub").textContent = c.youtubeLabel;
  const ch = c.youtubeChannel;
  $("#player-open").href = ch
    ? `https://www.youtube.com/channel/${ch}/${liveMode === "live" ? "live" : "videos"}`
    : c.website;
  $("#player-mode").hidden = !ch;
  if (!ch) {
    $("#player-frame").innerHTML =
      `<p class="player-empty">${esc(c.name)} は公式サイトでライブ配信しています。「公式で開く」からご覧ください。</p>`;
    return;
  }
  const src =
    liveMode === "live"
      ? `https://www.youtube.com/embed/live_stream?channel=${ch}&autoplay=1&mute=1&playsinline=1`
      : `https://www.youtube.com/embed/videoseries?list=UU${ch.slice(2)}&playsinline=1`;
  $("#player-frame").innerHTML =
    `<iframe src="${src}" title="${esc(c.name)} の映像" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
}

/* ============================================================
   血統 / 品種と毛色 / 払戻計算 / 設定
   ============================================================ */
// 血統画面: Odin の血量計算機と、父系の系統図・解説カード。
init.pedigree = async () => {
  ["#odin-g1", "#odin-g2"].forEach((s) =>
    $(s).addEventListener("input", renderOdin),
  );
  renderOdin();
  const lines = await api("/api/encyclopedia/pedigree");
  $("#lineage-tree").innerHTML = lines
    .map(
      (
        p,
      ) => `<div><span class="tree-root">${esc(p.founder.replace(/\s*\(.*\)/, ""))}<small>${esc(p.name)}</small></span>
    <ul>${p.keyStallions.map((s, i) => `<li>${esc(s)}${p.representativeHorses[i] ? `<span>代表産駒 ${esc(p.representativeHorses[i])}</span>` : ""}</li>`).join("")}</ul></div>`,
    )
    .join("");
  $("#lineage-cards").innerHTML = lines
    .map(
      (
        p,
      ) => `<section class="card lcard"><h3>${esc(p.name)}</h3><p class="muted" style="font-size:13px">始祖 ${esc(p.founder)}</p>
    <dl><dt>芝</dt><dd>${esc(p.turfAptitude)}</dd><dt>ダート</dt><dd>${esc(p.dirtAptitude)}</dd><dt>得意距離</dt><dd>${esc(p.distanceRange)}</dd></dl>
    <p>${esc(p.characteristics)}</p><div class="chips">${p.keyStallions.map((s) => `<span class="chip">${esc(s)}</span>`).join("")}</div></section>`,
    )
    .join("");
};
// 入力が 1〜12 の整数かを確かめてから、Odin の WebAssembly で血量・近交係数・評価を計算する。
function renderOdin() {
  const g1 = parseInt($("#odin-g1").value, 10),
    g2 = parseInt($("#odin-g2").value, 10),
    o = state.engines.odin;
  const out = $("#odin-out");
  if (!(g1 >= 1 && g1 <= 12 && g2 >= 1 && g2 <= 12)) {
    out.innerHTML = `<p class="muted">1〜12 の整数を入れてください</p>`;
    return;
  }
  if (!o) {
    out.innerHTML = `<p class="muted">計算エンジン (Odin) を読み込めませんでした</p>`;
    return;
  }
  const trim = (x) => x.toFixed(4).replace(/\.?0+$/, "");
  const r = o.cross_rating(g1, g2);
  out.innerHTML = `<div class="big">${trim(o.blood_percent(g1, g2))}<small>%</small></div>
    <p class="lbl">${g1}×${g2} の血量 ・ 近交係数 ${trim(o.inbreeding_coefficient(g1, g2))}%</p>
    <span class="tag r${r}">${["弱いクロス", "ほどよいクロス", "濃いクロス"][r]}</span>`;
}

// 品種と毛色の画面。体高くらべのグラフは、いちばん高いものを 160px として高さをそろえる。
// 体高は "160〜170cm" のような文字列なので、中の数字の平均をとる (parseCm)。
init.knowledge = async () => {
  const [breeds, coats] = await Promise.all([
    api("/api/encyclopedia/breeds"),
    api("/api/encyclopedia/coats"),
  ]);
  const parseCm = (s) => {
    const n = (s.match(/\d+/g) || []).map(Number);
    return n.length ? n.reduce((a, b) => a + b) / n.length : 0;
  };
  const items = [
    ...breeds.map((b) => ({
      name: b.name,
      cm: parseCm(b.heightCm),
      art: horseSvg(b.bodyHex, "#2a1d14", b.build, ""),
    })),
    {
      name: "人間",
      cm: 170,
      human: true,
      art: `<svg viewBox="0 0 40 100" style="stroke:none;fill:var(--ink-4)"><circle cx="20" cy="10" r="8"/><path d="M8 22h24l-3 38h-4l-1 38h-6l-1-38h-4z"/></svg>`,
    },
  ];
  const max = Math.max(...items.map((i) => i.cm));
  $("#size-chart").innerHTML = items
    .map(
      (
        it,
        i,
      ) => `<figure class="size-item ${it.human ? "human" : ""}"><div class="art">${it.art}</div>
    <div class="size-bar" style="height:${(it.cm / max) * 160}px;--d:${i * 50}ms">${Math.round(it.cm)}</div><figcaption>${esc(it.name)}</figcaption></figure>`,
    )
    .join("");
  $("#breed-grid").innerHTML = breeds
    .map(
      (
        b,
      ) => `<article class="kcard"><div class="fig">${horseSvg(b.bodyHex, "#2a1d14", b.build, "")}</div>
    <h3>${esc(b.name)}</h3><p class="spec">${esc(b.origin)} ・ 体高 ${esc(b.heightCm)} ・ 体重 ${esc(b.weightKg)}</p><p>${esc(b.description)}</p><p class="spec">用途: ${esc(b.use)}</p></article>`,
    )
    .join("");
  $("#coat-grid").innerHTML = coats
    .map(
      (
        c,
      ) => `<article class="kcard"><div class="fig">${horseSvg(c.bodyHex, c.maneHex, 1, "")}</div>
    <h3>${esc(c.name)}<small>${esc(c.reading)}</small></h3><p>${esc(c.description)}</p><p class="spec">代表馬 ${esc(c.famousHorse)}</p></article>`,
    )
    .join("");
};

// 払戻計算: 払戻金 = オッズ × 購入金額 (10 円単位に丸める)。回収率 = 払戻金 ÷ 購入金額。
init.tools = () => {
  const calc = () => {
    const odds = Math.max(1, parseFloat($("#pay-odds").value) || 1),
      amount = Math.max(100, parseInt($("#pay-amount").value, 10) || 100);
    const pay = Math.round((odds * amount) / 10) * 10,
      profit = pay - amount;
    $("#pay-out").innerHTML =
      `<div class="big num">¥${pay.toLocaleString()}</div><p class="lbl">${esc($("#pay-type").value)} が的中したときの払戻金</p>
      <span class="tag ${profit >= 0 ? "r1" : "r2"}">回収率 ${Math.round((pay / amount) * 100)}% ・ ${profit >= 0 ? "+" : ""}¥${profit.toLocaleString()}</span>`;
  };
  ["#pay-type", "#pay-odds", "#pay-amount"].forEach((s) =>
    $(s).addEventListener("input", calc),
  );
  calc();
};

// 設定画面: テーマ、データの状態と更新、計算エンジンの状態。
// データ更新中は 2 秒ごとにサーバーへ進み具合を問い合わせて表示する。
init.settings = () => {
  syncThemeSeg();
  $$("#theme-seg button").forEach((b) =>
    b.addEventListener("click", () => setTheme(b.dataset.themeSet)),
  );
  const show = (st) => {
    const at = st.generatedAt
      ? new Date(st.generatedAt).toLocaleString("ja-JP")
      : "未取得";
    $("#data-status").textContent = st.syncing
      ? `更新中: ${st.progress}`
      : `競走馬 ${st.horses.toLocaleString()} 頭 (写真 ${st.horsesWithPhoto.toLocaleString()}) ・ 競走 ${st.races} ・ ${at} 時点${st.progress && !st.syncing && st.progress !== "完了" ? ` ・ ${st.progress}` : ""}`;
    $("#data-refresh").disabled = st.syncing;
  };
  const poll = async () => {
    const st = await api("/api/library/status");
    show(st);
    if (st.syncing) setTimeout(poll, 2000);
  };
  $("#data-refresh").addEventListener("click", async () => {
    show(await api("/api/library/refresh", { method: "POST" }));
    setTimeout(poll, 1500);
  });
  poll();
  renderMyData();
};

/** マイデータ (お気に入りとシミュレーション履歴)。D1 に保存できる環境でサインインしているときだけ表示 */
async function renderMyData() {
  const box = $("#mydata");
  box.hidden = !(state.authMode === "firebase" && state.user);
  if (box.hidden) return;
  const favs = state.user.favoriteHorses || [];
  $("#my-favs").innerHTML = favs.length
    ? favs
        .map(
          (f) =>
            `<button class="chip" type="button" data-title="${esc(f)}">${esc(f)}</button>`,
        )
        .join("")
    : `<p class="muted">名鑑やレース予想の ☆ で登録できます</p>`;
  $$("#my-favs [data-title]").forEach((b) =>
    b.addEventListener("click", () => openHorse(b.dataset.title)),
  );
  try {
    const sims = await api("/api/sims");
    $("#my-sims").innerHTML = sims.length
      ? `<ul class="wins-list">${sims
          .map(
            (
              s,
            ) => `<li><span class="muted num">${esc(new Date(s.created_at.replace(" ", "T") + "Z").toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</span>
          <span>${esc(s.course)} ${esc(s.surface)}${s.distance}m</span><span>1着 <strong>${esc(s.result[0]?.name)}</strong></span></li>`,
          )
          .join("")}</ul>`
      : `<p class="muted">3D シミュレーションを走らせると、結果がここに残ります</p>`;
  } catch (_) {
    $("#my-sims").innerHTML = `<p class="muted">読み込めませんでした</p>`;
  }
}

/** 3D シミュレーションの結果を D1 に保存 (サインイン中だけ。失敗しても画面は止めない) */
function saveSim(results) {
  if (state.authMode !== "firebase" || !state.user || !state.lastSim) return;
  api("/api/sims", {
    method: "POST",
    body: JSON.stringify({
      ...state.lastSim,
      result: results.map((r) => ({
        name: r.name,
        num: r.num,
        waku: r.waku,
        time: r.time,
        margin: r.margin,
      })),
    }),
  })
    .then(() => toast("結果を履歴に保存しました"))
    .catch(() => {});
}

/* ============================================================
   アカウント・お気に入り・メモ (デモ)
   ============================================================ */
// サイドメニュー下のアカウント表示 (デモのサインイン)。
function renderAccount() {
  const u = state.user;
  $("#account").hidden = state.authMode === "none"; // サインインできない環境ではボタン自体を出さない
  $("#account").innerHTML = u
    ? `<button type="button" id="logout" title="サインアウト"><img src="${esc(u.avatarUrl)}" alt=""><span>${esc(u.name)}</span></button>`
    : `<button type="button" id="login">${icon("log-in")}<span>サインイン</span></button>`;
  $("#login")?.addEventListener("click", () => $("#login-dialog").showModal());
  $("#logout")?.addEventListener("click", async () => {
    if (state.authMode === "firebase")
      await state.fb.A.signOut(state.fb.auth); // onAuthStateChanged が表示を更新する
    else {
      await api("/api/auth/logout", { method: "POST" }).catch(() => {});
      setUser(null);
    }
    toast("サインアウトしました");
  });
}

/** ユーザーが変わったら、それに関係する表示をまとめて更新 */
function setUser(u) {
  state.user = u;
  renderAccount();
  renderEntries();
  if (views.settings?.loaded) renderMyData();
}

/**
 * サインインの方式を決める。
 *   firebase … /api/config に Firebase の設定がある (Cloudflare Pages 版)。Google でサインインし、データは D1 に保存
 *   demo     … Kotlin のアプリ版。サーバーのメモリに保存するデモ用サインイン
 *   none     … どちらも使えない (Pages 版で Firebase が未設定)
 */
async function initAuth() {
  let cfg;
  try {
    cfg = (await api("/api/config")).firebase;
  } catch (_) {
    cfg = undefined;
  } // Kotlin 版には /api/config がない
  if (cfg === null) {
    state.authMode = "none";
    return;
  }
  if (!cfg) {
    state.authMode = "demo";
    state.user = await api("/api/auth/me").catch(() => null);
    return;
  }
  state.authMode = "firebase";
  const [{ initializeApp }, A] = await Promise.all([
    import(FIREBASE_SDK + "firebase-app.js"),
    import(FIREBASE_SDK + "firebase-auth.js"),
  ]);
  const auth = A.getAuth(initializeApp(cfg));
  state.fb = { auth, A };
  // API を呼ぶたびに最新の ID トークンを付ける (期限が近ければ SDK が自動で更新する)
  setTokenProvider(() => auth.currentUser?.getIdToken() ?? null);
  $("#login-title").textContent = "Google でサインイン";
  $("#login-desc").textContent =
    "お気に入り・予想メモ・シミュレーション履歴をクラウド (Cloudflare D1) に保存し、どの端末からでも見られます。";
  $("#login-go").lastChild.textContent = "Google でサインイン";
  await new Promise((resolve) =>
    A.onAuthStateChanged(auth, async (u) => {
      setUser(u ? await api("/api/auth/me").catch(() => null) : null);
      resolve();
    }),
  );
}
// お気に入りの追加 / 解除。サインインしていなければサインイン画面を出す。
async function toggleFavorite(name) {
  if (!state.user) {
    if (state.authMode !== "none") $("#login-dialog").showModal();
    else toast("この環境ではお気に入りを保存できません");
    return;
  }
  try {
    setUser(
      await api("/api/favorites", {
        method: "POST",
        body: JSON.stringify({ horseName: name }),
      }),
    );
  } catch (_) {
    toast("保存できませんでした");
    return;
  }
  const on = state.user.favoriteHorses.includes(name);
  const btn = $("#fav-btn");
  if (btn) {
    btn.classList.toggle("on", on);
    btn.innerHTML = `${icon("star")}${on ? "お気に入り済み" : "お気に入り"}`;
  }
  toast(on ? "お気に入りに追加しました" : "お気に入りから外しました");
}
function openNote() {
  if (!state.user) {
    if (state.authMode !== "none") $("#login-dialog").showModal();
    else toast("この環境ではメモを保存できません");
    return;
  }
  const id = $("#race-tabs button.on")?.dataset.id;
  $("#note-race").textContent = state.race?.race.name || "";
  $("#note-text").value = state.user.notes?.[id] || "";
  $("#note-dialog").dataset.race = id;
  $("#note-dialog").showModal();
}

/* ============================================================
   起動
   ============================================================ */
// 起動処理。競馬場・計算エンジン・天気・アカウントを同時に読み込み (それぞれ起動演出の進捗に登録)、
// 全部終わってからイベントを登録して最初の画面を表示する。
// 1 つが失敗しても (天気が取れない等) アプリは起動する (Promise.allSettled)。
async function boot() {
  const sp = splash();
  const tasks = [
    sp.track(
      "競馬場を読み込みました",
      api("/api/courses").then((c) => (state.courses = c)),
    ),
    sp.track("計算エンジンを準備しました", loadEngines()),
    sp.track("天気を取得しました", loadWeather()),
    sp.track(
      "アカウントを確認しました",
      initAuth().catch((e) => {
        console.warn("サインインの準備に失敗", e);
        state.authMode = "none";
      }),
    ),
  ];
  await Promise.allSettled(tasks);
  renderAccount();

  $("#theme-switch").addEventListener("click", () =>
    setTheme(
      document.documentElement.dataset.theme === "dark" ? "light" : "dark",
    ),
  );
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    let saved = null;
    try {
      saved = localStorage.getItem("kv-theme");
    } catch (_) {}
    if (!saved) setTheme("auto");
  });
  $$("[data-close]").forEach((el) => el.addEventListener("click", closeSheet));
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#sheet").hidden) closeSheet();
  });
  $("#login-dialog").addEventListener("close", async () => {
    if ($("#login-dialog").returnValue !== "demo") return;
    try {
      if (state.authMode === "firebase") {
        // ボタンを押した直後に呼ぶ (ポップアップのブロックを避けるため)。結果は onAuthStateChanged に届く
        await state.fb.A.signInWithPopup(
          state.fb.auth,
          new state.fb.A.GoogleAuthProvider(),
        );
      } else {
        setUser(await api("/api/auth/login?provider=demo", { method: "POST" }));
      }
      toast("サインインしました");
    } catch (e) {
      if (
        e?.code !== "auth/popup-closed-by-user" &&
        e?.code !== "auth/cancelled-popup-request"
      )
        toast("サインインできませんでした");
    }
  });
  $("#note-dialog").addEventListener("close", async () => {
    const d = $("#note-dialog");
    if (d.returnValue !== "save") return;
    try {
      setUser(
        await api("/api/notes", {
          method: "POST",
          body: JSON.stringify({
            raceId: d.dataset.race,
            note: $("#note-text").value,
          }),
        }),
      );
      toast("メモを保存しました");
    } catch (_) {
      toast("メモを保存できませんでした");
    }
  });
  addEventListener("hashchange", route);
  addEventListener("resize", movePill);
  route();
  sp.finish();
}

boot();
