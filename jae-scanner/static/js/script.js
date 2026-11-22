document.addEventListener('DOMContentLoaded', () => {
    const ocrBaseUrl = (document.body.dataset.ocrUrl || 'https://jae-ocr-2500276981.europe-west1.run.app').replace(/\/$/, '');
    const loginGate = document.getElementById('login-gate');
    const pendingGate = document.getElementById('pending-gate');
    const scannerApp = document.getElementById('scanner-app');
    const authError = document.getElementById('auth-error');
    const googleLoginBtn = document.getElementById('google-login-btn');
    const pendingSignOutBtn = document.getElementById('pending-signout-btn');
    const signOutBtn = document.getElementById('signout-btn');
    const refreshMatchBtn = document.getElementById('refresh-match-btn');
    const activeMatchTeams = document.getElementById('active-match-teams');
    const activeMatchIdEl = document.getElementById('active-match-id');
    const userEmailLabel = document.getElementById('user-email-label');

    const video = document.getElementById('video');
    const scannerMessage = document.getElementById('scanner-message');
    const manualCaptureButton = document.getElementById('manual-capture-button');
    const orientationMessage = document.getElementById('orientation-message');
    const mainContainer = document.getElementById('main-container');
    const resultsContainer = document.getElementById('results-container');

    let stream = null;
    let isProcessing = false;
    let isShowingResults = false;
    let currentUser = null;
    let isApproved = false;
    let activeMatchId = null;

    function showAuthError(msg) {
        if (!authError) return;
        authError.textContent = msg;
        authError.style.display = 'block';
    }

    function showScannerMessage(message, isError = false) {
        scannerMessage.textContent = message;
        scannerMessage.style.backgroundColor = isError ? 'rgba(220, 38, 38, 0.8)' : 'rgba(15, 43, 70, 0.8)';
        scannerMessage.style.display = 'flex';
    }

    function hideScannerMessage() {
        scannerMessage.style.display = 'none';
    }

    function stopCamera() {
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
            stream = null;
        }
        if (video) video.srcObject = null;
    }

    async function startCamera() {
        if (!isApproved || stream) return;
        try {
            const constraints = {
                video: {
                    facingMode: 'environment',
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                    aspectRatio: { ideal: 1.586 }
                }
            };
            stream = await navigator.mediaDevices.getUserMedia(constraints);
            video.srcObject = stream;
            video.setAttribute('playsinline', '');
            video.setAttribute('muted', '');
            video.setAttribute('autoplay', '');
            video.addEventListener('loadedmetadata', () => hideScannerMessage(), { once: true });
        } catch (err) {
            console.error("Erreur d'accès à la caméra:", err);
            let message = "Impossible d'accéder à la caméra.";
            if (err.name === 'NotAllowedError') {
                message = "Vous avez refusé l'accès à la caméra. Veuillez autoriser l'accès dans les paramètres de votre navigateur.";
            } else if (err.name === 'NotFoundError') {
                message = "Aucune caméra compatible n'a été trouvée sur cet appareil.";
            }
            showScannerMessage(message, true);
        }
    }

    function handleOrientation() {
        if (!isApproved) {
            orientationMessage.style.display = 'none';
            return;
        }
        if (window.innerHeight > window.innerWidth) {
            if (isShowingResults) {
                mainContainer.style.display = 'flex';
                resultsContainer.style.display = 'block';
                orientationMessage.style.display = 'none';
            } else {
                mainContainer.style.display = 'none';
                resultsContainer.style.display = 'none';
                orientationMessage.style.display = 'flex';
            }
            stopCamera();
        } else {
            mainContainer.style.display = 'flex';
            resultsContainer.style.display = isShowingResults ? 'block' : 'none';
            orientationMessage.style.display = 'none';
            startCamera();
        }
    }

    window.addEventListener('resize', handleOrientation);

    async function loadActiveMatch() {
        if (!currentUser) return;
        const token = await currentUser.getIdToken();
        const resp = await fetch(`${ocrBaseUrl}/api/me`, {
            headers: { 'Authorization': 'Bearer ' + token }
        });
        if (!resp.ok) {
            throw new Error(`Impossible de vérifier le compte (HTTP ${resp.status})`);
        }
        const me = await resp.json();
        if (!me.approved) {
            isApproved = false;
            stopCamera();
            loginGate.style.display = 'none';
            scannerApp.style.display = 'none';
            pendingGate.style.display = 'block';
            return;
        }

        isApproved = true;
        const match = me.activeMatch || {};
        activeMatchId = match.matchId || '';
        const t1 = (match.team1Name || 'Équipe 1').trim();
        const t2 = (match.team2Name || 'Équipe 2').trim();
        activeMatchTeams.textContent = `${t1} vs ${t2}`;
        activeMatchIdEl.textContent = activeMatchId ? `#${activeMatchId}` : '';
        userEmailLabel.textContent = (me.user && me.user.email) || currentUser.email || '';

        loginGate.style.display = 'none';
        pendingGate.style.display = 'none';
        scannerApp.style.display = 'flex';
        handleOrientation();
    }

    function captureAndSend() {
        if (!currentUser || !isApproved) {
            showScannerMessage('Connexion Google requise.', true);
            isProcessing = false;
            return;
        }

        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0, canvas.width, canvas.height);

        const frozenImage = document.getElementById('frozen-image');
        frozenImage.src = canvas.toDataURL('image/jpeg', 0.9);
        video.style.display = 'none';
        frozenImage.style.display = 'block';
        stopCamera();

        canvas.toBlob(async (blob) => {
            const formData = new FormData();
            formData.append('file', blob, 'capture.jpg');

            try {
                const token = await currentUser.getIdToken();
                const response = await fetch('/scan', {
                    method: 'POST',
                    headers: { 'Authorization': 'Bearer ' + token },
                    body: formData,
                });
                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.error || 'Une erreur est survenue lors du scan.');
                }
                displayResults(data);
            } catch (error) {
                console.error("Erreur lors de l'envoi de l'image:", error);
                showScannerMessage(`Erreur : ${error.message}`, true);
                isProcessing = false;
            }
        }, 'image/jpeg', 0.92);
    }

    function displayResults(data) {
        const frozenImage = document.getElementById('frozen-image');
        hideScannerMessage();
        resultsContainer.style.display = 'block';

        if (data.error) {
            resultsContainer.innerHTML = `<p style="color: #b91c1c;">Erreur : ${data.error}</p>`;
        } else if (data.uploaded_file) {
            resultsContainer.innerHTML = `
                <h3>Scan envoyé</h3>
                <p>Rencontre <strong>#${data.match_id || activeMatchId}</strong> — analyse OCR en cours...</p>
            `;
        } else {
            resultsContainer.innerHTML = `<p style="color: orange;">Réponse inattendue du serveur.</p>`;
        }

        isProcessing = false;
        isShowingResults = true;
        manualCaptureButton.textContent = '♻️';
        manualCaptureButton.style.backgroundColor = 'grey';
        frozenImage.style.display = 'none';
        video.style.display = 'block';
        startCamera();
    }

    manualCaptureButton.addEventListener('click', () => {
        if (isShowingResults) {
            location.reload();
        } else if (!isProcessing) {
            isProcessing = true;
            showScannerMessage('Scan en cours...');
            manualCaptureButton.style.backgroundColor = '#007bff';
            captureAndSend();
        }
    });

    if (window.firebase && window.JAE_FIREBASE_CONFIG) {
        firebase.initializeApp(window.JAE_FIREBASE_CONFIG);
        const auth = firebase.auth();

        googleLoginBtn.addEventListener('click', async () => {
            if (authError) authError.style.display = 'none';
            const provider = new firebase.auth.GoogleAuthProvider();
            try {
                await auth.signInWithPopup(provider);
            } catch (e) {
                if (e && e.code === 'auth/popup-blocked') {
                    await auth.signInWithRedirect(provider);
                } else {
                    showAuthError(e.message || 'Échec de connexion Google');
                }
            }
        });

        pendingSignOutBtn.addEventListener('click', () => auth.signOut());
        signOutBtn.addEventListener('click', () => auth.signOut());
        refreshMatchBtn.addEventListener('click', () => {
            loadActiveMatch().catch(err => showScannerMessage(err.message, true));
        });

        auth.onAuthStateChanged(async (user) => {
            currentUser = user;
            if (!user) {
                isApproved = false;
                activeMatchId = null;
                stopCamera();
                scannerApp.style.display = 'none';
                pendingGate.style.display = 'none';
                orientationMessage.style.display = 'none';
                loginGate.style.display = 'block';
                return;
            }
            try {
                await loadActiveMatch();
            } catch (e) {
                showAuthError(e.message || 'Erreur lors du chargement de la rencontre.');
                scannerApp.style.display = 'none';
                loginGate.style.display = 'block';
            }
        });
    }
});
