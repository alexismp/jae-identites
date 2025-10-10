document.addEventListener('DOMContentLoaded', () => {
    startApp();
});

function startApp() {
    let stream;
    let isProcessing = false;
    let isShowingResults = false;
    const video = document.getElementById('video');
    const statusMessage = document.getElementById('status-message');
    const manualCaptureButton = document.getElementById('manual-capture-button');

    manualCaptureButton.addEventListener('click', () => {
        if (isShowingResults) {
            location.reload();
        } else if (!isProcessing) {
            isProcessing = true;
            statusMessage.textContent = "Capture manuelle, scan en cours...";
            captureAndSend();
        }
    });

    async function startCamera() {
        if (stream) return; // Si la caméra est déjà active, on ne fait rien
        try {
            const constraints = { video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } } };
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            video.srcObject = stream;
            video.setAttribute('playsinline', '');
            video.setAttribute('muted', '');
            video.setAttribute('autoplay', '');

            video.addEventListener('loadedmetadata', () => {
                statusMessage.textContent = "Veuillez cadrer la carte dans le rectangle.";
            });

        } catch (err) {
            console.error("Erreur d'accès à la caméra:", err);
            let message = "Impossible d'accéder à la caméra.";
            if (err.name === "NotAllowedError") message = "Vous avez refusé l'accès à la caméra. Veuillez autoriser l'accès dans les paramètres de votre navigateur.";
            else if (err.name === "NotFoundError") message = "Aucune caméra compatible n'a été trouvée sur cet appareil.";
            statusMessage.textContent = message;
            statusMessage.style.color = 'red';
        }
    }

    function captureAndSend() {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frozenImage = document.getElementById('frozen-image');
        frozenImage.src = canvas.toDataURL('image/jpeg');

        video.style.display = 'none';
        frozenImage.style.display = 'block';

        // Arrêter le flux vidéo
        stream.getTracks().forEach(track => track.stop());
        video.srcObject = null;

        canvas.toBlob(async (blob) => {
            console.log(`Image capturée, taille: ${Math.round(blob.size / 1024)} KB. Envoi au serveur...`);

            const formData = new FormData();
            formData.append('file', blob, 'capture.jpg');

            try {
                // Utiliser une URL relative pour que l'appel fonctionne en local et en production
                const response = await fetch('/scan', {
                    method: 'POST',
                    body: formData,
                });

                const data = await response.json();

                if (!response.ok) {
                    // Gérer les erreurs renvoyées par le serveur (e.g., Gemini error)
                    throw new Error(data.error || 'Une erreur est survenue lors du scan.');
                }

                displayResults(data);

            } catch (error) {
                console.error('Erreur lors de l\'envoi de l\'image:', error);
                statusMessage.textContent = `Erreur: ${error.message}`;
                statusMessage.style.color = 'red';
                isProcessing = false; // Permettre une nouvelle tentative
            }

        }, 'image/jpeg', 0.95);
    }

    function displayResults(data) {
        const resultsContainer = document.getElementById('results-container');
        const statusMessage = document.getElementById('status-message');
        const frozenImage = document.getElementById('frozen-image');
        const video = document.getElementById('video');

        if (data.error) {
            resultsContainer.innerHTML = `<p style="color: red;">Erreur d'extraction : ${data.error}</p>`;
        } else {
             resultsContainer.innerHTML = `
                <h3>Résultats de l'extraction</h3>
                <p><strong>Nom:</strong> ${data.prenom || 'N/A'} ${data.nom || 'N/A'}</p>
                <p><strong>Licence:</strong> ${data.licence || 'N/A'}</p>
                <p><strong>Validité:</strong> ${data.annee_validite || 'N/A'}</p>
                <p><strong>Classement:</strong> ${data.classement || 'N/A'}</p>
                <h3>Raw JSON:</h3>
                <pre>${JSON.stringify(data, null, 2)}</pre>
            `;
        }

        statusMessage.textContent = "Scan terminé !";
        statusMessage.style.color = '#555'; // Revenir à la couleur par défaut
        isProcessing = false; // Permettre un nouveau scan si nécessaire
        isShowingResults = true;
        manualCaptureButton.textContent = "Restart";
        frozenImage.style.display = 'none';
        video.style.display = 'block';
        startCamera();
    }

    startCamera();
}