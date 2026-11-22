importScripts("parser.js");

const DEFAULT_OCR_URL = "https://jae-ocr-2500276981.europe-west1.run.app";
const FIREBASE_API_KEY = "AIzaSyDQ2viUbTqy-lwz_EUf_YLrYiWfTOkRPPw";

async function setStatus(text, kind = "", busy = false, matchId = null) {
  console.log("[JAE Ten'Up]", kind || "info", text);
  await chrome.storage.local.set({
    lastStatus: { text, kind, busy, matchId, updatedAt: Date.now() }
  });
}

async function getValidFirebaseToken() {
  const { fbAuth } = await chrome.storage.local.get(["fbAuth"]);
  if (!fbAuth || !fbAuth.refreshToken) {
    throw new Error("Connecte-toi d'abord dans la popup de l'extension.");
  }
  if (fbAuth.idToken && fbAuth.expiresAt && Date.now() < fbAuth.expiresAt) {
    return fbAuth.idToken;
  }
  const resp = await fetch(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(fbAuth.refreshToken)}`
  });
  if (!resp.ok) {
    throw new Error("Session expirée : reconnecte-toi dans la popup.");
  }
  const data = await resp.json();
  const updated = {
    email: fbAuth.email,
    idToken: data.id_token,
    refreshToken: data.refresh_token || fbAuth.refreshToken,
    expiresAt: Date.now() + Math.max(60, parseInt(data.expires_in || "3600", 10) - 120) * 1000
  };
  await chrome.storage.local.set({ fbAuth: updated });
  return updated.idToken;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function readTeamDomInTab(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const h1 = document.querySelector("h1");
      const headingTeamName = (h1 ? h1.textContent : "").trim();

      const norm = (s) =>
        String(s || "")
          .toLowerCase()
          .replace(/[\u2018\u2019']/g, "'")
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .trim();

      let rosterSection = null;
      for (const section of document.querySelectorAll("main section")) {
        const heading = section.querySelector("h2, h3, h4");
        if (heading && norm(heading.textContent).startsWith("l'equipe")) {
          rosterSection = section;
          break;
        }
      }
      if (!rosterSection) {
        rosterSection = document.querySelector("body > main > div.space-y-8 > div:nth-child(3)");
      }

      // Utiliser textContent (et non innerText) car Chrome ne calcule pas toujours le layout dans un onglet inactif
      const cards = rosterSection ? Array.from(rosterSection.querySelectorAll('[data-slot="card"]')) : [];
      const structuredPlayers = [];
      const rankingRegex = /^(NC|40|30\/[1-5]|30|15\/[1-5]|15|[1-5]\/6|0|-2\/6|-4\/6|-15|N\d+)$/i;

      for (const card of cards) {
        const profileLink = card.querySelector('a[href*="/profil/"]');
        const fullName = (profileLink ? profileLink.textContent : "").replace(/\s+/g, " ").trim();
        if (!fullName) continue;

        const metaSpans = Array.from(card.querySelectorAll("span"))
          .map((s) => (s.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean);

        let age = "";
        let statut = "";
        let nationalite = "";
        for (const txt of metaSpans) {
          if (/^\d+\s*ans$/i.test(txt)) {
            age = txt;
          } else if (/^(EQ|NvEQ)\s*-\s*[A-Z]{2,3}$/i.test(txt)) {
            const parts = txt.split("-").map((p) => p.trim());
            statut = parts[0] || "";
            nationalite = parts[1] || "";
          }
        }

        let classement = "";
        for (const el of card.querySelectorAll("div, span")) {
          const t = (el.textContent || "").trim();
          if (rankingRegex.test(t)) {
            classement = t.toUpperCase();
            break;
          }
        }

        structuredPlayers.push({ fullName, age, statut, nationalite, classement });
      }

      return {
        pageUrl: location.href,
        headingTeamName,
        hasRosterEl: Boolean(rosterSection),
        cardCount: cards.length,
        structuredPlayers,
        rosterText: rosterSection ? (rosterSection.textContent || "") : "",
        rawText: document.body ? (document.body.textContent || "") : ""
      };
    }
  });

  if (result.structuredPlayers && result.structuredPlayers.length > 0) {
    const players = result.structuredPlayers
      .map((p) => {
        const split = self.JaeTenupParser.splitFullName(p.fullName);
        if (!split) return null;
        return {
          prenom: split.prenom,
          nom: split.nom,
          classement: p.classement || "",
          statut: p.statut || "",
          nationalite: p.nationalite || "",
          age: p.age || ""
        };
      })
      .filter(Boolean);

    return {
      ready: true,
      teamName: result.headingTeamName,
      players
    };
  }

  const parsed = result.hasRosterEl && result.rosterText.trim()
    ? self.JaeTenupParser.parseTeamText(result.rosterText, result.headingTeamName, false)
    : self.JaeTenupParser.parseTeamText(result.rawText, result.headingTeamName, true);

  if (parsed.players.length === 0) {
    console.log("[JAE Ten'Up] Debug DOM (0 joueurs détectés) :", {
      pageUrl: result.pageUrl,
      headingTeamName: result.headingTeamName,
      hasRosterEl: result.hasRosterEl,
      cardCount: result.cardCount,
      ready: parsed.ready,
      snippet: (result.rosterText || result.rawText || "").slice(0, 800)
    });
  }
  return parsed;
}

async function fetchTeamFromUrl(url, originTabId) {
  // Ten'Up (Next.js) utilise requestAnimationFrame pour hydrater la section "L'équipe" :
  // Chrome suspend requestAnimationFrame dans les onglets inactifs, donc on active brièvement l'onglet
  // puis on revient immédiatement sur l'onglet de la rencontre.
  const createdTab = await chrome.tabs.create({ url, active: true });
  try {
    await waitForTabComplete(createdTab.id);
    let parsed = { ready: false, teamName: "", players: [] };
    for (let attempt = 0; attempt < 20; attempt++) {
      parsed = await readTeamDomInTab(createdTab.id);
      if (parsed.ready && parsed.players.length > 0) break;
      await sleep(400);
    }
    return parsed;
  } finally {
    await chrome.tabs.remove(createdTab.id);
    if (originTabId) {
      await chrome.tabs.update(originTabId, { active: true }).catch(() => {});
    }
  }
}

async function findTeamLinksOnMatchPage(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const container =
        document.querySelector(
          "body > main > div:nth-child(2) > div > div.mb-6.rounded-md.bg-white.p-5.shadow-tu-sm.max-sm\\:-mx-4 > div"
        ) || document.querySelector("main div.rounded-md.bg-white.shadow-tu-sm > div");

      const ignoredLinkLabels = /^(panier|connexion|mon compte|rechercher|accueil|retour|partager|imprimer|aide|menu)$/i;

      const collectLinks = (root, requireTeamPath) => {
        if (!root) return [];
        const anchors = Array.from(root.querySelectorAll("a[href]"));
        const found = [];
        for (const a of anchors) {
          if (a.closest("header, nav, footer")) continue;
          const href = a.href || "";
          const label = (a.innerText || "").trim();
          if (!href || !label || label.length < 2) continue;
          if (ignoredLinkLabels.test(label) || href.includes("panier")) continue;
          if (requireTeamPath && !(href.includes("/equipe") || href.includes("/club/"))) {
            continue;
          }
          if (!found.some((item) => item.href === href)) {
            found.push({ href, label });
          }
        }
        return found.slice(0, 2);
      };

      // 1. Priorité au bloc officiel de la rencontre Ten'Up
      const fromContainer = collectLinks(container, false);
      if (fromContainer.length > 0) return fromContainer;

      // 2. Fallback limité à <main> uniquement (jamais la barre de navigation / panier)
      return collectLinks(document.querySelector("main") || document, true);
    }
  });
  return result || [];
}

async function runExtraction(ocrUrl, newMatch = false) {
  await setStatus("Vérification de la session JAE...", "", true);
  try {
    const idToken = await getValidFirebaseToken();
    const authFetch = (url, opts = {}) => {
      const headers = Object.assign({}, opts.headers || {}, { Authorization: `Bearer ${idToken}` });
      return fetch(url, Object.assign({}, opts, { headers }));
    };

    await setStatus("Recherche des 2 équipes sur la page Ten'Up...", "", true);
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab || !activeTab.url || !activeTab.url.includes("tenup.fft.fr")) {
      await setStatus("Ouvre d'abord une page de rencontre sur tenup.fft.fr.", "err", false);
      return;
    }

    const tenupMatchId = self.JaeTenupParser.extractTenupMatchId(activeTab.url);
    const teamLinks = await findTeamLinksOnMatchPage(activeTab.id);
    console.log("[JAE Ten'Up] Liens équipes trouvés :", teamLinks, "tenupMatchId:", tenupMatchId);

    if (teamLinks.length === 0) {
      const direct = await readTeamDomInTab(activeTab.id);
      if (direct.ready && direct.players.length > 0) {
        await setStatus(`Section L'équipe lue (${direct.players.length} joueurs). Envoi...`, "", true);
        const saved = await self.JaeTenupParser.postRosterSafe(authFetch, ocrUrl, {
          newMatch,
          tenupMatchId,
          tenupUrl: activeTab.url,
          team1Name: direct.teamName,
          team1Players: direct.players,
          team2Name: "",
          team2Players: []
        });
        const matchId = saved && saved.matchId ? saved.matchId : null;
        await setStatus(`Importé : ${direct.teamName || "Équipe 1"} (${direct.players.length} joueurs).`, "ok", false, matchId);
        await chrome.tabs.create({ url: matchId ? `${ocrUrl}/m/${encodeURIComponent(matchId)}` : ocrUrl, active: true });
        return;
      }
      await setStatus("Aucun lien d'équipe trouvé sur cette page Ten'Up.", "err", false);
      return;
    }

    await setStatus(`Lecture DOM L'équipe : ${teamLinks[0].label}...`, "", true);
    const t1 = await fetchTeamFromUrl(teamLinks[0].href, activeTab.id);

    let t2 = { teamName: "", players: [] };
    if (teamLinks.length >= 2) {
      await setStatus(`Lecture DOM L'équipe : ${teamLinks[1].label}...`, "", true);
      t2 = await fetchTeamFromUrl(teamLinks[1].href, activeTab.id);
    }

    const payload = {
      newMatch,
      tenupMatchId,
      tenupUrl: activeTab.url,
      team1Name: t1.teamName || teamLinks[0]?.label || "Équipe 1",
      team1Players: t1.players || [],
      team2Name: t2.teamName || teamLinks[1]?.label || "Équipe 2",
      team2Players: t2.players || []
    };

    await setStatus("Envoi des compositions vers JAE-OCR (sans LLM)...", "", true);
    const saved = await self.JaeTenupParser.postRosterSafe(authFetch, ocrUrl, payload);
    const matchId = saved && saved.matchId ? saved.matchId : null;

    await setStatus(
      `Import réussi !\n${payload.team1Name} : ${payload.team1Players.length} joueur(s)\n${payload.team2Name} : ${payload.team2Players.length} joueur(s)`,
      "ok",
      false,
      matchId
    );
    await chrome.tabs.create({ url: matchId ? `${ocrUrl}/m/${encodeURIComponent(matchId)}` : ocrUrl, active: true });
  } catch (err) {
    await setStatus(`Erreur : ${err.message}`, "err", false);
  }
}

