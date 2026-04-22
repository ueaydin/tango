// YouTube Tango Overlay - content script
// Manifest V3 isolated world'de calisir. Fuse.js (lib/fuse.min.js) bu dosyadan
// once yuklenir ve global `Fuse` olarak erisilebilir.

(() => {
  "use strict";

  // Modul scope state
  let database = null;       // JSON kayitlari
  let fuse = null;           // Fuse.js instance
  let settings = {           // chrome.storage.sync'den okunan ayarlar
    enabled: true,
    threshold: 0.4,
    position: null           // {x, y} veya null
  };
  let shadowHost = null;     // <div> shadow DOM host elementi
  let shadowRoot = null;
  let lastVideoId = null;    // Son islenen YouTube video ID'si
  let lastMatchSignature = null; // Ayni kayit tekrar render edilmesin diye

  // --- Yardimcilar ---------------------------------------------------------

  /** URL'den YouTube video ID'sini cek. */
  function getVideoId() {
    try {
      const u = new URL(location.href);
      return u.searchParams.get("v");
    } catch (e) {
      return null;
    }
  }

  /** Sayfadaki video basligini oku (3 kaynak, oncelik sirasiyla). */
  function getVideoTitle() {
    const s1 = document.querySelector("h1.ytd-watch-metadata yt-formatted-string");
    if (s1 && s1.textContent.trim()) return s1.textContent.trim();

    const s2 = document.title;
    if (s2) {
      // "... - YouTube" eki varsa temizle
      return s2.replace(/\s*-\s*YouTube\s*$/i, "").trim();
    }

    const s3 = document.querySelector('meta[property="og:title"]');
    if (s3 && s3.content) return s3.content.trim();

    return null;
  }

  /** Python scriptindeki ile ayni normalizasyon: aksan kaldir, kucuk harf, noktalama temizle. */
  function normalize(str) {
    if (!str) return "";
    return str
      .normalize("NFD")                   // aksanlari combining mark'a ayir
      .replace(/[̀-ͯ]/g, "")    // combining mark'leri kaldir
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")  // harf/rakam/bosluk disini bosluga cevir
      .replace(/\s+/g, " ")
      .trim();
  }

  /** "bu video icin gizle" flag'i var mi? */
  function isHiddenForCurrentVideo() {
    const vid = getVideoId();
    if (!vid) return false;
    return sessionStorage.getItem("tangoOverlay:hidden:" + vid) === "1";
  }

  function setHiddenForCurrentVideo() {
    const vid = getVideoId();
    if (vid) sessionStorage.setItem("tangoOverlay:hidden:" + vid, "1");
  }

  // --- Bootstrap -----------------------------------------------------------

  /** Veritabanini yukle ve Fuse indeksini kur. */
  async function loadDatabase() {
    if (database) return;
    const url = chrome.runtime.getURL("data/tango_database.json");
    const res = await fetch(url);
    database = await res.json();
    buildFuse();
  }

  function buildFuse() {
    if (typeof Fuse === "undefined") {
      console.error("[Tango Overlay] Fuse.js yuklenemedi");
      return;
    }
    // Extended search modu kullanilir: baslik token'lara bolunur, her token
    // '<token>' seklinde "fuzzy match" prefix'i ile Fuse'a verilir. Bu sayede
    // baslikta kelimelerin sirasi ve aralarindaki ayiricilar onemsizlesir.
    fuse = new Fuse(database, {
      keys: ["_search"],
      includeScore: true,
      threshold: settings.threshold,
      ignoreLocation: true,
      useExtendedSearch: true,
      minMatchCharLength: 2
    });
  }

  /** Ayarlari storage'dan oku. */
  async function loadSettings() {
    return new Promise(resolve => {
      chrome.storage.sync.get({ enabled: true, threshold: 0.4, position: null }, (data) => {
        settings = { ...settings, ...data };
        resolve();
      });
    });
  }

  // --- Eslestirme -----------------------------------------------------------

  /** Baslik icinden yili cikar (varsa), esitlik skorunu artirmak icin kullanilir. */
  function extractYear(title) {
    const m = title.match(/\b(19[0-9]{2}|20[0-2][0-9])\b/);
    return m ? parseInt(m[1], 10) : null;
  }

  // Cok yaygin ama ayirt edici olmayan kelimeler (baslikta sik gecer, aramada
  // gurultu ureten). Extended search token'i olarak kullanilmaz.
  const STOPWORDS = new Set([
    "tango", "vals", "milonga", "de", "la", "el", "y", "en", "con", "por",
    "un", "una", "mi", "tu", "su", "se", "los", "las", "del", "al",
    "and", "the", "of", "feat", "ft", "official", "video", "audio", "hd",
    "remastered", "restored", "1080p", "720p", "4k", "hq",
    "instrumental", "orquesta", "orkestra", "featuring"
  ]);

  /** Verilen token listesi icin Fuse extended search calistir, en iyi sonucu dondur. */
  function trySearch(tokens, hintYear) {
    if (!tokens.length) return null;
    const query = tokens.map(t => "'" + t).join(" ");
    const results = fuse.search(query, { limit: 10 });
    if (!results.length) return null;

    if (hintYear) {
      results.forEach(r => {
        const y = r.item.year;
        if (y && Math.abs(y - hintYear) <= 1) {
          r.score = Math.max(0, r.score - 0.05);
        }
      });
      results.sort((a, b) => a.score - b.score);
    }
    const best = results[0];
    if (best.score > settings.threshold) return null;
    return best;
  }

  /** En iyi eslesmeyi dondurur veya null. Yazim hatasina dayanikli (hibrit fallback). */
  function findMatch(title) {
    if (!fuse) return null;
    const normTitle = normalize(title);
    if (!normTitle) return null;

    if (fuse.options.threshold !== settings.threshold) {
      buildFuse();
    }

    // Token'lara bol: cok kisa ve stopword'leri at, yili ayri tut
    const rawTokens = normTitle.split(/\s+/).filter(Boolean);
    const tokens = rawTokens.filter(t => t.length >= 3 && !STOPWORDS.has(t) && !/^\d{4}$/.test(t));
    if (tokens.length < 1) return null;

    const hintYear = extractYear(title);

    // Strateji 1: Tum token'lar zorunlu (en sıkı)
    let best = trySearch(tokens, hintYear);
    if (best) return best;

    // Strateji 2: Token sayisi 4+ ise, en kisa token'i cikarip yeniden dene
    // (yazim hatasi cogunlukla kisa kelimelerde olur)
    if (tokens.length >= 4) {
      const sorted = [...tokens].sort((a, b) => b.length - a.length);
      best = trySearch(sorted.slice(0, -1), hintYear);
      if (best) {
        best.score = Math.min(0.5, best.score + 0.15); // approx olarak isaretle
        return best;
      }
    }

    // Strateji 3: Sadece en uzun 2 token (son care)
    if (tokens.length >= 3) {
      const sorted = [...tokens].sort((a, b) => b.length - a.length);
      best = trySearch(sorted.slice(0, 2), hintYear);
      if (best) {
        best.score = Math.min(0.5, best.score + 0.25);
        return best;
      }
    }

    return null;
  }

  // --- Shadow DOM kart ------------------------------------------------------

  /** Shadow host'u olustur veya mevcut olani dondur. */
  async function ensureShadow() {
    if (shadowHost && document.body.contains(shadowHost)) return;

    shadowHost = document.createElement("div");
    shadowHost.id = "tango-overlay-root";
    // Paketin CSS'i Shadow DOM icine enjekte edilir, disari sizmasin
    shadowHost.style.cssText = "all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;";
    document.body.appendChild(shadowHost);
    shadowRoot = shadowHost.attachShadow({ mode: "open" });

    // Stilleri yukle ve <style> olarak inject
    const cssUrl = chrome.runtime.getURL("overlay.css");
    const cssText = await fetch(cssUrl).then(r => r.text());
    const style = document.createElement("style");
    style.textContent = cssText;
    shadowRoot.appendChild(style);

    // Kart govdesi
    const card = document.createElement("div");
    card.className = "card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-label", "Tango sarkisi bilgisi");
    shadowRoot.appendChild(card);

    // Kayitli pozisyonu uygula
    applyPosition();
  }

  function applyPosition() {
    if (!shadowRoot) return;
    const card = shadowRoot.querySelector(".card");
    if (!card) return;
    if (settings.position && typeof settings.position.x === "number") {
      card.style.top = settings.position.y + "px";
      card.style.right = "auto";
      card.style.left = settings.position.x + "px";
    } else {
      card.style.top = "16px";
      card.style.right = "16px";
      card.style.left = "auto";
    }
  }

  /** HTML'ye escape et. */
  function esc(s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  /** Kayittan kart icerigi uret. */
  function renderCardBody(match) {
    const it = match.item;
    const approx = match.score > 0.3;
    const rating = (it.dance_rating || it.listen_rating)
      ? `<div class="row small">⭐ ${it.dance_rating != null ? `Dans ${it.dance_rating.toFixed(2)}` : ""}${(it.dance_rating != null && it.listen_rating != null) ? " • " : ""}${it.listen_rating != null ? `Dinleme ${it.listen_rating.toFixed(2)}` : ""}</div>`
      : "";
    const meta = [
      it.year ? `📅 ${esc(it.year)}` : null,
      it.genre ? esc(it.genre) : null,
      it.duration ? `⏱ ${esc(it.duration)}` : null,
      it.label ? `💿 ${esc(it.label)}` : null
    ].filter(Boolean).join(" • ");
    const tags = (it.tags && it.tags !== "-") ? `<div class="row tags">🏷 ${esc(it.tags)}</div>` : "";

    return `
      <div class="header drag-handle">
        <div class="handle-hint" title="Surukle">⋮⋮</div>
        ${approx ? '<span class="badge-approx">~ yakın eşleşme</span>' : ''}
        <button class="close-btn" aria-label="Kapat">×</button>
      </div>
      <div class="title">🎵 ${esc(it.title)}</div>
      <div class="row">🎼 ${esc(it.orchestra)}</div>
      <div class="row">🎤 ${esc(it.singer)}</div>
      ${meta ? `<div class="row meta">${meta}</div>` : ""}
      ${it.lyricist ? `<div class="row small">✍️ Söz: ${esc(it.lyricist)}</div>` : ""}
      ${it.composer ? `<div class="row small">🎹 Beste: ${esc(it.composer)}</div>` : ""}
      ${rating}
      ${tags}
    `;
  }

  /** Karti goster veya gunceller. */
  async function showCard(match) {
    await ensureShadow();
    const card = shadowRoot.querySelector(".card");
    const sig = match.item.id + "|" + getVideoId();
    // Ayni eslesme zaten gorunuyorsa yeniden cizme
    if (lastMatchSignature === sig && card.classList.contains("visible")) return;

    lastMatchSignature = sig;
    card.innerHTML = renderCardBody(match);
    card.classList.remove("visible");
    // Fade-in animasyonunu tetiklemek icin frame bekle
    requestAnimationFrame(() => card.classList.add("visible"));

    // Event listener'larini bagla
    const closeBtn = card.querySelector(".close-btn");
    closeBtn.addEventListener("click", () => {
      hideCard();
      setHiddenForCurrentVideo();
    });

    const dragHandle = card.querySelector(".drag-handle");
    attachDrag(card, dragHandle);
  }

  function hideCard() {
    if (!shadowRoot) return;
    const card = shadowRoot.querySelector(".card");
    if (card) card.classList.remove("visible");
    lastMatchSignature = null;
  }

  // --- Surukle-birak --------------------------------------------------------

  function attachDrag(card, handle) {
    // Zaten bagliysa yeniden baglama
    if (handle._dragBound) return;
    handle._dragBound = true;

    let startX = 0, startY = 0, startLeft = 0, startTop = 0, dragging = false;

    handle.addEventListener("pointerdown", (ev) => {
      if (ev.target.classList.contains("close-btn")) return;
      dragging = true;
      handle.setPointerCapture(ev.pointerId);
      const rect = card.getBoundingClientRect();
      startX = ev.clientX;
      startY = ev.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      card.style.left = startLeft + "px";
      card.style.top = startTop + "px";
      card.style.right = "auto";
      ev.preventDefault();
    });

    handle.addEventListener("pointermove", (ev) => {
      if (!dragging) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      const newLeft = Math.max(0, Math.min(window.innerWidth - card.offsetWidth, startLeft + dx));
      const newTop = Math.max(0, Math.min(window.innerHeight - card.offsetHeight, startTop + dy));
      card.style.left = newLeft + "px";
      card.style.top = newTop + "px";
    });

    const endDrag = (ev) => {
      if (!dragging) return;
      dragging = false;
      try { handle.releasePointerCapture(ev.pointerId); } catch {}
      // Pozisyonu kalici olarak sakla
      const left = parseFloat(card.style.left) || 0;
      const top = parseFloat(card.style.top) || 0;
      settings.position = { x: left, y: top };
      chrome.storage.sync.set({ position: settings.position });
    };
    handle.addEventListener("pointerup", endDrag);
    handle.addEventListener("pointercancel", endDrag);
  }

  // --- Ana akis -------------------------------------------------------------

  /** Mevcut video icin baslik oku, esle, karti guncelle. */
  async function refresh() {
    if (!settings.enabled) {
      hideCard();
      return;
    }
    // Sadece /watch URL'lerinde calis
    if (!location.pathname.startsWith("/watch")) {
      hideCard();
      return;
    }
    if (isHiddenForCurrentVideo()) {
      hideCard();
      return;
    }

    const title = getVideoTitle();
    if (!title) return;

    await loadDatabase();
    const match = findMatch(title);
    if (!match) {
      hideCard();
      return;
    }
    await showCard(match);
  }

  /** Debounced refresh. YouTube SPA navigation'da baslik birkac kez degisebilir. */
  let refreshTimer = null;
  function scheduleRefresh(delay = 300) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refresh().catch(e => console.error("[Tango Overlay] refresh hatasi:", e));
    }, delay);
  }

  // --- Event'leri bagla -----------------------------------------------------

  // YouTube SPA navigation event'i
  document.addEventListener("yt-navigate-finish", () => scheduleRefresh(500));

  // URL degisimini izle (fallback)
  let lastHref = location.href;
  const urlObserver = new MutationObserver(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      scheduleRefresh(500);
    }
  });
  urlObserver.observe(document, { subtree: true, childList: true });

  // Baslik degisimini izle (video yuklenmesi bitince)
  const titleTarget = document.querySelector("title") || document.head;
  if (titleTarget) {
    const titleObserver = new MutationObserver(() => scheduleRefresh(400));
    titleObserver.observe(titleTarget, { childList: true, subtree: true, characterData: true });
  }

  // Ayar degisikliklerini dinle
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let needsRefresh = false;
    if ("enabled" in changes) {
      settings.enabled = changes.enabled.newValue;
      needsRefresh = true;
    }
    if ("threshold" in changes) {
      settings.threshold = changes.threshold.newValue;
      if (fuse) buildFuse();
      lastMatchSignature = null; // yeni threshold ile yeniden degerlendir
      needsRefresh = true;
    }
    if ("position" in changes) {
      settings.position = changes.position.newValue;
      applyPosition();
    }
    if (needsRefresh) scheduleRefresh(100);
  });

  // Popup'tan gelen mesajlar
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === "reload") {
      lastMatchSignature = null;
      scheduleRefresh(50);
      sendResponse({ ok: true });
    } else if (msg && msg.type === "resetPosition") {
      settings.position = null;
      applyPosition();
      sendResponse({ ok: true });
    }
    return true;
  });

  // Basla
  (async () => {
    await loadSettings();
    // Ilk yuklemede sayfa hazir olana kadar biraz bekle
    scheduleRefresh(800);
  })();
})();
