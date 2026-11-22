const DEFAULT_OCR_URL = "https://jae-ocr-2500276981.europe-west1.run.app";

const ocrUrlInput = document.getElementById("ocrUrl");
const extractBtn = document.getElementById("extractBtn");
const statusEl = document.getElementById("status");
const openOcrLink = document.getElementById("openOcrLink");

function renderStatus(status) {
  if (!status) return;
  statusEl.textContent = status.text || "";
  statusEl.className = status.kind || "";
  extractBtn.disabled = Boolean(status.busy);
  if (openOcrLink) {
    if (status.kind === "ok") {
      const targetUrl = (ocrUrlInput.value || DEFAULT_OCR_URL).trim().replace(/\/+$/, "");
      openOcrLink.href = targetUrl;
      openOcrLink.style.display = "block";
    } else {
      openOcrLink.style.display = "none";
    }
  }
}

async function init() {
  const stored = await chrome.storage.local.get(["ocrUrl", "lastStatus"]);
  ocrUrlInput.value = stored.ocrUrl || DEFAULT_OCR_URL;
  if (stored.lastStatus && stored.lastStatus.busy) {
    renderStatus(stored.lastStatus);
  } else if (stored.lastStatus) {
    await chrome.storage.local.remove("lastStatus");
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.lastStatus) {
    renderStatus(changes.lastStatus.newValue);
  }
});

extractBtn.addEventListener("click", async () => {
  const ocrUrl = (ocrUrlInput.value || DEFAULT_OCR_URL).trim().replace(/\/+$/, "");
  await chrome.storage.local.set({ ocrUrl });
  extractBtn.disabled = true;
  statusEl.textContent = "Démarrage en arrière-plan...";
  statusEl.className = "";
  await chrome.runtime.sendMessage({ action: "EXTRACT_TENUP", ocrUrl });
});

init();
