// Tango Overlay - content script
// Manifest V3 isolated world'de YouTube ve Apple Music Web Player'da calisir.
// Fuse.js (lib/fuse.min.js) bu dosyadan once yuklenir ve global `Fuse` olarak erisilir.

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
  let lastMatchSignature = null; // Ayni kayit tekrar render edilmesin diye

  // --- Platform katmani -----------------------------------------------------

  /** Calistigimiz platformu dondurur: "youtube" | "applemusic" | null. */
  function getPlatform() {
    const h = location.hostname;
    if (h.endsWith("youtube.com")) return "youtube";
    if (h === "music.apple.com") return "applemusic";
    return null;
  }

  /** Su an calmakta olan parcanin kararli bir kimligini uretir (hide/cache icin). */
  function getTrackKey() {
    const p = getPlatform();
    if (p === "youtube") {
      try {
        return new URL(location.href).searchParams.get("v");
      } catch (_) { return null; }
    }
    if (p === "applemusic") {
      const t = getAppleMusicTrack();
      return t ? (t.title + "|" + t.artist).toLowerCase() : null;
    }
    return null;
  }

  /** findMatch'e beslenecek arama sorgusu (baslik + varsa sanatci). */
  function getTrackQuery() {
    const p = getPlatform();
    if (p === "youtube") return getYouTubeTitle();
    if (p === "applemusic") {
      const t = getAppleMusicTrack();
      if (!t) return null;
      return (t.title + " " + (t.artist || "")).trim();
    }
    return null;
  }

  /** Bu sayfada overlay gosterilmeli mi? */
  function isOnPlayablePage() {
    const p = getPlatform();
    if (p === "youtube") return location.pathname.startsWith("/watch");
    if (p === "applemusic") return true;
    return false;
  }

  /** YouTube video basligi (3 kaynak, oncelik sirasiyla). */
  function getYouTubeTitle() {
    const s1 = document.querySelector("h1.ytd-watch-metadata yt-formatted-string");
    if (s1 && s1.textContent.trim()) return s1.textContent.trim();

    const s2 = document.title;
    if (s2) {
      return s2.replace(/\s*-\s*YouTube\s*$/i, "").trim();
    }

    const s3 = document.querySelector('meta[property="og:title"]');
    if (s3 && s3.content) return s3.content.trim();

    return null;
  }

  /** Apple Music Web Player: {title, artist, album}. MediaSession once, DOM fallback. */
  function getAppleMusicTrack() {
    // 1) MediaSession API - Apple Music OS media kontrollerine bunu set eder
    try {
      const m = navigator.mediaSession && navigator.mediaSession.metadata;
      if (m && m.title) {
        return {
          title: String(m.title || "").trim(),
          artist: String(m.artist || "").trim(),
          album: String(m.album || "").trim()
        };
      }
    } catch (_) {}

    // 2) DOM fallback - chrome playback LCD bar
    const songEl = document.querySelector(
      '.web-chrome-playback-lcd__song-name-scroll, ' +
      '[class*="chrome-playback-lcd__song-name"], ' +
      '[class*="lcd-meta-line--song"], ' +
      '[class*="song-name"]'
    );
    if (songEl && songEl.textContent.trim()) {
      const artistEl = document.querySelector(
        '.web-chrome-playback-lcd__sub-copy-scroll-container, ' +
        '[class*="chrome-playback-lcd__sub-copy"], ' +
        '[class*="lcd-meta-line--sub"], ' +
        '[class*="sub-copy"]'
      );
      return {
        title: songEl.textContent.trim(),
        artist: artistEl ? artistEl.textContent.trim() : "",
        album: ""
      };
    }

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

  /** "bu parca icin gizle" flag'i var mi? */
  function isHiddenForCurrentTrack() {
    const k = getTrackKey();
    if (!k) return false;
    return sessionStorage.getItem("tangoOverlay:hidden:" + k) === "1";
  }

  function setHiddenForCurrentTrack() {
    const k = getTrackKey();
    if (k) sessionStorage.setItem("tangoOverlay:hidden:" + k, "1");
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

  /** Verilen kayit icin DB'de ayni sarki+orkestra'ya sahip tum kayitlari dondur.
   *  Yil'a gore kronolojik sirali (eski -> yeni). Tek kayit varsa tek elemanli. */
  function findAlternatives(item) {
    if (!database || !item) return [item];
    const matches = database.filter(r =>
      r._n_title === item._n_title &&
      r._n_orchestra === item._n_orchestra
    );
    // Yila gore sirala (null yillar en sona)
    matches.sort((a, b) => {
      if (a.year == null) return 1;
      if (b.year == null) return -1;
      return a.year - b.year;
    });
    return matches.length ? matches : [item];
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

  /** Alternatif rozet icin kisa etiket: "1945 · Instr." veya "1951 · Maida". */
  function altLabel(it) {
    const y = it.year != null ? it.year : "?";
    const s = (it.singer || "").trim();
    if (!s || /^instrumental$/i.test(s)) return `${y} · Instr.`;
    // Kantor adinin ilk parcasi (genelde soyad)
    const short = s.split(/\s+/).slice(-1)[0] || s;
    return `${y} · ${short}`;
  }

  /** Kayittan kart icerigi uret. `match.alternatives` varsa rozetler eklenir. */
  function renderCardBody(match, activeItem) {
    const it = activeItem || match.item;
    const approx = match.score > 0.3;
    const alternatives = match.alternatives || [match.item];
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

    // Alternatif kayit rozetleri (sadece 2+ kayit varsa goster)
    let altsHtml = "";
    if (alternatives.length > 1) {
      const chips = alternatives.map(a => {
        const isActive = a.id === it.id;
        return `<button class="alt-chip${isActive ? ' active' : ''}" data-alt-id="${esc(a.id)}" title="${esc(a.year || '')} ${esc(a.singer || '')}">${esc(altLabel(a))}</button>`;
      }).join("");
      altsHtml = `<div class="row alternatives"><span class="alt-label">📀 ${alternatives.length} kayıt:</span>${chips}</div>`;
    }

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
      ${altsHtml}
    `;
  }

  /** Karti goster veya gunceller. */
  async function showCard(match) {
    await ensureShadow();
    const card = shadowRoot.querySelector(".card");
    const sig = match.item.id + "|" + getTrackKey();
    // Ayni eslesme zaten gorunuyorsa yeniden cizme
    if (lastMatchSignature === sig && card.classList.contains("visible")) return;

    lastMatchSignature = sig;
    // Aktif kayit = match.item (varsayilan); kullanici rozet tikladiginda degisir
    const state = { active: match.item };
    const redraw = () => {
      card.innerHTML = renderCardBody(match, state.active);
      bindCardEvents(card, match, state, redraw);
    };
    redraw();
    card.classList.remove("visible");
    // Fade-in animasyonunu tetiklemek icin frame bekle
    requestAnimationFrame(() => card.classList.add("visible"));
  }

  /** Kart icindeki butonlara event binding yapar (her re-render'dan sonra cagrilir). */
  function bindCardEvents(card, match, state, redraw) {
    const closeBtn = card.querySelector(".close-btn");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        hideCard();
        setHiddenForCurrentTrack();
      });
    }

    const dragHandle = card.querySelector(".drag-handle");
    if (dragHandle) attachDrag(card, dragHandle);

    // Alternatif kayit rozetleri
    const alternatives = match.alternatives || [match.item];
    card.querySelectorAll(".alt-chip").forEach(chip => {
      chip.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = chip.getAttribute("data-alt-id");
        const newItem = alternatives.find(a => a.id === id);
        if (newItem && newItem.id !== state.active.id) {
          state.active = newItem;
          redraw();
        }
      });
    });
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
    if (!isOnPlayablePage()) {
      hideCard();
      return;
    }
    if (isHiddenForCurrentTrack()) {
      hideCard();
      return;
    }

    const query = getTrackQuery();
    if (!query) return;

    await loadDatabase();
    const match = findMatch(query);
    if (!match) {
      hideCard();
      return;
    }
    // Ayni sarki+orkestra kombinasyonundaki diger kayitlari ekle
    match.alternatives = findAlternatives(match.item);
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

  // Apple Music: audio element'leri, DOM ve poll ile parca degisimini yakala
  if (getPlatform() === "applemusic") {
    const attachMedia = (el) => {
      if (el._tangoBound) return;
      el._tangoBound = true;
      ["loadedmetadata", "play", "playing", "durationchange"].forEach(ev =>
        el.addEventListener(ev, () => scheduleRefresh(400))
      );
    };
    document.querySelectorAll("audio, video").forEach(attachMedia);
    new MutationObserver(muts => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.tagName === "AUDIO" || node.tagName === "VIDEO") attachMedia(node);
          else if (node.querySelectorAll) node.querySelectorAll("audio, video").forEach(attachMedia);
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });

    // Fallback poll: MediaSession/DOM baska yoldan degisirse
    let lastKey = null;
    setInterval(() => {
      const k = getTrackKey();
      if (k && k !== lastKey) {
        lastKey = k;
        scheduleRefresh(200);
      }
    }, 2000);
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
