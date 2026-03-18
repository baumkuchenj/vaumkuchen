const DATA_URLS = {
  puzzles:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vTWWvCjiw9o_PPdGjclEHDkFucSlYoybDMlVvf1G4Y-CN5TpwA0Ac3CljFkgaUsJ7e96CGF3Nckzjlt/pub?gid=0&single=true&output=csv",
  madamis:
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vTWWvCjiw9o_PPdGjclEHDkFucSlYoybDMlVvf1G4Y-CN5TpwA0Ac3CljFkgaUsJ7e96CGF3Nckzjlt/pub?gid=431056064&single=true&output=csv",
};

const CSV_CACHE_VERSION = "v1";
const CSV_CACHE_MAX_AGE_MS = 1000 * 60 * 15;
const PUZZLE_PAGE_SIZE = 10;
const MADAMIS_PAGE_SIZE = 10;

const qs = (sel) => document.querySelector(sel);

const yearEl = qs("#year");
if (yearEl) yearEl.textContent = new Date().getFullYear();

const puzzleList = qs("#puzzle-list");
const puzzleStatus = qs("#puzzle-status");
const puzzleSearch = qs("#puzzle-search");
const puzzlePrev = qs("#puzzle-prev");
const puzzleNext = qs("#puzzle-next");
const puzzlePageEl = qs("#puzzle-page");
const madamisList = qs("#madamis-list");
const madamisSearch = qs("#madamis-search");
const madamisPrev = qs("#madamis-prev");
const madamisNext = qs("#madamis-next");
const madamisPageEl = qs("#madamis-page");

const puzzleState = { items: [], page: 1 };
const madamisState = { items: [], page: 1 };

function getCsvCacheKey(name) {
  return "vaumkuchen:" + CSV_CACHE_VERSION + ":" + name;
}

function readCsvCache(name) {
  try {
    const raw = localStorage.getItem(getCsvCacheKey(name));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.text !== "string" || typeof parsed.savedAt !== "number") {
      return null;
    }
    if (Date.now() - parsed.savedAt > CSV_CACHE_MAX_AGE_MS) return null;
    return parsed.text;
  } catch {
    return null;
  }
}

function writeCsvCache(name, text) {
  try {
    localStorage.setItem(
      getCsvCacheKey(name),
      JSON.stringify({ text, savedAt: Date.now() })
    );
  } catch {
    // Ignore private mode / quota errors.
  }
}

let twitterWidgetsPromise = null;

function ensureTwitterWidgets() {
  if (window.twttr?.widgets) return Promise.resolve(window.twttr);
  if (twitterWidgetsPromise) return twitterWidgetsPromise;

  twitterWidgetsPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector("script[data-twitter-widgets]");
    if (existing) {
      const waitFor = () => {
        if (window.twttr?.widgets) return resolve(window.twttr);
        setTimeout(waitFor, 60);
      };
      waitFor();
      return;
    }

    const script = document.createElement("script");
    script.src = "https://platform.twitter.com/widgets.js";
    script.async = true;
    script.defer = true;
    script.setAttribute("data-twitter-widgets", "true");
    script.onload = () => resolve(window.twttr);
    script.onerror = (err) => reject(err);
    document.head.appendChild(script);
  });

  return twitterWidgetsPromise;
}

async function fetchCsv(url) {
  const res = await fetch(url, { cache: "default" });
  if (!res.ok) throw new Error("Failed to fetch CSV: " + url);
  return res.text();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (ch === "\r") continue;

    field += ch;
  }

  row.push(field);
  if (row.length > 1 || row[0].trim() !== "") rows.push(row);
  return rows;
}

function normalizePuzzleCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const titleIndex = headers.indexOf("title");
  const urlIndex = headers.indexOf("url");
  const dateIndex = headers.indexOf("date");
  if (titleIndex === -1 || urlIndex === -1) return [];

  return rows
    .slice(1)
    .map((cols) => {
      const title = (cols[titleIndex] || "").trim();
      const url = (cols[urlIndex] || "").trim();
      const date = dateIndex >= 0 ? (cols[dateIndex] || "").trim() : "";
      if (!title && !url) return null;
      return { title: title || "Puzzle", url, date };
    })
    .filter(Boolean);
}

