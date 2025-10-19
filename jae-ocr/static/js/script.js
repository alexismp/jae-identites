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

    exportBtn.addEventListener('click', function () {
        var h1Text = h1Element.textContent.trim().replace(/ /g, '_');
        var filename = h1Text + '.json';

        var data = {
            title: h1Element.textContent.trim(),
            team1Name: team1Title.textContent.trim(),
            team2Name: team2Title.textContent.trim(),
            officials: getSectionData(officials),
            team1: getSectionData(team1),
            team2: getSectionData(team2),
            unassigned: getSectionData(unassigned)
        };

        var dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(data, null, 2));
        var downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href",     dataStr);
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

                    // Update titles
                    h1Element.textContent = data.title;
                    team1Title.textContent = data.team1Name;
                    team2Title.textContent = data.team2Name;

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
        card.dataset.id = participant.id;

        card.innerHTML = `
            <p><strong>Nom:</strong> ${participant.nom}</p>
            <p><strong>Prénom:</strong> ${participant.prenom}</p>
            <p><strong>Classement:</strong> ${participant.classement}</p>
            <p class="card-detail"><strong>Licence:</strong> ${participant.licence}</p>
            <p class="card-detail"><strong>Année validité:</strong> ${participant.annee_validite}</p>
            <p class="card-detail"><strong>Club:</strong> ${participant.club}</p>
            <p class="card-detail"><strong>Statut:</strong> ${participant.statut}</p>
            ${participant.image_uri ? `<p class="card-detail"><a href="${participant.image_uri}" target="_blank">Source Image</a></p>` : ''}
            <div class="form-check card-detail">
                <input class="form-check-input" type="checkbox" ${participant.id_checked ? 'checked' : ''}>
                <label class="form-check-label">Pièce d'identité</label>
            </div>
        `;
        return card;
    }

});