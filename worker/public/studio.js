"use strict";
(() => {
  const board = document.getElementById("artboard");
  const studies = {
    soft: { number: "01", category: "INDEPENDENT SPIRIT", title: ["Less noise.", "More feeling."] },
    night: { number: "02", category: "AFTER THE EVERYDAY", title: ["Stay curious.", "Go deeper."] },
    pop: { number: "03", category: "EXPRESS YOURSELF", title: ["More color.", "More you."] }
  };
  document.querySelectorAll(".mood-option").forEach((button) => {
    button.addEventListener("click", () => {
      const mood = button.dataset.mood;
      const study = studies[mood];
      if (!study) return;
      board.dataset.mood = mood;
      document.getElementById("study-number").textContent = study.number;
      document.getElementById("poster-category").textContent = study.category;
      document.getElementById("poster-title").replaceChildren(study.title[0], document.createElement("br"), study.title[1]);
      document.querySelectorAll(".mood-option").forEach((option) => option.setAttribute("aria-pressed", String(option === button)));
    });
  });
})();

/* Looping typewriter headline. Keeps running off-screen; static for reduced motion. */
(() => {
  const h1 = document.getElementById("hero-title");
  if (!h1 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const lines = ["Good design", "starts with", "their taste."];
  const star = h1.querySelector(".headline-star");
  h1.setAttribute("aria-label", lines.join(" "));
  const caret = document.createElement("span");
  caret.className = "tw-caret";
  caret.setAttribute("aria-hidden", "true");
  const typed = lines.map((text, i) => {
    const row = document.createElement("span");
    row.className = "tw-line";
    row.setAttribute("aria-hidden", "true");
    const ghost = document.createElement("span");
    ghost.className = "tw-ghost";
    ghost.textContent = text;
    const live = document.createElement("span");
    live.className = "tw-typed";
    let host = live;
    if (i === 2) { host = document.createElement("em"); live.appendChild(host); }
    const ghostHost = i === 2 ? Object.assign(document.createElement("em"), { textContent: text }) : null;
    if (ghostHost) { ghost.textContent = ""; ghost.appendChild(ghostHost); }
    row.append(ghost, live);
    return { row, host, text };
  });
  h1.replaceChildren(...typed.map((t) => t.row));
  if (star) typed[2].row.querySelector(".tw-typed").appendChild(star);
  const total = lines.join("").length;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const render = (n) => {
    let left = n, at = 0;
    typed.forEach((t, i) => {
      const k = Math.max(0, Math.min(t.text.length, left));
      t.host.textContent = t.text.slice(0, k);
      left -= t.text.length;
      if (left >= 0 && n < total) at = i + 1;
    });
    const idx = Math.min(typed.length - 1, (() => { let l = n; for (let i = 0; i < typed.length; i++) { if (l <= typed[i].text.length) return i; l -= typed[i].text.length; } return typed.length - 1; })());
    typed[idx].host.after(caret);
    if (star) star.style.opacity = n >= total ? "" : "0";
  };
  (async () => {
    for (;;) {
      for (let n = 0; n <= total; n++) { render(n); await sleep(n === 0 ? 600 : 75 + Math.random() * 45); }
      await sleep(3200);
      for (let n = total; n >= 0; n--) { render(n); await sleep(28); }
      await sleep(500);
    }
  })();
})();

/* Auto-cycle the three illustrative studies, forever. A manual pick restarts the timer. */
(() => {
  const buttons = [...document.querySelectorAll(".mood-option")];
  if (buttons.length < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  let current = Math.max(0, buttons.findIndex((b) => b.getAttribute("aria-pressed") === "true"));
  let timer;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(next, 2600); };
  const next = () => { current = (current + 1) % buttons.length; buttons[current].click(); };
  buttons.forEach((b, i) => b.addEventListener("click", () => { current = i; schedule(); }));
  schedule();
})();
