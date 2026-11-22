const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTeamText, postRosterSafe, extractTenupMatchId } = require("./parser.js");

test("parseTeamText extrait les joueurs sous L'équipe (format multi-lignes Ten'Up)", () => {
  const sample = `
    RUEIL ATHLETIC CLUB 1
    Division 1 - Poule A
    L'équipe
    Joueurs
    Classement
    Alexis MOUSSINE POUCHKINE
    15/2
    Léa MARTIN
    15/4
    Jean-Luc DE LA FONTAINE
    30
    Capitaine
    Marc DUPONT
    Correspondant
    Sophie DURAND
  `;

  const res = parseTeamText(sample, "RUEIL ATHLETIC CLUB 1");
  assert.equal(res.ready, true);
  assert.equal(res.teamName, "RUEIL ATHLETIC CLUB 1");
  assert.equal(res.players.length, 3);
  assert.deepEqual(res.players[0], {
    prenom: "Alexis",
    nom: "MOUSSINE POUCHKINE",
    classement: "15/2"
  });
  assert.deepEqual(res.players[1], {
    prenom: "Léa",
    nom: "MARTIN",
    classement: "15/4"
  });
  assert.deepEqual(res.players[2], {
    prenom: "Jean-Luc",
    nom: "DE LA FONTAINE",
    classement: "30"
  });
});

test("parseTeamText gère l'apostrophe typographique et le classement sur la même ligne", () => {
  const sample = `
    MONTROUGE (CA) 1
    L’équipe (2)
    Nicolas SEVESTRE 15
    Romain SOLAL - 5/6
    Nicolas SEVESTRE 15
    Rencontres
    Journée 1
  `;

  const res = parseTeamText(sample, "MONTROUGE (CA) 1");
  assert.equal(res.ready, true);
  assert.equal(res.players.length, 2);
  assert.deepEqual(res.players[0], {
    prenom: "Nicolas",
    nom: "SEVESTRE",
    classement: "15"
  });
  assert.deepEqual(res.players[1], {
    prenom: "Romain",
    nom: "SOLAL",
    classement: "5/6"
  });
});

test("parseTeamText retourne ready=false si la section L'équipe n'est pas encore chargée", () => {
  const res = parseTeamText("Chargement en cours...", "Club");
  assert.equal(res.ready, false);
  assert.deepEqual(res.players, []);
});

test("parseTeamText fonctionne en mode conteneur direct (requireHeader=false)", () => {
  const directBlock = `
    Alexis MOUSSINE POUCHKINE
    15/2
    Léa MARTIN
    15/4
  `;
  const res = parseTeamText(directBlock, "RUEIL ATHLETIC CLUB 1", false);
  assert.equal(res.ready, true);
  assert.equal(res.players.length, 2);
});

test("postRosterSafe gère une réponse HTML 405 sans crasher Unexpected token '<'", async () => {
  const fakeFetchHtml405 = async () => ({
    ok: false,
    status: 405,
    text: async () => "<!doctype html><title>405 Method Not Allowed</title>"
  });

  await assert.rejects(
    () => postRosterSafe(fakeFetchHtml405, "https://example.run.app", { team1Name: "A" }),
    /HTTP 405 \(réponse non JSON\)/
  );
});

test("postRosterSafe réussit sur une réponse JSON 200 OK", async () => {
  const fakeFetchOk = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ team1Name: "RUEIL", team1Players: [{ nom: "MARTIN", prenom: "Léa" }] })
  });

  const data = await postRosterSafe(fakeFetchOk, "https://example.run.app/", { team1Name: "RUEIL" });
  assert.equal(data.team1Name, "RUEIL");
  assert.equal(data.team1Players.length, 1);
});

test("extractTenupMatchId extrait l'identifiant de rencontre depuis une URL Ten'Up", () => {
  assert.equal(
    extractTenupMatchId("https://tenup.fft.fr/championnat/82661719/division/143390/phase/232494/rencontre/9963029"),
    "9963029"
  );
  assert.equal(
    extractTenupMatchId("https://tenup.fft.fr/championnat/1/rencontre/42819/?tab=equipes"),
    "42819"
  );
  assert.equal(extractTenupMatchId("https://tenup.fft.fr/accueil"), null);
});
