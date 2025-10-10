let cvReady = false;
let stream;
const sharpnessThreshold = 100; // Seuil de netteté, à ajuster si nécessaire
let isProcessing = false;

// Cette fonction est appelée par le tag <script> dans index.html une fois OpenCV chargé
function onOpenCvReady() {
    cv['onRuntimeInitialized'] = () => {
        console.log("OpenCV.js est prêt.");
        cvReady = true;
        // On peut maintenant démarrer la logique de la caméra
        startApp();
    };
}

document.addEventListener('DOMContentLoaded', () => {
    // Si OpenCV est déjà prêt au moment où le DOM est chargé, on lance l'app
    if (cvReady) {
        startApp();
    }
});

function startApp() {
    const video = document.getElementById('video');
    const statusMessage = document.getElementById('status-message');

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
                // Démarrer l'analyse d'image une fois la vidéo chargée
                requestAnimationFrame(processVideo);
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

    function processVideo() {
        if (!cvReady || isProcessing) {
            return;
        }

        const cap = new cv.VideoCapture(video);
        const frame = new cv.Mat(video.videoHeight, video.videoWidth, cv.CV_8UC4);

        cap.read(frame); // Lire une image de la vidéo

        const gray = new cv.Mat();
        cv.cvtColor(frame, gray, cv.COLOR_RGBA2GRAY);

        const laplacian = new cv.Mat();
        cv.Laplacian(gray, laplacian, cv.CV_64F);

        const mean = new cv.Mat();
        const stddev = new cv.Mat();
        cv.meanStdDev(laplacian, mean, stddev);
        const sharpness = stddev.data64F[0] ** 2;

        console.log("Netteté:", sharpness.toFixed(2));

        if (sharpness > sharpnessThreshold) {
            isProcessing = true; // Empêcher les captures multiples
            statusMessage.textContent = "Image nette détectée, scan en cours...";
            captureAndSend();
        } else {
            // Continuer l'analyse
            requestAnimationFrame(processVideo);
        }

        // Libérer la mémoire
        frame.delete();
        gray.delete();
        laplacian.delete();
        mean.delete();
        stddev.delete();
    }

    function captureAndSend() {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Arrêter le flux vidéo
        stream.getTracks().forEach(track => track.stop());
        video.srcObject = null;

        // Afficher l'image capturée (optionnel, pour debug)
        // document.body.appendChild(canvas);

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

        if (data.error) {
            resultsContainer.innerHTML = `<p style="color: red;">Erreur d'extraction : ${data.error}</p>`;
        } else {
             resultsContainer.innerHTML = `
                <h3>Résultats de l'extraction</h3>
                <p><strong>Nom:</strong> ${data.prenom || 'N/A'} ${data.nom || 'N/A'}</p>
                <p><strong>Licence:</strong> ${data.licence || 'N/A'}</p>
                <p><strong>Validité:</strong> ${data.annee_validite || 'N/A'}</p>
                <p><strong>Classement:</strong> ${data.classement || 'N/A'}</p>
            `;
        }

        statusMessage.textContent = "Scan terminé !";
        statusMessage.style.color = '#555'; // Revenir à la couleur par défaut
        isProcessing = false; // Permettre un nouveau scan si nécessaire
    }

    startCamera();
}