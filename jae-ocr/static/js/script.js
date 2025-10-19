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
});