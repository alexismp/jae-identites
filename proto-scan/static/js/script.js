document.addEventListener('DOMContentLoaded', () => {
    startApp();
});

function startApp() {
    let stream;
    let isProcessing = false;
    let isShowingResults = false;
    const video = document.getElementById('video');
    const scannerMessage = document.getElementById('scanner-message');
    const manualCaptureButton = document.getElementById('manual-capture-button');

    function showScannerMessage(message, isError = false) {
        scannerMessage.textContent = message;
        scannerMessage.style.backgroundColor = isError ? 'rgba(255, 0, 0, 0.7)' : 'rgba(0, 0, 0, 0.7)';
        scannerMessage.style.display = 'flex';
    }

    function hideScannerMessage() {
        scannerMessage.style.display = 'none';
    }

    manualCaptureButton.addEventListener('click', () => {
        if (isShowingResults) {
            location.reload();
        } else if (!isProcessing) {
            isProcessing = true;
            showScannerMessage("Scan en cours...");
            manualCaptureButton.style.backgroundColor = '#007bff';
            captureAndSend();
        }
    });

    async function startCamera() {
        if (stream) return; // Si la caméra est déjà active, on ne fait rien
        try {
            const constraints = { video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 }, aspectRatio: { ideal: 1.586 } } };
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            video.srcObject = stream;
            video.setAttribute('playsinline', '');
            video.setAttribute('muted', '');
            video.setAttribute('autoplay', '');

            video.addEventListener('loadedmetadata', () => {
                hideScannerMessage();
            });

        } catch (err) {
            console.error("Erreur d'accès à la caméra:", err);
            let message = "Impossible d'accéder à la caméra.";
            if (err.name === "NotAllowedError") message = "Vous avez refusé l'accès à la caméra. Veuillez autoriser l'accès dans les paramètres de votre navigateur.";
            else if (err.name === "NotFoundError") message = "Aucune caméra compatible n'a été trouvée sur cet appareil.";
            showScannerMessage(message, true);
        }
    }

    function captureAndSend() {
        const canvas = document.createElement('canvas');
        // Utiliser la résolution native de la vidéo pour une qualité maximale
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');

        // Dessiner l'image entière de la vidéo sur le canvas
        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frozenImage = document.getElementById('frozen-image');
        // Mettre à jour l'image affichée (peut être de moindre qualité pour l'affichage si nécessaire)
        frozenImage.src = canvas.toDataURL('image/jpeg', 1.0);

        video.style.display = 'none';
        frozenImage.style.display = 'block';

        // Arrêter le flux vidéo
        stream.getTracks().forEach(track => track.stop());
        video.srcObject = null;

        // Envoyer l'image en haute qualité au serveur
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
                showScannerMessage(`Erreur: ${error.message}`, true);
                isProcessing = false; // Permettre une nouvelle tentative
            }

        }, 'image/jpeg', 0.95);
    }

    function displayResults(data) {
        const resultsContainer = document.getElementById('results-container');
        const frozenImage = document.getElementById('frozen-image');
        const video = document.getElementById('video');

        hideScannerMessage();
        resultsContainer.style.display = 'block';

        if (data.error) {
            resultsContainer.innerHTML = `<p style="color: red;">Erreur d'extraction : ${data.error}</p>`;
        } else {
            let typeMessage = '';
            if (data.type) {
                const typeText = data.type.charAt(0).toUpperCase() + data.type.slice(1);
                typeMessage = `<p style="font-weight: bold; color: blue;">Type: ${typeText}</p>`;
            }

             resultsContainer.innerHTML = `
                <h3>Résultats de l'extraction</h3>
                ${typeMessage}
                <p><strong>Nom:</strong> ${data.prenom || 'N/A'} ${data.nom || 'N/A'}</p>
                <p><strong>Licence:</strong> ${data.licence || 'N/A'}</p>
                <p><strong>Validité:</strong> ${data.annee_validite || 'N/A'}</p>
                <p><strong>Classement:</strong> ${data.classement || 'N/A'}</p>
                <h3>Raw JSON:</h3>
                <pre>${JSON.stringify(data, null, 2)}</pre>
            `;
        }

        isProcessing = false; // Permettre un nouveau scan si nécessaire
        isShowingResults = true;
        manualCaptureButton.textContent = "♻️";
        manualCaptureButton.style.backgroundColor = 'grey';
        frozenImage.style.display = 'none';
        video.style.display = 'block';
        startCamera();
    }

    startCamera();

    function handleOrientation() {
        const orientationMessage = document.getElementById('orientation-message');
        const mainContainer = document.getElementById('main-container');
        const resultsContainer = document.getElementById('results-container');

        if (window.innerHeight > window.innerWidth) {
            // Portrait
            if (isShowingResults) {
                mainContainer.style.display = 'flex';
                resultsContainer.style.display = 'block';
                orientationMessage.style.display = 'none';
            } else {
                mainContainer.style.display = 'none';
                resultsContainer.style.display = 'none';
                orientationMessage.style.display = 'flex';
            }

            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
            }
        } else {
            // Landscape
            mainContainer.style.display = 'flex';
            resultsContainer.style.display = isShowingResults ? 'block' : 'none';
            orientationMessage.style.display = 'none';

            if (!stream) {
                startCamera();
            }
        }
    }

    window.addEventListener('resize', handleOrientation);
    handleOrientation(); // Initial check
}
