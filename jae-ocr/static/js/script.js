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
    let latestBoardState = null;
    let team1LockedByTenup = false;
    let team2LockedByTenup = false;
    let lastDropWarningAt = 0;

    let currentMatchId = (document.body.dataset.initialMatchId || '').trim() || null;
    let currentUser = null;
    let pollingStarted = false;

    async function authFetch(url, options = {}) {
        const headers = Object.assign({}, options.headers || {});
        if (currentUser) {
            const token = await currentUser.getIdToken();
            headers['Authorization'] = 'Bearer ' + token;
        }
        return fetch(url, Object.assign({}, options, { headers }));
    }

    function setActiveMatchInUrl(matchId, pushHistory = false) {
        currentMatchId = matchId;
        const badge = document.getElementById('matchIdBadge');
        if (badge && matchId) {
            badge.textContent = 'Rencontre : ' + matchId;
            badge.classList.remove('d-none');
        }
        const targetPath = '/m/' + encodeURIComponent(matchId);
        if (window.location.pathname !== targetPath) {
            if (pushHistory) {
                window.history.pushState({ matchId }, '', targetPath);
            } else {
                window.history.replaceState({ matchId }, '', targetPath);
            }
        }
    }

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
        const rawClub = card.dataset.club || (card.querySelector('.card-club')?.textContent.replace('Club:', '').trim() || '');
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
        if (isDebugMode || isDemoMode || !currentUser || !currentMatchId) return;
        clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            const payload = collectBoardState();
            latestBoardState = payload;
            authFetch(`/api/matches/${encodeURIComponent(currentMatchId)}/board-state`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
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

    document.addEventListener('click', function (evt) {
        const copyBtn = evt.target && evt.target.closest('.btn-copy-licence');
        if (!copyBtn) return;
        evt.stopPropagation();
        const val = (copyBtn.dataset.copy || '').trim();
        if (!val) return;
        navigator.clipboard.writeText(val).then(() => {
            const orig = copyBtn.textContent;
            copyBtn.textContent = '✓';
            copyBtn.classList.add('copied');
            setTimeout(() => {
                copyBtn.textContent = orig;
                copyBtn.classList.remove('copied');
            }, 1400);
        }).catch(err => console.error('Erreur copie licence:', err));
    });

    new Sortable(officials, {
        group: 'shared',
        handle: '.drag-handle',
        animation: 150,
        onMove: handleSortableMove,
        onStart: function () { isDragging = true; },
        onEnd: function () { isDragging = false; scheduleSaveBoardState(); }
    });

    new Sortable(team1, {
        group: 'shared',
        handle: '.drag-handle',
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
                var clubElement = item.querySelector('.card-club');
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
        handle: '.drag-handle',
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
                var clubElement = item.querySelector('.card-club');
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
        handle: '.drag-handle',
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
            const nomEl = item.querySelector('.card-nom') || item.querySelector('p:nth-of-type(1)');
            const prenomEl = item.querySelector('.card-prenom') || item.querySelector('p:nth-of-type(2)');
            const classementEl = item.querySelector('.card-classement') || item.querySelector('p:nth-of-type(3)');
            const licenceValEl = item.querySelector('.card-licence-val');
            const anneeValiditeEl = item.querySelector('.card-annee');
            const clubEl = item.querySelector('.card-club');
            const statutEl = item.querySelector('.card-statut');
            const competenceEl = item.querySelector('.card-competence-val');
            const idCheckedEl = item.querySelector('input[type="checkbox"]');
            const imageUriEl = item.querySelector('a');

            return {
                id: item.dataset.id,
                nom: nomEl ? nomEl.textContent.replace('Nom:', '').trim() : '',
                prenom: prenomEl ? prenomEl.textContent.replace('Prénom:', '').trim() : '',
                classement: classementEl ? classementEl.textContent.replace('Classement:', '').trim() : '',
                licence: licenceValEl ? licenceValEl.textContent.trim() : (item.dataset.id || ''),
                annee_validite: anneeValiditeEl ? anneeValiditeEl.textContent.replace('Année validité:', '').trim() : '',
                club: clubEl ? clubEl.textContent.replace('Club:', '').trim() : '',
                statut: statutEl ? statutEl.textContent.replace('Statut:', '').trim() : '',
                niveau_competence: competenceEl ? competenceEl.textContent.trim() : null,
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

        const licenceDisplay = participant.licence || '';
        const escapedLicence = String(licenceDisplay).replace(/"/g, '&quot;');

        card.innerHTML = `
            <div class="drag-handle" title="Glisser pour déplacer la fiche">
                <span>⋮⋮ Déplacer</span>
            </div>
            <p class="card-nom"><strong>Nom:</strong> ${participant.image_uri ? `<a href="${participant.image_uri}" target="_blank">${participant.nom}</a>` : participant.nom}</p>
            <p class="card-prenom"><strong>Prénom:</strong> ${participant.prenom}</p>
            <p class="card-classement"><strong>Classement:</strong> ${participant.classement}</p>
            <p class="card-detail"><strong>Licence:</strong> <span class="card-licence-val">${licenceDisplay}</span>${licenceDisplay ? `<button type="button" class="btn-copy-licence" data-copy="${escapedLicence}" title="Copier le numéro de licence">📋</button>` : ''}</p>
            <p class="card-detail card-annee"><strong>Année validité:</strong> ${participant.annee_validite}</p>
            <p class="card-detail card-club"><strong>Club:</strong> ${participant.club}</p>
            <p class="card-detail card-statut"><strong>Statut:</strong> ${participant.statut}</p>
            ${participant.niveau_competence ? `<p class="card-detail card-competence"><strong>Qualification:</strong> <span class="badge bg-info text-dark card-competence-val">${participant.niveau_competence}</span></p>` : ''}
            <div class="form-check card-detail">
                <input class="form-check-input" type="checkbox" ${participant.id_checked ? 'checked' : ''}>
                <label class="form-check-label">Pièce d'identité</label>
            </div>
        `;
        return card;
    }

    const isDebugMode = (new URLSearchParams(window.location.search).get('debug') || '').toLowerCase() === 'true';
    const isDemoMode = (document.body.dataset.demoMode || '').toLowerCase() === 'true';

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
            if (!confirm("Archiver la rencontre active et démarrer une nouvelle rencontre vierge ?")) {
                return;
            }
            resetMatchBtn.disabled = true;
            authFetch('/api/matches/new', { method: 'POST' })
                .then(response => {
                    if (!response.ok) throw new Error('Erreur serveur (' + response.status + ')');
                    return response.json();
                })
                .then(res => {
                    lastBoardUpdatedAt = null;
                    clearBoardUi();
                    if (res && res.matchId) {
                        setActiveMatchInUrl(res.matchId, true);
                    }
                })
                .catch(err => alert('Impossible de créer une nouvelle rencontre : ' + err.message))
                .finally(() => {
                    resetMatchBtn.disabled = false;
                });
        });
    }

    // Polling logic (désactivé en mode debug ou tant que l'utilisateur n'est pas connecté)
    function pollParticipants() {
        if (isDebugMode || !currentUser || !currentMatchId) return;
        authFetch(`/api/matches/${encodeURIComponent(currentMatchId)}/participants`)
            .then(response => response.ok ? response.json() : [])
            .then(data => {
                if (!Array.isArray(data)) return;
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

                // 3. Réappliquer le dernier boardState connu (évite la race condition au rafraîchissement pour les officiels)
                if (latestBoardState && !isDragging) {
                    applyBoardAssignments(latestBoardState);
                }
            })
            .catch(error => console.error('Error polling participants:', error));
    }

    function pollTenupRoster() {
        if (isDebugMode || !currentUser || !currentMatchId) return;
        authFetch(`/api/matches/${encodeURIComponent(currentMatchId)}/roster`)
            .then(r => r.ok ? r.json() : null)
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

    function applyBoardAssignments(state) {
        if (!state) return;
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
    }

    function pollBoardState() {
        if (isDebugMode || isDragging || !currentUser || !currentMatchId) return;
        authFetch(`/api/matches/${encodeURIComponent(currentMatchId)}/board-state`)
            .then(r => r.ok ? r.json() : null)
            .then(state => {
                if (!state || !state.updatedAt || state.updatedAt === lastBoardUpdatedAt) return;
                lastBoardUpdatedAt = state.updatedAt;
                latestBoardState = state;

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

                applyBoardAssignments(state);
            })
            .catch(err => console.error('Error polling board state:', err));
    }

    function startPollingLoop() {
        if (pollingStarted) return;
        pollingStarted = true;
        setInterval(function () {
            pollParticipants();
            pollBoardState();
        }, 5000);
        setInterval(pollTenupRoster, 10000);
    }

    // Mode Démo interactive (100 % client, sans connexion ni écriture serveur)
    if (isDemoMode) {
        if (resetMatchBtn) resetMatchBtn.classList.add('d-none');
        const demoToast = document.getElementById('demoToast');
        function showDemoToast(message, variant = 'alert-info') {
            if (!demoToast) return;
            demoToast.className = `alert ${variant} text-center py-2 mb-0`;
            demoToast.textContent = message;
            demoToast.classList.remove('d-none');
        }

        const DEMO_ROSTER = [
            { nom: 'MOREAU', prenom: 'Claire', classement: '4/6', licence: "Ten'Up (moreau_claire)", club: 'TC RUEIL-MALMAISON 1', statut: 'EQ', expected_team_slot: 'team1', annee_validite: '2026', id_checked: false },
            { nom: 'LAURENT', prenom: 'Camille', classement: '15/1', licence: "Ten'Up (laurent_camille)", club: 'TC RUEIL-MALMAISON 1', statut: 'EQ', expected_team_slot: 'team1', annee_validite: '2026', id_checked: false },
            { nom: 'LEFEBVRE', prenom: 'Manon', classement: '15/3', licence: "Ten'Up (lefebvre_manon)", club: 'TC RUEIL-MALMAISON 1', statut: 'EQ', expected_team_slot: 'team1', annee_validite: '2026', id_checked: false },
            { nom: 'GIRARD', prenom: 'Pauline', classement: '15/5', licence: "Ten'Up (girard_pauline)", club: 'TC RUEIL-MALMAISON 1', statut: 'EQ', expected_team_slot: 'team1', annee_validite: '2026', id_checked: false },
            { nom: 'DUPONT', prenom: 'Chloé', classement: '4/6', licence: "Ten'Up (dupont_chloe)", club: 'CA MONTROUGE 1', statut: 'EQ', expected_team_slot: 'team2', annee_validite: '2026', id_checked: false },
            { nom: 'BERNARD', prenom: 'Sophie', classement: '15/2', licence: "Ten'Up (bernard_sophie)", club: 'CA MONTROUGE 1', statut: 'EQ', expected_team_slot: 'team2', annee_validite: '2026', id_checked: false },
            { nom: 'ROCHE', prenom: 'Julie', classement: '15/4', licence: "Ten'Up (roche_julie)", club: 'CA MONTROUGE 1', statut: 'EQ', expected_team_slot: 'team2', annee_validite: '2026', id_checked: false },
            { nom: 'FONTAINE', prenom: 'Alice', classement: '30', licence: "Ten'Up (fontaine_alice)", club: 'CA MONTROUGE 1', statut: 'EQ', expected_team_slot: 'team2', annee_validite: '2026', id_checked: false }
        ];

        function loadDemoTenupImport() {
            clearBoardUi();
            team1Title.textContent = 'TC RUEIL-MALMAISON 1';
            team2Title.textContent = 'CA MONTROUGE 1';
            team1LockedByTenup = true;
            team2LockedByTenup = true;
            if (tenupUrlInput) {
                tenupUrlInput.value = 'https://tenup.fft.fr/championnat/demo/rencontre/123456';
                updateTenupLink(tenupUrlInput.value);
            }
            updateH1();
            DEMO_ROSTER.forEach(p => unassigned.appendChild(createParticipantCard(p)));
            showDemoToast("✓ Import Ten'Up simulé (sans LLM) : 2 équipes verrouillées et 8 joueuses prêtes dans Non-affecté. Essayez aussi de glisser une joueuse dans la mauvaise équipe !", 'alert-primary');
        }

        const demoImportBtn = document.getElementById('demoImportTenupBtn');
        if (demoImportBtn) demoImportBtn.addEventListener('click', loadDemoTenupImport);

        const demoScanMrzBtn = document.getElementById('demoScanMrzBtn');
        if (demoScanMrzBtn) {
            demoScanMrzBtn.addEventListener('click', () => {
                const candidate = Array.from(unassigned.querySelectorAll('.participant-card')).find(
                    c => (c.dataset.expectedSlot === 'team1' || c.dataset.expectedSlot === 'team2')
                );
                if (!candidate) {
                    showDemoToast("Toutes les joueuses du roster Ten'Up ont déjà été validées ! Cliquez sur « 1. Simuler import Ten'Up » ou « Réinitialiser ».", 'alert-secondary');
                    return;
                }
                const cb = candidate.querySelector('input[type="checkbox"]');
                if (cb) cb.checked = true;
                const slot = candidate.dataset.expectedSlot;
                const targetCol = slot === 'team1' ? team1 : team2;
                const targetName = slot === 'team1' ? team1Title.textContent.trim() : team2Title.textContent.trim();
                targetCol.appendChild(candidate);
                const nom = candidate.querySelector('.card-nom')?.textContent.replace('Nom:', '').trim() || '';
                const prenom = candidate.querySelector('.card-prenom')?.textContent.replace('Prénom:', '').trim() || '';
                showDemoToast(`✓ CNI lue localement par MRZ (0,2 s · sans LLM · 0 photo envoyée) : ${prenom} ${nom} → validée et placée dans ${targetName}.`, 'alert-success');
            });
        }

        const demoScanSubBtn = document.getElementById('demoScanSubBtn');
        if (demoScanSubBtn) {
            demoScanSubBtn.addEventListener('click', () => {
                const existing = document.querySelector('.participant-card[data-id="5852868 M"]');
                if (existing) {
                    showDemoToast("Le remplaçant / officiel (Nicolas SEVESTRE) est déjà présent — glissez-le dans Officiels ou son équipe.", 'alert-info');
                    return;
                }
                const sub = {
                    nom: 'SEVESTRE',
                    prenom: 'Nicolas',
                    classement: '30/2',
                    licence: '5852868 M',
                    annee_validite: '2026',
                    club: 'TC RUEIL-MALMAISON',
                    statut: 'JAE / Officiel',
                    id_checked: true,
                    expected_team_slot: ''
                };
                unassigned.appendChild(createParticipantCard(sub));
                showDemoToast("✓ Licence FFT + CNI scannées pour Nicolas SEVESTRE (hors liste Ten'Up) : fiche ajoutée dans Non-affecté, prête à être glissée dans Officiels ou son équipe.", 'alert-info');
            });
        }

        const demoRejectBtn = document.getElementById('demoRejectPermisBtn');
        if (demoRejectBtn) {
            demoRejectBtn.addEventListener('click', () => {
                showDemoToast("✕ Scan rejeté immédiatement sur le téléphone : Document non autorisé (Permis de conduire ou Titre de séjour). Seuls CNI et passeports sont acceptés.", 'alert-danger');
            });
        }

        const demoResetBtn = document.getElementById('demoResetBtn');
        if (demoResetBtn) {
            demoResetBtn.addEventListener('click', () => {
                clearBoardUi();
                showDemoToast("Démo réinitialisée. Cliquez sur « 1. Simuler import Ten'Up » pour démarrer le parcours.", 'alert-secondary');
            });
        }

        // Démarrer directement avec l'import Ten'Up chargé pour une prise en main immédiate
        loadDemoTenupImport();
    }

    // Initialisation Firebase Auth (hors mode debug et hors mode démo)
    if (!isDebugMode && !isDemoMode && window.firebase && window.JAE_FIREBASE_CONFIG) {
        firebase.initializeApp(window.JAE_FIREBASE_CONFIG);
        const auth = firebase.auth();
        const loginModal = document.getElementById('loginModal');
        const pendingApprovalBox = document.getElementById('pendingApprovalBox');
        const boardContainer = document.getElementById('boardContainer');
        const userMenu = document.getElementById('userMenu');
        const userBadge = document.getElementById('userBadge');
        const signOutBtn = document.getElementById('signOutBtn');
        const adminMenuDivider = document.getElementById('adminMenuDivider');
        const adminMenuItem = document.getElementById('adminMenuItem');
        const authError = document.getElementById('authError');

        function showAuthError(msg) {
            if (!authError) return;
            authError.textContent = msg;
            authError.classList.remove('d-none');
        }

        async function signInWithOAuthProvider(provider) {
            if (authError) authError.classList.add('d-none');
            try {
                await auth.signInWithPopup(provider);
            } catch (e) {
                if (e && e.code === 'auth/popup-blocked') {
                    await auth.signInWithRedirect(provider);
                } else {
                    showAuthError(e.message || 'Échec de connexion OAuth');
                }
            }
        }

        const googleBtn = document.getElementById('googleSignInBtn');
        if (googleBtn) {
            googleBtn.addEventListener('click', () => signInWithOAuthProvider(new firebase.auth.GoogleAuthProvider()));
        }

        if (signOutBtn) {
            signOutBtn.addEventListener('click', () => auth.signOut());
        }

        auth.onAuthStateChanged(async user => {
            currentUser = user;
            if (!user) {
                if (loginModal) loginModal.classList.remove('d-none');
                if (pendingApprovalBox) pendingApprovalBox.classList.add('d-none');
                if (boardContainer) boardContainer.classList.add('d-none');
                if (userBadge) userBadge.textContent = '';
                if (userMenu) userMenu.classList.add('d-none');
                if (adminMenuDivider) adminMenuDivider.classList.add('d-none');
                if (adminMenuItem) adminMenuItem.classList.add('d-none');
                return;
            }

            if (loginModal) loginModal.classList.add('d-none');
            if (userBadge) userBadge.textContent = user.email || user.displayName || 'Compte';
            if (userMenu) userMenu.classList.remove('d-none');

            try {
                const meResp = await authFetch('/api/me');
                const me = await meResp.json();
                if (me && me.approved === false) {
                    if (pendingApprovalBox) pendingApprovalBox.classList.remove('d-none');
                    if (boardContainer) boardContainer.classList.add('d-none');
                    return;
                }
                if (pendingApprovalBox) pendingApprovalBox.classList.add('d-none');
                if (boardContainer) boardContainer.classList.remove('d-none');
                const isAdmin = Boolean(me && me.user && me.user.isAdmin);
                if (adminMenuDivider) adminMenuDivider.classList.toggle('d-none', !isAdmin);
                if (adminMenuItem) adminMenuItem.classList.toggle('d-none', !isAdmin);
                const resolvedMatchId = currentMatchId || (me && me.activeMatch && me.activeMatch.matchId);
                if (resolvedMatchId) {
                    setActiveMatchInUrl(resolvedMatchId, false);
                    lastBoardUpdatedAt = null;
                    latestBoardState = null;
                    clearBoardUi();
                    pollTenupRoster();
                    pollParticipants();
                    pollBoardState();
                    startPollingLoop();
                }
            } catch (e) {
                console.error('Erreur initialisation session JAE:', e);
            }
        });
    }

});