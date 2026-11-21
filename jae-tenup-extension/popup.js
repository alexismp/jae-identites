const DEFAULT_OCR_URL = "https://jae-ocr-2500276981.europe-west1.run.app";

const ocrUrlInput = document.getElementById("ocrUrl");
const extractBtn = document.getElementById("extractBtn");
const statusEl = document.getElementById("status");

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = kind;
}

function waitForTabComplete(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Délai dépassé lors du chargement de la page équipe."));
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readPageTextInTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => (document.body ? document.body.innerText : "")
  });
  return (result || "").trim();
}

async function fetchTeamPageTextViaTab(url) {
  const createdTab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(createdTab.id);
    // Laisser le SPA Ten'Up terminer ses appels XHR et le rendu de la liste des joueurs
    await sleep(2200);
    return await readPageTextInTab(createdTab.id);
  } finally {
    await chrome.tabs.remove(createdTab.id);
  }
}

async function inspectMatchPage(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const matchText = document.body ? document.body.innerText : "";
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      const teamUrls = [];
      for (const a of anchors) {
        const href = a.href || "";
        if (
          (href.includes("/equipe/") || href.includes("/club/")) &&
          !teamUrls.includes(href)
        ) {
          teamUrls.push(href);
        }
      }
      return {
        matchText: matchText.slice(0, 12000),
        teamUrls: teamUrls.slice(0, 2)
      };
    }
  });
  return result;
}

async function init() {
  const stored = await chrome.storage.local.get("ocrUrl");
  ocrUrlInput.value = stored.ocrUrl || DEFAULT_OCR_URL;
}

extractBtn.addEventListener("click", async () => {
  const ocrUrl = (ocrUrlInput.value || DEFAULT_OCR_URL).trim().replace(/\/+$/, "");
  await chrome.storage.local.set({ ocrUrl });

  extractBtn.disabled = true;
  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.url || !activeTab.url.includes("tenup.fft.fr")) {
      setStatus("Ouvre d'abord une page de rencontre sur tenup.fft.fr.", "err");
      return;
    }

    setStatus("Lecture de la page de rencontre Ten'Up...");
    const matchInfo = await inspectMatchPage(activeTab.id);
    let team1Text = "";
    let team2Text = "";

    if (matchInfo.teamUrls.length >= 2) {
      setStatus("Ouverture automatique de l'Équipe 1...");
      team1Text = (await fetchTeamPageTextViaTab(matchInfo.teamUrls[0])).slice(0, 15000);

      setStatus("Ouverture automatique de l'Équipe 2...");
      team2Text = (await fetchTeamPageTextViaTab(matchInfo.teamUrls[1])).slice(0, 15000);
    } else if (matchInfo.teamUrls.length === 1) {
      setStatus("Ouverture de l'équipe détectée...");
      team1Text = (await fetchTeamPageTextViaTab(matchInfo.teamUrls[0])).slice(0, 15000);
    } else {
      setStatus("Aucun lien /equipe/ détecté — envoi du contenu de la page courante...");
    }

    setStatus("Extraction des joueurs par Vertex AI (jae-ocr)...");
    const response = await fetch(`${ocrUrl}/api/tenup/extract-roster`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenupUrl: activeTab.url,
        matchText: matchInfo.matchText,
        team1Text,
        team2Text
      })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || `Erreur serveur (${response.status})`);
    }

    const t1Count = (data.team1Players || []).length;
    const t2Count = (data.team2Players || []).length;
    setStatus(
      `Import réussi !\n${data.team1Name || "Équipe 1"} : ${t1Count} joueur(s)\n${data.team2Name || "Équipe 2"} : ${t2Count} joueur(s)`,
      "ok"
    );
  } catch (err) {
    setStatus(`Erreur : ${err.message}`, "err");
  } finally {
    extractBtn.disabled = false;
  }
});

init();