function normalizeMadamisCsv(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const noIndex = headers.indexOf("no");
  const dateIndex = headers.indexOf("date");
  const titleIndex = headers.indexOf("title");
  if (titleIndex === -1) return [];

  return rows
    .slice(1)
    .map((cols) => {
      const title = (cols[titleIndex] || "").trim();
      if (!title) return null;
      const noValue = noIndex >= 0 ? (cols[noIndex] || "").trim() : "";
      return {
        title: noValue ? `${noValue}. ${title}` : title,
        date: dateIndex >= 0 ? (cols[dateIndex] || "").trim() : "",
      };
    })
    .filter(Boolean);
}

function getTweetId(url) {
  if (!url) return "";
  try {
    const parts = url.split("/");
    return (parts[parts.length - 1] || "").split("?")[0];
  } catch {
    return "";
  }
}

const embedObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      embedObserver.unobserve(entry.target);

      const el = entry.target;
      const tweetId = el.dataset.tweetId;
      if (!tweetId) return;

      ensureTwitterWidgets()
        .then((twttr) => twttr.widgets.createTweet(tweetId, el, { dnt: true }))
        .then(() => el.classList.remove("tweet-loading"))
        .catch(() => {
          el.classList.remove("tweet-loading");
          el.classList.add("tweet-error");
          el.innerHTML = '<span class="embed-error-msg">埋め込みを表示できませんでした。</span>';
        });
    });
  },
  { rootMargin: "200px 0px" }
);

function renderPuzzleList() {
  if (!puzzleList) return;
  puzzleList.innerHTML = "";

  const term = puzzleSearch?.value?.trim().toLowerCase() ?? "";
  const filtered = term
    ? puzzleState.items.filter((item) =>
        [item.title, item.url, item.date]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(term))
      )
    : puzzleState.items;

  if (filtered.length === 0) {
    if (puzzleStatus) puzzleStatus.textContent = "表示できる謎解きがありません。";
    if (puzzlePageEl) puzzlePageEl.textContent = "0 / 0";
    if (puzzlePrev) puzzlePrev.disabled = true;
    if (puzzleNext) puzzleNext.disabled = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PUZZLE_PAGE_SIZE));
  const currentPage = Math.min(Math.max(puzzleState.page, 1), totalPages);
  puzzleState.page = currentPage;

  const start = (currentPage - 1) * PUZZLE_PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PUZZLE_PAGE_SIZE);

  pageItems.forEach((item) => {
    const li = document.createElement("li");
    li.className = "puzzle-item";

    const header = document.createElement("div");
    header.className = "puzzle-item-head";

    const titleEl = document.createElement("span");
    titleEl.className = "puzzle-title";
    const tweetId = getTweetId(item.url);
    titleEl.textContent = item.title || (tweetId ? `投稿 ${tweetId}` : "投稿");

    const meta = document.createElement("span");
    meta.textContent = item.date || "";

    header.appendChild(titleEl);
    header.appendChild(meta);
    li.appendChild(header);

    if (tweetId) {
      const embedWrap = document.createElement("div");
      embedWrap.className = "puzzle-embed tweet-loading";
      embedWrap.dataset.tweetId = tweetId;
      embedObserver.observe(embedWrap);
      li.appendChild(embedWrap);
    } else if (item.url) {
      const embedWrap = document.createElement("div");
      embedWrap.className = "puzzle-embed tweet-error";
      embedWrap.innerHTML = '<span class="embed-error-msg">埋め込みを表示できませんでした。</span>';
      li.appendChild(embedWrap);
    }

    puzzleList.appendChild(li);
  });

  if (puzzleStatus) {
    puzzleStatus.textContent = term
      ? `${filtered.length}件 / 全${puzzleState.items.length}件`
      : "";
  }
  if (puzzlePageEl) puzzlePageEl.textContent = `${currentPage} / ${totalPages}`;
  if (puzzlePrev) puzzlePrev.disabled = currentPage <= 1;
  if (puzzleNext) puzzleNext.disabled = currentPage >= totalPages;
}

