document.addEventListener('DOMContentLoaded', function () {
    var h1Element = document.querySelector('h1');
    var team1Title = document.querySelector('#team1').previousElementSibling;
    var team2Title = document.querySelector('#team2').previousElementSibling;

    function updateH1() {
        var today = new Date();
        var options = { year: 'numeric', month: 'long', day: 'numeric' };
        var formattedDate = today.toLocaleDateString('fr-FR', options);
        var team1Name = team1Title.textContent.trim();
        var team2Name = team2Title.textContent.trim();
        var titleText = "Rencontre du " + formattedDate + " - " + team1Name + " vs. " + team2Name;

        document.title = titleText;
        if (h1Element) {
            h1Element.textContent = titleText;
        }
    }

    // Initial update
    updateH1();

    // Add event listeners to team titles
    team1Title.addEventListener('input', updateH1);
    team2Title.addEventListener('input', updateH1);

    var officials = document.getElementById('officials');
    var team1 = document.getElementById('team1');
    var team2 = document.getElementById('team2');
    var unassigned = document.getElementById('unassigned');

    var toggleButton = document.getElementById('toggleView');
    var body = document.body;

    toggleButton.addEventListener('click', function () {
        body.classList.toggle('condensed-view');
        if (body.classList.contains('condensed-view')) {
            toggleButton.textContent = 'Vue Complète';
        } else {
            toggleButton.textContent = 'Vue Condensée';
        }
    });

    new Sortable(officials, {
        group: 'shared',
        animation: 150
    });

    new Sortable(team1, {
        group: 'shared',
        animation: 150,
        onAdd: function (evt) {
            var item = evt.item; // dragged HTMLElement
            var to = evt.to; // target list

            // Check if it's the first item dropped into this team section
            if (to.children.length === 1) {
                var clubElement = item.querySelector('p:nth-child(6)'); // Assuming Club is the 6th p tag
                if (clubElement) {
                    var clubName = clubElement.textContent.replace('Club:', '').trim();
                    var teamTitle = to.previousElementSibling; // The h2 element
                    if (teamTitle && teamTitle.tagName === 'H2') {
                        teamTitle.textContent = clubName;
                        updateH1(); // Update H1 after team name changes
                    }
                }
            }
        }
    });

    new Sortable(team2, {
        group: 'shared',
        animation: 150,
        onAdd: function (evt) {
            var item = evt.item; // dragged HTMLElement
            var to = evt.to; // target list

            // Check if it's the first item dropped into this team section
            if (to.children.length === 1) {
                var clubElement = item.querySelector('p:nth-child(6)'); // Assuming Club is the 6th p tag
                if (clubElement) {
                    var clubName = clubElement.textContent.replace('Club:', '').trim();
                    var teamTitle = to.previousElementSibling; // The h2 element
                    if (teamTitle && teamTitle.tagName === 'H2') {
                        teamTitle.textContent = clubName;
                        updateH1(); // Update H1 after team name changes
                    }
                }
            }
        }
    });

    new Sortable(unassigned, {
        group: 'shared',
        animation: 150
    });

    var exportBtn = document.getElementById('exportBtn');
    var importBtn = document.getElementById('importBtn');
    var importFile = document.getElementById('importFile');
    var tenupUrlInput = document.getElementById('tenupUrlInput');
    var tenupUrlLink = document.getElementById('tenupUrlLink');
    const TENUP_URL_STORAGE_KEY = 'jae_tenup_match_url';

    function updateTenupLink(urlValue) {
        const trimmed = (urlValue || '').trim();
        const isValid = /^https?:\/\/.+/i.test(trimmed);
        if (tenupUrlLink) {
            if (isValid) {
                tenupUrlLink.href = trimmed;
                tenupUrlLink.classList.remove('disabled');
                tenupUrlLink.setAttribute('aria-disabled', 'false');
            } else {
                tenupUrlLink.href = '#';
                tenupUrlLink.classList.add('disabled');
                tenupUrlLink.setAttribute('aria-disabled', 'true');
            }
        }
    }

    if (tenupUrlInput) {
        const savedUrl = localStorage.getItem(TENUP_URL_STORAGE_KEY) || '';
        tenupUrlInput.value = savedUrl;
        updateTenupLink(savedUrl);
        tenupUrlInput.addEventListener('input', function () {
            localStorage.setItem(TENUP_URL_STORAGE_KEY, tenupUrlInput.value.trim());
            updateTenupLink(tenupUrlInput.value);
        });
    }

    exportBtn.addEventListener('click', function () {
        var h1Text = h1Element.textContent.trim().replace(/ /g, '_');
        var filename = h1Text + '.json';

        var data = {
            title: h1Element.textContent.trim(),
            tenupUrl: tenupUrlInput ? tenupUrlInput.value.trim() : '',
            team1Name: team1Title.textContent.trim(),
            team2Name: team2Title.textContent.trim(),
            officials: getSectionData(officials),
            team1: getSectionData(team1),
            team2: getSectionData(team2),
            unassigned: getSectionData(unassigned)
        };

        var dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
        var downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", filename);
        document.body.appendChild(downloadAnchorNode); // required for firefox
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    });

    importBtn.addEventListener('click', function () {
        importFile.click();
    });

    importFile.addEventListener('change', function () {
        var file = this.files[0];
        if (file) {
            var reader = new FileReader();
            reader.onload = function (e) {
                try {
                    var data = JSON.parse(e.target.result);

                    // Update titles & Ten'Up URL
                    h1Element.textContent = data.title;
                    team1Title.textContent = data.team1Name;
                    team2Title.textContent = data.team2Name;
                    if (tenupUrlInput) {
                        tenupUrlInput.value = data.tenupUrl || '';
                        localStorage.setItem(TENUP_URL_STORAGE_KEY, tenupUrlInput.value);
                        updateTenupLink(tenupUrlInput.value);
                    }

                    // Clear existing sections
                    officials.innerHTML = '';
                    team1.innerHTML = '';
                    team2.innerHTML = '';
                    unassigned.innerHTML = '';

                    // Create and append cards
                    Object.keys(data).forEach(function (section) {
                        if (['officials', 'team1', 'team2', 'unassigned'].includes(section)) {
                            var sectionElement = document.getElementById(section);
                            if (sectionElement) {
                                data[section].forEach(function (participant) {
                                    var card = createParticipantCard(participant);
                                    sectionElement.appendChild(card);
                                });
                            }
                        }
                    });
                } catch (e) {
                    alert('Error parsing JSON file');
                }
            };
            reader.readAsText(file);
        }
    });

    function getSectionData(sectionElement) {
        return Array.from(sectionElement.children).map(function (item) {
            const nomEl = item.querySelector('p:nth-child(1)');
            const prenomEl = item.querySelector('p:nth-child(2)');
            const classementEl = item.querySelector('p:nth-child(3)');
            const licenceEl = item.querySelector('.card-detail:nth-of-type(1)');
            const anneeValiditeEl = item.querySelector('.card-detail:nth-of-type(2)');
            const clubEl = item.querySelector('.card-detail:nth-of-type(3)');
            const statutEl = item.querySelector('.card-detail:nth-of-type(4)');
            const idCheckedEl = item.querySelector('input[type="checkbox"]');
            const imageUriEl = item.querySelector('a');

            return {
                id: item.dataset.id,
                nom: nomEl ? nomEl.textContent.replace('Nom:', '').trim() : '',
                prenom: prenomEl ? prenomEl.textContent.replace('Prénom:', '').trim() : '',
                classement: classementEl ? classementEl.textContent.replace('Classement:', '').trim() : '',
                licence: licenceEl ? licenceEl.textContent.replace('Licence:', '').trim() : '',
                annee_validite: anneeValiditeEl ? anneeValiditeEl.textContent.replace('Année validité:', '').trim() : '',
                club: clubEl ? clubEl.textContent.replace('Club:', '').trim() : '',
                statut: statutEl ? statutEl.textContent.replace('Statut:', '').trim() : '',
                id_checked: idCheckedEl ? idCheckedEl.checked : false,
                image_uri: imageUriEl ? imageUriEl.href : null
            };
        });
    }

    function createParticipantCard(participant) {
        var card = document.createElement('div');
        card.className = 'list-group-item participant-card';
        card.dataset.id = participant.licence;

        card.innerHTML = `
            <p><strong>Nom:</strong> ${participant.image_uri ? `<a href="${participant.image_uri}" target="_blank">${participant.nom}</a>` : participant.nom}</p>
            <p><strong>Prénom:</strong> ${participant.prenom}</p>
            <p><strong>Classement:</strong> ${participant.classement}</p>
            <p class="card-detail"><strong>Licence:</strong> ${participant.licence}</p>
            <p class="card-detail"><strong>Année validité:</strong> ${participant.annee_validite}</p>
            <p class="card-detail"><strong>Club:</strong> ${participant.club}</p>
            <p class="card-detail"><strong>Statut:</strong> ${participant.statut}</p>
            <div class="form-check card-detail">
                <input class="form-check-input" type="checkbox" ${participant.id_checked ? 'checked' : ''}>
                <label class="form-check-label">Pièce d'identité</label>
            </div>
        `;
        return card;
    }

    const isDebugMode = (new URLSearchParams(window.location.search).get('debug') || '').toLowerCase() === 'true';

    function clearBoardUi() {
        officials.innerHTML = '';
        team1.innerHTML = '';
        team2.innerHTML = '';
        unassigned.innerHTML = '';
        team1Title.textContent = 'Equipe 1';
        team2Title.textContent = 'Equipe 2';
        if (tenupUrlInput) {
            tenupUrlInput.value = '';
            localStorage.removeItem(TENUP_URL_STORAGE_KEY);
            updateTenupLink('');
        }
        updateH1();
    }

    var loadTestDataBtn = document.getElementById('loadTestDataBtn');
    if (loadTestDataBtn) {
        loadTestDataBtn.addEventListener('click', function () {
            loadTestDataBtn.disabled = true;
            fetch('/api/test-data')
                .then(response => {
                    if (!response.ok) throw new Error('Erreur serveur (' + response.status + ')');
                    return response.json();
                })
                .then(data => {
                    clearBoardUi();
                    data.forEach(participant => {
                        unassigned.appendChild(createParticipantCard(participant));
                    });
                })
                .catch(err => alert('Impossible de charger le jeu de test : ' + err.message))
                .finally(() => {
                    loadTestDataBtn.disabled = false;
                });
        });
    }

    var clearDebugMatchBtn = document.getElementById('clearDebugMatchBtn');
    if (clearDebugMatchBtn) {
        clearDebugMatchBtn.addEventListener('click', function () {
            clearBoardUi();
        });
    }

    var resetMatchBtn = document.getElementById('resetMatchBtn');
    if (resetMatchBtn) {
        resetMatchBtn.addEventListener('click', function () {
            if (!confirm("Archiver les résultats actuels et repartir d'une rencontre vierge ?")) {
                return;
            }
            resetMatchBtn.disabled = true;
            fetch('/api/reset-match', { method: 'POST' })
                .then(response => {
                    if (!response.ok) throw new Error('Erreur serveur (' + response.status + ')');
                    return response.json();
                })
                .then(() => {
                    clearBoardUi();
                })
                .catch(err => alert('Impossible de réinitialiser la rencontre : ' + err.message))
                .finally(() => {
                    resetMatchBtn.disabled = false;
                });
        });
    }

    // Polling logic (désactivé en mode debug pour préserver la rencontre vierge ou le jeu de test chargé)
    function pollParticipants() {
        if (isDebugMode) return;
        fetch('/api/participants')
            .then(response => response.json())
            .then(data => {
                // Create a Set of current participant IDs for O(1) lookup
                const currentIds = new Set(data.map(p => p.licence));

                // 1. Add or Update existing participants
                data.forEach(participant => {
                    // Check if participant already exists in any list
                    var existingCard = document.querySelector(`.participant-card[data-id="${participant.licence}"]`);

                    if (!existingCard) {
                        // Create new card
                        var newCard = createParticipantCard(participant);
                        // Add to unassigned list
                        unassigned.appendChild(newCard);
                    } else {
                        // Optional: Update status if needed (e.g. id_checked)
                        var checkbox = existingCard.querySelector('input[type="checkbox"]');
                        if (checkbox && participant.id_checked !== checkbox.checked) {
                            checkbox.checked = participant.id_checked;
                        }
                    }
                });

                // 2. Remove participants that are no longer in the data
                var allCards = document.querySelectorAll('.participant-card');
                allCards.forEach(card => {
                    var cardId = card.dataset.id;
                    if (!currentIds.has(cardId)) {
                        card.remove();
                    }
                });
            })
            .catch(error => console.error('Error polling participants:', error));
    }

    var team1Roster = document.getElementById('team1Roster');
    var team2Roster = document.getElementById('team2Roster');

    function renderTeamRoster(container, players) {
        if (!container) return;
        if (!players || !players.length) {
            container.innerHTML = '';
            return;
        }
        const badges = players.map(p => {
            const label = [p.prenom, p.nom, p.classement ? `(${p.classement})` : ''].filter(Boolean).join(' ');
            return `<span class="badge bg-light text-dark border me-1 mb-1">${label}</span>`;
        }).join('');
        container.innerHTML = `<div class="mb-1"><strong>Liste Ten'Up (${players.length}) :</strong></div>${badges}`;
    }

    function pollTenupRoster() {
        if (isDebugMode) return;
        fetch('/api/tenup/roster')
            .then(r => r.json())
            .then(roster => {
                if (!roster || (!roster.team1Players && !roster.team2Players)) {
                    renderTeamRoster(team1Roster, []);
                    renderTeamRoster(team2Roster, []);
                    return;
                }
                if (roster.tenupUrl && tenupUrlInput && !tenupUrlInput.value.trim()) {
                    tenupUrlInput.value = roster.tenupUrl;
                    localStorage.setItem(TENUP_URL_STORAGE_KEY, roster.tenupUrl);
                    updateTenupLink(roster.tenupUrl);
                }
                if (roster.team1Name && team1Title.textContent.trim() === 'Equipe 1') {
                    team1Title.textContent = roster.team1Name;
                    updateH1();
                }
                if (roster.team2Name && team2Title.textContent.trim() === 'Equipe 2') {
                    team2Title.textContent = roster.team2Name;
                    updateH1();
                }
                renderTeamRoster(team1Roster, roster.team1Players || []);
                renderTeamRoster(team2Roster, roster.team2Players || []);
            })
            .catch(err => console.error('Error polling TenUp roster:', err));
    }

    // Poll every 5 seconds
    pollTenupRoster();
    setInterval(pollParticipants, 5000);
    setInterval(pollTenupRoster, 10000);

});