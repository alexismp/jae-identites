const DEFAULT_OCR_URL = "https://jae-ocr-2500276981.europe-west1.run.app";

const ocrUrlInput = document.getElementById("ocrUrl");
const extractBtn = document.getElementById("extractBtn");
const newMatchCheckbox = document.getElementById("newMatchCheckbox");
const statusEl = document.getElementById("status");
const openOcrLink = document.getElementById("openOcrLink");

const signedOutBox = document.getElementById("signedOutBox");
const signedInBox = document.getElementById("signedInBox");
const signedInEmailEl = document.getElementById("signedInEmail");
const loginBtn = document.getElementById("loginBtn");
const logoutBtn = document.getElementById("logoutBtn");

function renderAuth(authState) {
  if (authState && authState.email && authState.refreshToken) {
    signedOutBox.style.display = "none";
    signedInBox.style.display = "flex";
    signedInEmailEl.textContent = authState.email;
    extractBtn.disabled = false;
  } else {
    signedOutBox.style.display = "block";
    signedInBox.style.display = "none";
    extractBtn.disabled = true;
  }
}

function renderStatus(status) {
  if (!status) return;
  statusEl.textContent = status.text || "";
  statusEl.className = status.kind || "";
  if (status.busy) {
    extractBtn.disabled = true;
  }
  if (openOcrLink) {
    if (status.kind === "ok") {
      const baseUrl = (ocrUrlInput.value || DEFAULT_OCR_URL).trim().replace(/\/+$/, "");
      openOcrLink.href = status.matchId ? `${baseUrl}/m/${encodeURIComponent(status.matchId)}` : baseUrl;
      openOcrLink.style.display = "block";
    } else {
      openOcrLink.style.display = "none";
    }
  }
}

async function init() {
  const stored = await chrome.storage.local.get(["ocrUrl", "lastStatus", "fbAuth"]);
  ocrUrlInput.value = stored.ocrUrl || DEFAULT_OCR_URL;
  renderAuth(stored.fbAuth || null);
  if (stored.lastStatus && stored.lastStatus.busy) {
    renderStatus(stored.lastStatus);
  } else if (stored.lastStatus) {
    await chrome.storage.local.remove("lastStatus");
  }
}

loginBtn.addEventListener("click", async () => {
  const ocrUrl = (ocrUrlInput.value || DEFAULT_OCR_URL).trim().replace(/\/+$/, "");
  await chrome.storage.local.set({ ocrUrl });
  statusEl.textContent = "Ouverture de la connexion OAuth...";
  statusEl.className = "";
  await chrome.runtime.sendMessage({ action: "START_OAUTH", ocrUrl });
});

logoutBtn.addEventListener("click", async () => {
  await chrome.storage.local.remove("fbAuth");
  renderAuth(null);
  statusEl.textContent = "Déconnecté.";
  statusEl.className = "";
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.lastStatus) {
    renderStatus(changes.lastStatus.newValue);
  }
  if (areaName === "local" && changes.fbAuth) {
    renderAuth(changes.fbAuth.newValue);
  }
});

extractBtn.addEventListener("click", async () => {
  const ocrUrl = (ocrUrlInput.value || DEFAULT_OCR_URL).trim().replace(/\/+$/, "");
  const newMatch = Boolean(newMatchCheckbox && newMatchCheckbox.checked);
  await chrome.storage.local.set({ ocrUrl });
  extractBtn.disabled = true;
  statusEl.textContent = "Démarrage en arrière-plan...";
  statusEl.className = "";
  await chrome.runtime.sendMessage({ action: "EXTRACT_TENUP", ocrUrl, newMatch });
});

init();
