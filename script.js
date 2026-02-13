const TWEET_URL_RE =
  /^https?:\/\/(?:x\.com|twitter\.com)\/[^\/]+\/status\/\d+(?:\?.*)?$/i;

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

const puzzleState = {
  items: [],
  page: 1,
};
const madamisState = {
  items: [],
};

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
      return waitFor();
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

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-store" });
  if (!res.ok) throw new Error(`${path} の読み込みに失敗しました`);
  return res.json();
}

async function fetchCsv(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`${url} の読み込みに失敗しました`);
  return res.text();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      continue;
    }
    if (char === "\r") {
      continue;
    }
    field += char;
  }
  row.push(field);
  if (row.length > 1 || row[0].trim() !== "") {
    rows.push(row);
  }
  return rows;
}

function normalizePuzzleCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
  const headers = rows[0].map((h) => h.trim().toLowerCase());
  const titleIndex = headers.indexOf("title");
  const urlIndex = headers.indexOf("url");
  if (titleIndex === -1 || urlIndex === -1) return [];
  return rows
    .slice(1)
    .map((cols) => {
      const title = (cols[titleIndex] || "").trim();
      const url = (cols[urlIndex] || "").trim();
      if (!title && !url) return null;
      return {
        title: title || "X投稿",
        url,
      };
    })
    .filter(Boolean);
}

function normalizeMadamisCsv(text) {
  const rows = parseCsv(text);
  if (rows.length === 0) return [];
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
        place: "",
        role: "",
        notes: "",
        url: "",
      };
    })
    .filter(Boolean);
}

function normalizePuzzleItems(data) {
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      if (typeof item === "string") return { url: item };
      if (!item || typeof item !== "object") return null;
      const url =
        item.url ||
        item.tweetUrl ||
        item.xUrl ||
        item.X ||
        item.x ||
        item.link;
      const title = item.title || item.name || "X投稿";
      if (!url && !title) return null;
      return {
        url: url || "",
        title,
        date: item.date || item.createdAt || "",
      };
    })
    .filter(Boolean);
}

function normalizeMadamisItems(data) {
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      if (typeof item === "string") {
        return { title: item, date: "", place: "", role: "", notes: "" };
      }
      if (!item || typeof item !== "object") return null;
      return {
        title: item.title || item.name || "無題",
        date: item.date || "",
        place: item.place || "",
        role: item.role || "",
        notes: item.notes || "",
        url: item.url || "",
      };
    })
    .filter(Boolean);
}

function updateStats() {
  const puzzleCountEl = qs("#puzzle-count");
  const madamisCountEl = qs("#madamis-count");
  const updatedEl = qs("#updated-date");

  if (puzzleCountEl) puzzleCountEl.textContent = puzzleState.items.length;
  if (madamisCountEl) madamisCountEl.textContent = madamisState.items.length;
  if (updatedEl)
    updatedEl.textContent = new Date().toISOString().slice(0, 10);
}

function getTweetId(url) {
  try {
    const parts = url.split("/");
    const tail = parts[parts.length - 1] || "";
    return tail.split("?")[0];
  } catch {
    return "";
  }
}