function renderMadamis(items) {
  if (!madamisList) return;
  madamisList.innerHTML = "";

  const term = madamisSearch?.value?.trim().toLowerCase() ?? "";
  const filtered = term
    ? items.filter((item) =>
        [item.title, item.date]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(term))
      )
    : items;

  if (filtered.length === 0) {
    const li = document.createElement("li");
    li.className = "madamis-empty";
    li.textContent = "表示できるマダミスがありません。";
    madamisList.appendChild(li);
    if (madamisPageEl) madamisPageEl.textContent = "0 / 0";
    if (madamisPrev) madamisPrev.disabled = true;
    if (madamisNext) madamisNext.disabled = true;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / MADAMIS_PAGE_SIZE));
  const currentPage = Math.min(Math.max(madamisState.page, 1), totalPages);
  madamisState.page = currentPage;

  const start = (currentPage - 1) * MADAMIS_PAGE_SIZE;
  const pageItems = filtered.slice(start, start + MADAMIS_PAGE_SIZE);

  pageItems.forEach((item) => {
    const li = document.createElement("li");
    li.className = "madamis-item";

    const titleEl = document.createElement("span");
    titleEl.className = "madamis-title";
    titleEl.textContent = item.title;

    const dateEl = document.createElement("span");
    dateEl.className = "madamis-date";
    dateEl.textContent = item.date || "";

    li.appendChild(titleEl);
    li.appendChild(dateEl);
    madamisList.appendChild(li);
  });

  if (madamisPageEl) madamisPageEl.textContent = `${currentPage} / ${totalPages}`;
  if (madamisPrev) madamisPrev.disabled = currentPage <= 1;
  if (madamisNext) madamisNext.disabled = currentPage >= totalPages;
}

async function init() {
  const cachedPuzzleCsv = readCsvCache("puzzles");
  const cachedMadamisCsv = readCsvCache("madamis");

  if (cachedPuzzleCsv) {
    puzzleState.items = normalizePuzzleCsv(cachedPuzzleCsv);
    renderPuzzleList();
  }

  if (cachedMadamisCsv) {
    madamisState.items = normalizeMadamisCsv(cachedMadamisCsv);
    renderMadamis(madamisState.items);
  }

  const [puzzleResult, madamisResult] = await Promise.allSettled([
    fetchCsv(DATA_URLS.puzzles),
    fetchCsv(DATA_URLS.madamis),
  ]);

  if (puzzleResult.status === "fulfilled") {
    writeCsvCache("puzzles", puzzleResult.value);
    puzzleState.items = normalizePuzzleCsv(puzzleResult.value);
    renderPuzzleList();
  } else if (!cachedPuzzleCsv && puzzleStatus) {
    console.warn(puzzleResult.reason);
    puzzleStatus.textContent = "謎解きデータの読み込みに失敗しました。";
  }

  if (madamisResult.status === "fulfilled") {
    writeCsvCache("madamis", madamisResult.value);
    madamisState.items = normalizeMadamisCsv(madamisResult.value);
    renderMadamis(madamisState.items);
  } else if (!cachedMadamisCsv && madamisList) {
    console.warn(madamisResult.reason);
    madamisList.innerHTML = '<li class="madamis-empty">マダミスデータの読み込みに失敗しました。</li>';
  }
}

if (puzzleSearch) {
  puzzleSearch.addEventListener("input", () => {
    puzzleState.page = 1;
    renderPuzzleList();
  });
}

if (madamisSearch) {
  madamisSearch.addEventListener("input", () => {
    madamisState.page = 1;
    renderMadamis(madamisState.items);
  });
}

if (puzzlePrev) {
  puzzlePrev.addEventListener("click", () => {
    puzzleState.page = Math.max(1, puzzleState.page - 1);
    renderPuzzleList();
  });
}

if (puzzleNext) {
  puzzleNext.addEventListener("click", () => {
    puzzleState.page += 1;
    renderPuzzleList();
  });
}

if (madamisPrev) {
  madamisPrev.addEventListener("click", () => {
    madamisState.page = Math.max(1, madamisState.page - 1);
    renderMadamis(madamisState.items);
  });
}

if (madamisNext) {
  madamisNext.addEventListener("click", () => {
    madamisState.page += 1;
    renderMadamis(madamisState.items);
  });
}

init();
