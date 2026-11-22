const RANKING_REGEX = /^(NC|40|30\/[1-5]|30|15\/[1-5]|15|[1-5]\/6|0|-2\/6|-4\/6|-15|N\d+)$/i;
const TRAILING_RANKING_REGEX = /\s+[-–—]?\s*(NC|40|30\/[1-5]|30|15\/[1-5]|15|[1-5]\/6|0|-2\/6|-4\/6|-15|N\d+)$/i;

function normalizeText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\u2018\u2019']/g, "'")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function splitFullName(line) {
  const cleaned = line
    .replace(/\b(capitaine|cap\.?|joueur|joueuse|homme|femme)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  const upperTokens = tokens.filter((t) => t === t.toUpperCase() && /[A-ZÀ-ÖØ-Þ]/.test(t));
  const otherTokens = tokens.filter((t) => !upperTokens.includes(t));

  if (upperTokens.length > 0 && otherTokens.length > 0) {
    return {
      prenom: otherTokens.join(" "),
      nom: upperTokens.join(" "),
      classement: ""
    };
  }
  return {
    prenom: tokens[0],
    nom: tokens.slice(1).join(" ").toUpperCase(),
    classement: ""
  };
}

/**
 * Parse le texte brut d'une fiche équipe Ten'Up à partir de l'intitulé "L'équipe"
 * (ou directement depuis le conteneur exact de composition si requireHeader=false).
 * Pur JS, aucun LLM requis.
 */
function parseTeamText(rawText, headingTeamName = "", requireHeader = true) {
  const lines = String(rawText || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return { ready: false, teamName: headingTeamName.trim(), players: [] };
  }

  let startIdx = -1;
  if (requireHeader) {
    startIdx = lines.findIndex((l) => {
      const n = normalizeText(l);
      return n === "l'equipe" || n.startsWith("l'equipe ") || n.startsWith("l'equipe(");
    });
    if (startIdx === -1) {
      return { ready: false, teamName: headingTeamName.trim(), players: [] };
    }
  } else {
    // Si on cible directement le conteneur div:nth-child(3), sauter l'entête "L'équipe" s'il est en première ligne
    const firstNorm = normalizeText(lines[0]);
    if (firstNorm === "l'equipe" || firstNorm.startsWith("l'equipe ") || firstNorm.startsWith("l'equipe(")) {
      startIdx = 0;
    }
  }

  const stopHeaders = new Set([
    "capitaine",
    "correspondant",
    "juge-arbitre",
    "juge arbitre",
    "rencontres",
    "calendrier",
    "resultats",
    "classement de la poule",
    "coordonnees",
    "mentions legales",
    "a propos"
  ]);

  const ignoredLabels = /^(joueurs?|classement|nom|prenom|age|sexe|h|f|homme|femme|licence|n°|rang|points?)$/i;
  const players = [];
  const seenKeys = new Set();
  let pendingPlayer = null;

  function pushPlayer(player) {
    if (!player || !player.nom || !player.prenom) return;
    const key = `${normalizeText(player.nom)}|${normalizeText(player.prenom)}`;
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    players.push(player);
  }

  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    const n = normalizeText(line);

    if (
      stopHeaders.has(n) ||
      n.startsWith("capitaine :") ||
      n.startsWith("correspondant :") ||
      n.startsWith("juge-arbitre :")
    ) {
      break;
    }

    if (RANKING_REGEX.test(line)) {
      if (pendingPlayer) {
        pendingPlayer.classement = line.toUpperCase();
        pushPlayer(pendingPlayer);
        pendingPlayer = null;
      } else if (players.length > 0 && !players[players.length - 1].classement) {
        players[players.length - 1].classement = line.toUpperCase();
      }
      continue;
    }

    if (/^\d+$/.test(line) || line.length < 3 || ignoredLabels.test(n)) {
      continue;
    }

    if (pendingPlayer) {
      pushPlayer(pendingPlayer);
      pendingPlayer = null;
    }

    // Cas 1 : nom + classement sur la même ligne (ex. "Alexis MOUSSINE POUCHKINE 15/2")
    const inlineMatch = line.match(TRAILING_RANKING_REGEX);
    if (inlineMatch) {
      const namePart = line.slice(0, inlineMatch.index).trim();
      const parsed = splitFullName(namePart);
      if (parsed) {
        parsed.classement = inlineMatch[1].toUpperCase();
        pushPlayer(parsed);
      }
      continue;
    }

    // Cas 2 : nom seul sur la ligne (classement éventuellement sur la ligne suivante)
    const parsed = splitFullName(line);
    if (parsed) {
      pendingPlayer = parsed;
    }
  }

  if (pendingPlayer) {
    pushPlayer(pendingPlayer);
  }

  return {
    ready: true,
    teamName: headingTeamName.trim(),
    players
  };
}

/**
 * Envoie les compositions à POST /api/tenup/roster en gérant proprement
 * les réponses non-JSON (ex. HTML 404/405/502) sans jamais lever Unexpected token '<'.
 */
async function postRosterSafe(fetchFn, ocrUrl, payload) {
  const endpoint = `${String(ocrUrl || "").trim().replace(/\/+$/, "")}/api/tenup/roster`;
  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const rawText = await response.text();
  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const serverMsg = parsed && parsed.error ? parsed.error : `HTTP ${response.status} (réponse non JSON)`;
    throw new Error(`Échec envoi vers ${endpoint} : ${serverMsg}`);
  }

  if (!parsed) {
    throw new Error(`Réponse inattendue (non JSON) reçue depuis ${endpoint}`);
  }

  return parsed;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { normalizeText, splitFullName, parseTeamText, postRosterSafe };
} else {
  self.JaeTenupParser = { normalizeText, splitFullName, parseTeamText, postRosterSafe };
}