function renderPuzzleList() {
  if (!puzzleList) return;
  puzzleList.innerHTML = "";
  const term = puzzleSearch?.value?.trim().toLowerCase() ?? "";
  const filtered = term
    ? puzzleState.items.filter((item) =>
        [item.title, item.url, item.date]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term))
      )
    : puzzleState.items;

  if (filtered.length === 0) {
    puzzleStatus.textContent = "表示できる謎解き投稿がありません。";
    if (puzzlePageEl) puzzlePageEl.textContent = "0 / 0";
    if (puzzlePrev) puzzlePrev.disabled = true;
    if (puzzleNext) puzzleNext.disabled = true;
    return;
  }

  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(Math.max(puzzleState.page, 1), totalPages);
  puzzleState.page = currentPage;
  const start = (currentPage - 1) * pageSize;
  const pageItems = filtered.slice(start, start + pageSize);
  const embeds = [];

  pageItems.forEach((item, index) => {
    const li = document.createElement("li");
    li.className = "puzzle-item";

    const header = document.createElement("div");
    header.className = "puzzle-item-head";

    const title = document.createElement("span");
    title.className = "puzzle-title";
    const tweetId = getTweetId(item.url);
    title.textContent = item.title || (tweetId ? `投稿 ${tweetId}` : "投稿");

    const meta = document.createElement("span");
    meta.textContent = item.date || "";

    header.appendChild(title);
    header.appendChild(meta);

    li.appendChild(header);

    if (tweetId) {
      const embedWrap = document.createElement("div");
      embedWrap.className = "puzzle-embed tweet-loading";
      embeds.push({ id: tweetId, el: embedWrap });
      li.appendChild(embedWrap);
    } else if (item.url) {
      const embedWrap = document.createElement("div");
      embedWrap.className = "puzzle-embed";
      embedWrap.textContent = "埋め込みを表示できませんでした。";
      li.appendChild(embedWrap);
    }

    puzzleList.appendChild(li);
  });

  puzzleStatus.textContent = term
    ? `${filtered.length}件 / 全${puzzleState.items.length}件`
    : ``;

  if (puzzlePageEl) puzzlePageEl.textContent = `${currentPage} / ${totalPages}`;
  if (puzzlePrev) puzzlePrev.disabled = currentPage <= 1;
  if (puzzleNext) puzzleNext.disabled = currentPage >= totalPages;

  if (embeds.length === 0) return;
  ensureTwitterWidgets()
    .then((twttr) => {
      embeds.forEach(({ id, el }) => {
        twttr.widgets
          .createTweet(id, el, { dnt: true })
          .then(() => el.classList.remove("tweet-loading"))
          .catch(() => {
            el.textContent = "埋め込みを表示できませんでした。";
            el.classList.remove("tweet-loading");
          });
      });
    })
    .catch(() => {});
}

function renderMadamis(items) {
  if (!madamisList) return;
  madamisList.innerHTML = "";

  const term = madamisSearch?.value?.trim().toLowerCase() ?? "";
  const filtered = term
    ? items.filter((item) =>
        [item.title, item.date]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(term))
      )
    : items;

  filtered.forEach((item) => {
    const li = document.createElement("li");
    li.className = "madamis-item";

    const title = document.createElement("span");
    title.className = "madamis-title";
    title.textContent = item.title;

    const date = document.createElement("span");
    date.className = "madamis-date";
    date.textContent = item.date || "";

    li.appendChild(title);
    li.appendChild(date);
    madamisList.appendChild(li);
  });
}

async function init() {
  const puzzleCsvUrl =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vTWWvCjiw9o_PPdGjclEHDkFucSlYoybDMlVvf1G4Y-CN5TpwA0Ac3CljFkgaUsJ7e96CGF3Nckzjlt/pub?gid=0&single=true&output=csv";
  const madamisCsvUrl =
    "https://docs.google.com/spreadsheets/d/e/2PACX-1vTWWvCjiw9o_PPdGjclEHDkFucSlYoybDMlVvf1G4Y-CN5TpwA0Ac3CljFkgaUsJ7e96CGF3Nckzjlt/pub?gid=431056064&single=true&output=csv";
  const [puzzleResult, madamisResult] = await Promise.allSettled([
    fetchCsv(puzzleCsvUrl),
    fetchCsv(madamisCsvUrl),
  ]);

  if (puzzleResult.status === "fulfilled") {
    puzzleState.items = normalizePuzzleCsv(puzzleResult.value);
    renderPuzzleList();
  } else if (puzzleStatus) {
    puzzleStatus.textContent =
      "謎解きデータの読み込みに失敗しました。スプレッドシートの公開設定を確認してください。";
  }

  if (madamisResult.status === "fulfilled") {
    madamisState.items = normalizeMadamisCsv(madamisResult.value);
    renderMadamis(madamisState.items);
  } else {
    console.warn(madamisResult.reason);
  }

  updateStats();
}

if (puzzleSearch) {
  puzzleSearch.addEventListener("input", () => {
    puzzleState.page = 1;
    renderPuzzleList();
  });
}

if (madamisSearch) {
  madamisSearch.addEventListener("input", () => {
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

init();
