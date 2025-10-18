document.addEventListener('DOMContentLoaded', function () {
    // Set page title and H1 to "rencontre du $DATE"
    var today = new Date();
    var options = { year: 'numeric', month: 'long', day: 'numeric' };
    var formattedDate = today.toLocaleDateString('fr-FR', options);
    var titleText = "Rencontre du " + formattedDate;

    document.title = titleText;
    var h1Element = document.querySelector('h1');
    if (h1Element) {
        h1Element.textContent = titleText;
    }

    var officials = document.getElementById('officials');
    var team1 = document.getElementById('team1');
    var team2 = document.getElementById('team2');
    var unassigned = document.getElementById('unassigned');

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
