// Popup UI - chrome.storage.sync'e yazar, aktif YouTube sekmesine mesaj gonderir.

const enabledEl = document.getElementById("enabled");
const thresholdEl = document.getElementById("threshold");
const thresholdValueEl = document.getElementById("thresholdValue");
const resetPosBtn = document.getElementById("resetPos");
const reloadBtn = document.getElementById("reload");
const statusEl = document.getElementById("status");

function setStatus(msg, cls = "ok") {
  statusEl.textContent = msg;
  statusEl.className = cls;
  setTimeout(() => {
    if (statusEl.textContent === msg) {
      statusEl.textContent = "";
      statusEl.className = "";
    }
  }, 2000);
}

// Mevcut ayarlari yukle
chrome.storage.sync.get({ enabled: true, threshold: 0.4 }, (data) => {
  enabledEl.checked = data.enabled;
  thresholdEl.value = data.threshold;
  thresholdValueEl.textContent = Number(data.threshold).toFixed(2);
});

// Toggle degisimi
enabledEl.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: enabledEl.checked });
  setStatus(enabledEl.checked ? "Etkinleştirildi" : "Devre dışı");
});

// Slider - anlik preview, release'te kaydet
thresholdEl.addEventListener("input", () => {
  thresholdValueEl.textContent = Number(thresholdEl.value).toFixed(2);
});
thresholdEl.addEventListener("change", () => {
  const v = parseFloat(thresholdEl.value);
  chrome.storage.sync.set({ threshold: v });
  setStatus("Hassasiyet: " + v.toFixed(2));
});

// Pozisyon sifirla
resetPosBtn.addEventListener("click", async () => {
  await chrome.storage.sync.set({ position: null });
  sendToActiveTab({ type: "resetPosition" });
  setStatus("Pozisyon sıfırlandı");
});

// Aktif sekmede yeniden yukle
reloadBtn.addEventListener("click", async () => {
  const ok = await sendToActiveTab({ type: "reload" });
  setStatus(ok ? "Yenilendi" : "Aktif YouTube sekmesi yok", ok ? "ok" : "err");
});

function sendToActiveTab(msg) {
  // tab.url okumak icin "tabs" izni gerekir; izin yoksa undefined gelir.
  // O yuzden URL kontrolu yerine direkt sendMessage deniyoruz - content
  // script yoksa runtime.lastError doner, biz onu "yok" olarak yorumlariz.
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab || !tab.id) {
        resolve(false);
        return;
      }
      chrome.tabs.sendMessage(tab.id, msg, (response) => {
        if (chrome.runtime.lastError) {
          // Content script yok = aktif sekme YouTube /watch degil
          resolve(false);
        } else {
          resolve(!!response);
        }
      });
    });
  });
}