async function runOAuthFlow(ocrUrl) {
  const tab = await chrome.tabs.create({ url: `${ocrUrl}/ext-auth`, active: true });
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const el = document.getElementById("jaeExtAuthPayload");
          return el ? el.textContent : null;
        }
      });
      if (result) {
        const parsed = JSON.parse(result);
        if (parsed && parsed.idToken && parsed.refreshToken) {
          await chrome.storage.local.set({
            fbAuth: {
              email: parsed.email || "",
              idToken: parsed.idToken,
              refreshToken: parsed.refreshToken,
              expiresAt: Date.now() + 50 * 60 * 1000
            }
          });
          await setStatus(`Connecté via OAuth (${parsed.email}) !`, "ok", false);
          try { await chrome.tabs.remove(tab.id); } catch (_) {}
          return;
        }
      }
    } catch (_) {
      // Onglet fermé ou navigation OAuth en cours
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message && message.action === "EXTRACT_TENUP") {
    const ocrUrl = (message.ocrUrl || DEFAULT_OCR_URL).trim().replace(/\/+$/, "");
    runExtraction(ocrUrl, Boolean(message.newMatch));
    sendResponse({ started: true });
  } else if (message && message.action === "START_OAUTH") {
    const ocrUrl = (message.ocrUrl || DEFAULT_OCR_URL).trim().replace(/\/+$/, "");
    runOAuthFlow(ocrUrl);
    sendResponse({ started: true });
  }
  return false;
});
