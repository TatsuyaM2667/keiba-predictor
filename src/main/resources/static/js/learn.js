// はじめての競馬 (チュートリアル)
// 本文・図・クイズは Kotlin (LearnService) が作る。ここは表示と、クイズの判定、読み終えた章の記録だけ
import { $, $$, api, esc, icon } from "./util.js";

const DONE_KEY = "kv-learn-done";

let done = new Set();
try {
  done = new Set(JSON.parse(localStorage.getItem(DONE_KEY) || "[]"));
} catch {}
const saveDone = () => {
  try {
    localStorage.setItem(DONE_KEY, JSON.stringify([...done]));
  } catch {}
};

export async function renderLearn() {
  const CHAPTERS = await api("/api/learn");
  const toc = $("#learn-toc"), body = $("#learn-body");
  const renderToc = (k) => {
    toc.innerHTML = `<p class="nav-label">${done.size} / ${CHAPTERS.length} 章 完了</p><div class="bar"><i style="width:${(done.size / CHAPTERS.length) * 100}%"></i></div><ol>${CHAPTERS.map(
      (x, i) => `<li><button type="button" data-ch="${x.id}" class="${i === k ? "on" : ""}">${done.has(x.id) ? icon("circle-check", "ok") : `<span class="n num">${i + 1}</span>`}${esc(x.title)}</button></li>`,
    ).join("")}</ol>`;
    $$("[data-ch]", toc).forEach((b) => b.addEventListener("click", () => show(b.dataset.ch)));
  };
  const show = (id) => {
    const k = Math.max(0, CHAPTERS.findIndex((c) => c.id === id));
    const c = CHAPTERS[k];
    renderToc(k);
    body.innerHTML = `<section class="card lesson"><p class="eyebrow">第 ${k + 1} 章</p><h2>${esc(c.title)}</h2>${c.html}
      <div class="quiz">${c.quiz.map((q, qi) => `<div class="q" data-q="${qi}"><p><b>確認クイズ</b> ${esc(q.q)}</p><div class="opts">${q.options.map((o, oi) => `<button type="button" class="btn ghost small" data-o="${oi}">${esc(o)}</button>`).join("")}</div><p class="why" hidden></p></div>`).join("")}</div>
      <nav class="lesson-nav">${k > 0 ? `<button class="btn ghost small" type="button" data-ch="${CHAPTERS[k - 1].id}">${icon("chevron-left")}${esc(CHAPTERS[k - 1].title)}</button>` : "<span></span>"}
        ${k < CHAPTERS.length - 1 ? `<button class="btn primary small" type="button" data-ch="${CHAPTERS[k + 1].id}">次へ: ${esc(CHAPTERS[k + 1].title)}${icon("chevron-right")}</button>` : ""}</nav></section>`;
    const correct = new Set();
    $$(".q", body).forEach((qe) => {
      const q = c.quiz[+qe.dataset.q];
      $$("[data-o]", qe).forEach((b) =>
        b.addEventListener("click", () => {
          const ok = +b.dataset.o === q.answer;
          $$("[data-o]", qe).forEach((x) => x.classList.remove("right", "wrong"));
          b.classList.add(ok ? "right" : "wrong");
          const why = $(".why", qe);
          why.hidden = false;
          why.innerHTML = `${icon(ok ? "circle-check" : "circle-x")}<span>${ok ? "正解!" : `おしい! 正解は「${esc(q.options[q.answer])}」です。`} ${esc(q.why)}</span>`;
          why.className = `why ${ok ? "ok" : "ng"}`;
          if (ok) correct.add(qe.dataset.q);
          if (correct.size === c.quiz.length && !done.has(c.id)) {
            done.add(c.id);
            saveDone();
            renderToc(k); // 目次の完了マークだけ更新 (解説は消さない)
          }
        }),
      );
    });
    $$("[data-ch]", body).forEach((b) =>
      b.addEventListener("click", () => {
        show(b.dataset.ch);
        $("#view-learn").scrollIntoView({ block: "start" });
      }),
    );
  };
  show(CHAPTERS.find((c) => !done.has(c.id))?.id ?? CHAPTERS[0].id);
}
