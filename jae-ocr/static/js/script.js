document.addEventListener('DOMContentLoaded', function () {
    var h1Element = document.querySelector('h1');
    var team1Title = document.getElementById('team1Title');
    var team2Title = document.getElementById('team2Title');

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
    team1Title.addEventListener('input', function () {
        updateH1();
        scheduleSaveBoardState();
    });
    team2Title.addEventListener('input', function () {
        updateH1();
        scheduleSaveBoardState();
    });

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

    let isDragging = false;
    let saveTimer = null;
    let lastBoardUpdatedAt = null;
    let team1LockedByTenup = false;
    let team2LockedByTenup = false;
    let lastDropWarningAt = 0;

    function normalizeClubText(value) {
        return (value || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
    }

    function getExpectedTeamSlotForCard(card) {
        if (!card) return null;
        const explicitSlot = (card.dataset.expectedSlot || '').trim();
        if (explicitSlot === 'team1' || explicitSlot === 'team2') {
            return explicitSlot;
        }
        const rawClub = card.dataset.club || (card.querySelector('p:nth-child(6)')?.textContent.replace('Club:', '').trim() || '');
        const clubNorm = normalizeClubText(rawClub);
        if (!clubNorm || clubNorm === 'null' || clubNorm === 'none') return null;

        const t1Norm = normalizeClubText(team1Title ? team1Title.textContent : '');
        const t2Norm = normalizeClubText(team2Title ? team2Title.textContent : '');
        const matchesT1 = t1Norm && t1Norm !== 'equipe 1' && (clubNorm === t1Norm || t1Norm.includes(clubNorm) || clubNorm.includes(t1Norm));
        const matchesT2 = t2Norm && t2Norm !== 'equipe 2' && (clubNorm === t2Norm || t2Norm.includes(clubNorm) || clubNorm.includes(t2Norm));

        if (matchesT1 && !matchesT2) return 'team1';
        if (matchesT2 && !matchesT1) return 'team2';
        return null;
    }

    function isDropAllowed(card, targetEl) {
        if (!targetEl) return true;
        const targetId = targetEl.id;
        if (targetId !== 'team1' && targetId !== 'team2') return true;
        const expectedSlot = getExpectedTeamSlotForCard(card);
        if (!expectedSlot) return true;
        return expectedSlot === targetId;
    }

    function showDropForbiddenNotice(card, targetEl) {
        const now = Date.now();
        if (now - lastDropWarningAt < 1200) return;
        lastDropWarningAt = now;

        if (targetEl) {
            targetEl.style.transition = 'box-shadow 0.2s ease';
            targetEl.style.boxShadow = '0 0 0 3px rgba(220, 53, 69, 0.65)';
            setTimeout(() => { targetEl.style.boxShadow = ''; }, 700);
        }

        const expectedSlot = getExpectedTeamSlotForCard(card);
        const expectedTeamName = expectedSlot === 'team1'
            ? (team1Title ? team1Title.textContent.trim() : 'Equipe 1')
            : expectedSlot === 'team2'
                ? (team2Title ? team2Title.textContent.trim() : 'Equipe 2')
                : 'son équipe';

        let toast = document.getElementById('dropForbiddenToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'dropForbiddenToast';
            toast.className = 'alert alert-danger shadow position-fixed bottom-0 end-0 m-3 py-2 px-3';
            toast.style.zIndex = '1080';
            document.body.appendChild(toast);
        }
        toast.textContent = `Dépôt interdit : ce joueur appartient à « ${expectedTeamName} ».`;
        toast.style.display = 'block';
        clearTimeout(toast._hideTimer);
        toast._hideTimer = setTimeout(() => { toast.style.display = 'none'; }, 2500);
    }

    function handleSortableMove(evt) {
        if (!isDropAllowed(evt.dragged, evt.to)) {
            showDropForbiddenNotice(evt.dragged, evt.to);
            return false;
        }
        return true;
    }

    function collectBoardState() {
        const assignments = {};
        const checked = {};
        const sections = { officials, team1, team2, unassigned };
        Object.entries(sections).forEach(([sectionName, el]) => {
            if (!el) return;
            Array.from(el.querySelectorAll('.participant-card')).forEach(card => {
                const id = card.dataset.id;
                if (!id) return;
                assignments[id] = sectionName;
                const cb = card.querySelector('input[type="checkbox"]');
                if (cb) checked[id] = cb.checked;
            });
        });
        return {
            team1Name: team1Title ? team1Title.textContent.trim() : 'Equipe 1',
            team2Name: team2Title ? team2Title.textContent.trim() : 'Equipe 2',
            tenupUrl: tenupUrlInput ? tenupUrlInput.value.trim() : '',
            assignments,
            checked
        };
    }

    function scheduleSaveBoardState() {
        if (isDebugMode) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            fetch('/api/board-state', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(collectBoardState())
            })
                .then(r => r.json())
                .then(saved => {
                    if (saved && saved.updatedAt) {
                        lastBoardUpdatedAt = saved.updatedAt;
                    }
                })
                .catch(err => console.error('Error saving board state:', err));
        }, 250);
    }

    document.addEventListener('change', function (evt) {
        if (evt.target && evt.target.matches('.participant-card input[type="checkbox"]')) {
            scheduleSaveBoardState();
        }
    });

    new Sortable(officials, {
        group: 'shared',
        animation: 150,
        onMove: handleSortableMove,
        onStart: function () { isDragging = true; },
        onEnd: function () { isDragging = false; scheduleSaveBoardState(); }
    });

    new Sortable(team1, {
        group: 'shared',
        animation: 150,
        onMove: handleSortableMove,
        onStart: function () { isDragging = true; },
        onAdd: function (evt) {
            var item = evt.item;
            var to = evt.to;
            if (!isDropAllowed(item, to)) {
                evt.from.appendChild(item);
                showDropForbiddenNotice(item, to);
                return;
            }
            if (!team1LockedByTenup && to.children.length === 1 && team1Title && team1Title.textContent.trim() === 'Equipe 1') {
                var clubElement = item.querySelector('p:nth-child(6)');
                if (clubElement) {
                    var clubName = clubElement.textContent.replace('Club:', '').trim();
                    if (clubName && clubName !== 'null' && clubName !== 'None') {
                        team1Title.textContent = clubName;
                        updateH1();
                    }
                }
            }
        },
        onEnd: function () { isDragging = false; scheduleSaveBoardState(); }
    });

    new Sortable(team2, {
        group: 'shared',
        animation: 150,
        onMove: handleSortableMove,
        onStart: function () { isDragging = true; },
        onAdd: function (evt) {
            var item = evt.item;
            var to = evt.to;
            if (!isDropAllowed(item, to)) {
                evt.from.appendChild(item);
                showDropForbiddenNotice(item, to);
                return;
            }
            if (!team2LockedByTenup && to.children.length === 1 && team2Title && team2Title.textContent.trim() === 'Equipe 2') {
                var clubElement = item.querySelector('p:nth-child(6)');
                if (clubElement) {
                    var clubName = clubElement.textContent.replace('Club:', '').trim();
                    if (clubName && clubName !== 'null' && clubName !== 'None') {
                        team2Title.textContent = clubName;
                        updateH1();
                    }
                }
            }
        },
        onEnd: function () { isDragging = false; scheduleSaveBoardState(); }
    });

    new Sortable(unassigned, {
        group: 'shared',
        animation: 150,
        onMove: handleSortableMove,
        onStart: function () { isDragging = true; },
        onEnd: function () { isDragging = false; scheduleSaveBoardState(); }
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
            scheduleSaveBoardState();
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
        card.dataset.expectedSlot = participant.expected_team_slot || '';
        card.dataset.club = participant.club || '';

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
        team1LockedByTenup = false;
        team2LockedByTenup = false;
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
                        var newCard = createParticipantCard(participant);
                        if (participant.team_slot === 'team1') {
                            team1.appendChild(newCard);
                        } else if (participant.team_slot === 'team2') {
                            team2.appendChild(newCard);
                        } else {
                            unassigned.appendChild(newCard);
                        }
                    } else {
                        // Synchroniser les métadonnées d'appartenance d'équipe
                        if (participant.expected_team_slot) {
                            existingCard.dataset.expectedSlot = participant.expected_team_slot;
                        }
                        if (participant.club) {
                            existingCard.dataset.club = participant.club;
                        }
                        // Mettre à jour la case Pièce d'identité et basculer dans la bonne équipe dès validation PID
                        var checkbox = existingCard.querySelector('input[type="checkbox"]');
                        if (checkbox && participant.id_checked !== checkbox.checked) {
                            checkbox.checked = participant.id_checked;
                        }
                        if (participant.id_checked && participant.team_slot && existingCard.parentElement === unassigned) {
                            if (participant.team_slot === 'team1') {
                                team1.appendChild(existingCard);
                            } else if (participant.team_slot === 'team2') {
                                team2.appendChild(existingCard);
                            }
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

    function pollTenupRoster() {
        if (isDebugMode) return;
        fetch('/api/tenup/roster')
            .then(r => r.json())
            .then(roster => {
                if (!roster) return;
                if (roster.tenupUrl && tenupUrlInput && !tenupUrlInput.value.trim()) {
                    tenupUrlInput.value = roster.tenupUrl;
                    localStorage.setItem(TENUP_URL_STORAGE_KEY, roster.tenupUrl);
                    updateTenupLink(roster.tenupUrl);
                }
                let titlesChanged = false;
                if (roster.team1Name) {
                    team1LockedByTenup = true;
                    if (team1Title && team1Title.textContent.trim() === 'Equipe 1') {
                        team1Title.textContent = roster.team1Name;
                        titlesChanged = true;
                    }
                }
                if (roster.team2Name) {
                    team2LockedByTenup = true;
                    if (team2Title && team2Title.textContent.trim() === 'Equipe 2') {
                        team2Title.textContent = roster.team2Name;
                        titlesChanged = true;
                    }
                }
                if (titlesChanged) {
                    updateH1();
                }
            })
            .catch(err => console.error('Error polling TenUp roster:', err));
    }

    function pollBoardState() {
        if (isDebugMode || isDragging) return;
        fetch('/api/board-state')
            .then(r => r.json())
            .then(state => {
                if (!state || !state.updatedAt || state.updatedAt === lastBoardUpdatedAt) return;
                lastBoardUpdatedAt = state.updatedAt;

                let titlesChanged = false;
                if (state.team1Name && team1Title && document.activeElement !== team1Title && team1Title.textContent.trim() !== state.team1Name) {
                    team1Title.textContent = state.team1Name;
                    titlesChanged = true;
                }
                if (state.team2Name && team2Title && document.activeElement !== team2Title && team2Title.textContent.trim() !== state.team2Name) {
                    team2Title.textContent = state.team2Name;
                    titlesChanged = true;
                }
                if (titlesChanged) updateH1();

                if (typeof state.tenupUrl === 'string' && tenupUrlInput && document.activeElement !== tenupUrlInput && tenupUrlInput.value.trim() !== state.tenupUrl) {
                    tenupUrlInput.value = state.tenupUrl;
                    localStorage.setItem(TENUP_URL_STORAGE_KEY, state.tenupUrl);
                    updateTenupLink(state.tenupUrl);
                }

                const sections = { officials, team1, team2, unassigned };
                const assignments = state.assignments || {};
                Object.entries(assignments).forEach(([cardId, targetName]) => {
                    const targetEl = sections[targetName];
                    if (!targetEl) return;
                    const card = Array.from(document.querySelectorAll('.participant-card')).find(c => c.dataset.id === cardId);
                    if (card && card.parentElement !== targetEl) {
                        targetEl.appendChild(card);
                    }
                });

                const checkedMap = state.checked || {};
                Object.entries(checkedMap).forEach(([cardId, isChecked]) => {
                    const card = Array.from(document.querySelectorAll('.participant-card')).find(c => c.dataset.id === cardId);
                    const cb = card ? card.querySelector('input[type="checkbox"]') : null;
                    if (cb && cb.checked !== Boolean(isChecked)) {
                        cb.checked = Boolean(isChecked);
                    }
                });
            })
            .catch(err => console.error('Error polling board state:', err));
    }

    // Poll every 5 seconds
    pollTenupRoster();
    pollBoardState();
    setInterval(function () {
        pollParticipants();
        pollBoardState();
    }, 5000);
    setInterval(pollTenupRoster, 10000);

});