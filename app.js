/**
 * Level Meter – app.js
 * Vumètre en temps réel pour animateurs radio/webradio
 * Stack : Vanilla JS + Web Audio API
 */

'use strict';

// ═══════════════════════════════════════════════
// ÉTAT GLOBAL
// ═══════════════════════════════════════════════
const state = {
    audioCtx: null,
    stream: null,
    source: null,
    analyserL: null,
    analyserR: null,
    analyserFFT: null,
    splitter: null,
    gainNode: null,

    // Peak holders
    peakL: -Infinity,
    peakR: -Infinity,
    peakLTimer: 0,
    peakRTimer: 0,
    PEAK_HOLD_MS: 2500,

    // Clip
    clipTimer: 0,
    CLIP_HOLD_MS: 1200,

    // LUFS
    lufsBuffer: [],          // historique pour LUFS intégré (blocs de 100ms)
    lufsIntegrated: null,
    lufsStartTime: 0,

    // Silence
    silenceTimer: 0,
    silenceDetected: false,
    lastSignalTime: Date.now(),

    // PiP
    pipActive: false,
    pipStream: null,
    pipAnimId: null,

    // Stream en ligne
    streamMode: false,       // true = on écoute un stream, false = carte son
    audioEl: null,           // <audio> qui lit le flux
    streamUrl: '',           // URL du flux en cours

    // RAF
    rafId: null,
    running: false,
};

// Silence : contrôle de l'alerte plein écran
let silenceOverlayDismissed   = false; // true = l'utilisateur a fermé l'alerte pour ce cycle
let silenceDetectionActive    = true;  // false = détection désactivée par l'utilisateur

// Journal de silence
const silenceLog = []; // { type: 'silence'|'resume', time: Date, duration?: number }

// ═══════════════════════════════════════════════
// SÉLECTEURS DOM
// ═══════════════════════════════════════════════
const $ = id => document.getElementById(id);

const dom = {
    permOverlay:    $('permissionOverlay'),
    errorOverlay:   $('errorOverlay'),
    errorTitle:     $('errorTitle'),
    errorMsg:       $('errorMsg'),
    requestPermBtn: $('requestPermBtn'),
    retryBtn:       $('retryBtn'),
    app:            $('app'),
    audioSourceBtn: $('audioSourceBtn'),

    // Stream
    streamBtn:        $('streamBtn'),
    stopStreamBtn:    $('stopStreamBtn'),
    streamModal:      $('streamModal'),
    streamUrlInput:   $('streamUrlInput'),
    streamRecent:     $('streamRecent'),
    streamError:      $('streamError'),
    streamCancelBtn:  $('streamCancelBtn'),
    streamConnectBtn: $('streamConnectBtn'),

    // VU-mètre
    clipIndicator:  $('clipIndicator'),
    dbValue:        $('dbValue'),
    vuFillL:        $('vuFillL'),
    vuFillR:        $('vuFillR'),
    vuPeakL:        $('vuPeakL'),
    vuPeakR:        $('vuPeakR'),
    resetPeakBtn:   $('resetPeakBtn'),

    // Spectre
    spectrumCanvas: $('spectrumCanvas'),
    dominantFreq:   $('dominantFreq'),

    // LUFS
    lufsM:          $('lufsM'),
    lufsI:          $('lufsI'),
    lufsMBar:       $('lufsMBar'),
    resetLufsBtn:   $('resetLufsBtn'),

    // Phase
    phaseCanvas:    $('phaseCanvas'),
    phaseCursor:    $('phaseCursor'),
    phaseValue:     $('phaseValue'),
    phaseStatus:    $('phaseStatus'),

    // Misc
    fundFreq:           $('fundFreq'),
    silenceIndicator:   $('silenceIndicator'),
    silenceThreshold:   $('silenceThreshold'),
    silenceEnabled:     $('silenceEnabled'),
    silenceEnabledLabel:$('silenceEnabledLabel'),
    silenceOverlay:     $('silenceOverlay'),
    silenceDuration:    $('silenceDuration'),
    silenceDismissBtn:  $('silenceDismissBtn'),
    clock:              $('clock'),

    // Log
    logBtn:         $('logBtn'),
    silenceLogModal:$('silenceLogModal'),
    logEntries:     $('logEntries'),
    clearLogBtn:    $('clearLogBtn'),
    closeLogBtn:    $('closeLogBtn'),

    // PiP
    pipBtn:         $('pipBtn'),
    pipCanvas:      $('pipCanvas'),
    pipVideo:       $('pipVideo'),
};

// ═══════════════════════════════════════════════
// HORLOGE
// ═══════════════════════════════════════════════
function updateClock() {
    const now = new Date();
    dom.clock.textContent = now.toLocaleTimeString('fr-FR', { hour12: false });
}
setInterval(updateClock, 1000);
updateClock();

// ═══════════════════════════════════════════════
// PERMISSIONS & INITIALISATION
// ═══════════════════════════════════════════════

// ═══════════════════════════════════════════════
// SÉLECTION DE LA SOURCE AUDIO — PANNEAU FLOTTANT
// Adapté de l'inspiration RadioBox / audio-output.js
// ═══════════════════════════════════════════════

// Persistance du choix entre les sessions
let selectedInputDeviceId = localStorage.getItem('lm_inputDeviceId') || 'default';
let selectedInputLabel    = localStorage.getItem('lm_inputLabel')    || '';

/** Met à jour le libellé du bouton source avec le nom court du périphérique */
function updateSourceBtnLabel() {
    const btn = dom.audioSourceBtn;
    if (!btn) return;
    const short = selectedInputLabel
        ? selectedInputLabel.replace(/\s*\(.*\)\s*$/, '').trim() || selectedInputLabel
        : '';
    btn.textContent = short ? `🎙 ${short}` : '🎙 Entrée audio';
    btn.title = selectedInputLabel || "Choisir la source audio d'entrée";
}

/** Retourne tous les périphériques d'entrée audio */
async function enumerateInputs() {
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter(d => d.kind === 'audioinput');
}

/** Applique un périphérique et redémarre le flux */
async function applyInputDevice(deviceId, label) {
    selectedInputDeviceId = deviceId;
    selectedInputLabel    = label || '';
    localStorage.setItem('lm_inputDeviceId', deviceId);
    localStorage.setItem('lm_inputLabel',    selectedInputLabel);
    updateSourceBtnLabel();
    await startAudio(deviceId === 'default' ? null : deviceId);
}

/** Construit le contenu du panneau de sélection des entrées */
async function populateInputPanel(panel, anchorBtn) {
    panel.innerHTML = '<div class="aip-msg">Détection des sources audio…</div>';

    const inputs = await enumerateInputs();
    panel.innerHTML = '';

    // Classement : default → physiques → communications
    const defaultDev = inputs.find(d => d.deviceId === 'default');
    const commDev    = inputs.find(d => d.deviceId === 'communications');
    const others     = inputs.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications');
    const hasUnlabelled = others.length === 0 || others.some(d => !d.label);

    const list = [
        { deviceId: 'default', label: defaultDev?.label || 'Entrée par défaut du système' },
    ];
    let unnamed = 0;
    others.forEach(d => {
        unnamed++;
        list.push({ deviceId: d.deviceId, label: d.label || `Entrée audio ${unnamed}` });
    });
    if (commDev) {
        list.push({ deviceId: 'communications', label: commDev.label || 'Entrée de communication' });
    }

    list.forEach(dev => {
        const isActive = dev.deviceId === selectedInputDeviceId;
        const item = document.createElement('div');
        item.className = 'aip-item' + (isActive ? ' aip-active' : '');
        item.title = dev.label;
        item.innerHTML =
            `<span class="aip-check">${isActive ? '✓' : ''}</span>` +
            `<span class="aip-label">${dev.label}</span>`;
        item.addEventListener('click', async () => {
            await applyInputDevice(dev.deviceId, dev.label);
            panel.remove();
        });
        panel.appendChild(item);
    });

    const sep = document.createElement('div');
    sep.className = 'aip-sep';
    panel.appendChild(sep);

    // Si les labels sont vides (permission pas encore accordée),
    // propose le même mécanisme "unlock" que l'inspiration.
    if (hasUnlabelled && !state.running) {
        const btnUnlock = document.createElement('div');
        btnUnlock.className = 'aip-item aip-unlock';
        btnUnlock.innerHTML =
            '<span class="aip-check">🔓</span>' +
            '<span class="aip-label">Autoriser pour voir les noms réels</span>';
        btnUnlock.title = 'Demande momentanément la permission micro pour révéler les labels';
        btnUnlock.addEventListener('click', async e => {
            e.stopPropagation();
            try {
                // getUserMedia débloque les labels, on coupe immédiatement
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                stream.getTracks().forEach(t => t.stop());
                panel.remove();
                openInputSourcePanel(anchorBtn); // ré-ouvre avec vrais noms
            } catch (_) {
                const errNote = document.createElement('div');
                errNote.className = 'aip-msg';
                errNote.textContent = "⚠ Permission refusée — impossible d'afficher les vrais noms.";
                btnUnlock.replaceWith(errNote);
            }
        });
        panel.appendChild(btnUnlock);
    }
}

/** Ouvre (ou ferme) le panneau flottant de sélection source */
async function openInputSourcePanel(anchorBtn) {
    const existing = document.getElementById('audioInputPanel');
    if (existing) { existing.remove(); return; }

    const panel = document.createElement('div');
    panel.id = 'audioInputPanel';
    panel.className = 'audio-input-panel';
    document.body.appendChild(panel);

    // Positionné sous le bouton, aligné à droite (identique inspiration)
    const rect = anchorBtn.getBoundingClientRect();
    panel.style.top   = (rect.bottom + 6) + 'px';
    panel.style.right = (window.innerWidth - rect.right) + 'px';

    await populateInputPanel(panel, anchorBtn);

    // Fermeture au clic extérieur
    setTimeout(() => {
        document.addEventListener('click', function outsideClick(e) {
            if (!panel.isConnected) { document.removeEventListener('click', outsideClick); return; }
            if (!panel.contains(e.target) && e.target !== anchorBtn) {
                panel.remove();
                document.removeEventListener('click', outsideClick);
            }
        });
    }, 0);
}

/** Affiche l'overlay d'erreur */
function showError(title, msg) {
    dom.errorTitle.textContent = title;
    dom.errorMsg.textContent = msg;
    dom.errorOverlay.classList.add('active');
}

/** Masque tous les overlays et affiche l'app */
function showApp() {
    dom.permOverlay.classList.remove('active');
    dom.errorOverlay.classList.remove('active');
    dom.app.classList.remove('hidden');
}

/** Démarre la capture audio (carte son) */
async function startAudio(deviceId) {
    // Arrêt propre si déjà démarré
    stopAudio();

    // Démarrer la carte son = sortir du mode stream
    state.streamMode = false;
    if (dom.streamBtn) updateStreamButtons();

    try {
        const constraints = {
            audio: {
                deviceId: deviceId ? { exact: deviceId } : undefined,
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false,
                sampleRate: 48000,
                channelCount: 2,
            }
        };

        state.stream = await navigator.mediaDevices.getUserMedia(constraints);

        // Récupère l'ID réel utilisé par le navigateur
        const activeTrack    = state.stream.getAudioTracks()[0];
        const activeDeviceId = activeTrack ? activeTrack.getSettings().deviceId : deviceId;

        // Après getUserMedia, les labels sont disponibles : met à jour le bouton source
        const allDevices   = await navigator.mediaDevices.enumerateDevices();
        const activeDevice = allDevices.find(d => d.deviceId === activeDeviceId);
        if (activeDevice?.label) {
            selectedInputDeviceId = activeDeviceId;
            selectedInputLabel    = activeDevice.label;
            localStorage.setItem('lm_inputDeviceId', activeDeviceId);
            localStorage.setItem('lm_inputLabel',    activeDevice.label);
        }
        updateSourceBtnLabel();

        buildAudioGraph();
        showApp();
        state.running = true;
        state.lufsStartTime = Date.now();
        loop();
    } catch (err) {
        handleAudioError(err);
    }
}

/** Gère les erreurs getUserMedia */
function handleAudioError(err) {
    let title = 'Accès refusé';
    let msg = 'Veuillez autoriser l\'accès au microphone dans les paramètres de votre navigateur, puis réessayez.';

    if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        title = 'Aucun périphérique trouvé';
        msg = 'Aucun microphone ou entrée audio n\'a été détecté. Branchez un périphérique et réessayez.';
    } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        title = 'Accès refusé';
        msg = 'L\'accès au microphone a été refusé. Autorisez l\'accès dans la barre d\'adresse de votre navigateur.';
    } else if (err.name === 'NotSupportedError') {
        title = 'Non supporté';
        msg = 'Votre navigateur ne supporte pas la Web Audio API. Utilisez Chrome, Firefox ou Edge.';
    } else if (err.name === 'OverconstrainedError') {
        title = 'Périphérique indisponible';
        msg = 'Le périphérique sélectionné n\'est plus disponible. Veuillez en choisir un autre.';
    }

    dom.permOverlay.classList.remove('active');
    showError(title, msg);
}

/** Construit le graphe Web Audio à partir de la carte son (MediaStream) */
function buildAudioGraph() {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });
    state.source = state.audioCtx.createMediaStreamSource(state.stream);
    // Carte son : pas de sortie audible (on ne fait que mesurer le signal)
    connectAnalysers(state.source, false);
}

/**
 * Branche un nœud source sur les analysers (L, R, FFT).
 * @param {AudioNode} sourceNode
 * @param {boolean} toDestination  true = rend le son audible (utilisé pour les streams)
 */
function connectAnalysers(sourceNode, toDestination) {
    // Splitter stéréo L/R
    state.splitter = state.audioCtx.createChannelSplitter(2);

    // Analyser FFT (merge stéréo)
    state.analyserFFT = state.audioCtx.createAnalyser();
    state.analyserFFT.fftSize = 2048;
    state.analyserFFT.smoothingTimeConstant = 0.8;

    // Analysers mono L et R
    state.analyserL = state.audioCtx.createAnalyser();
    state.analyserL.fftSize = 2048;
    state.analyserL.smoothingTimeConstant = 0.3;

    state.analyserR = state.audioCtx.createAnalyser();
    state.analyserR.fftSize = 2048;
    state.analyserR.smoothingTimeConstant = 0.3;

    // Merger pour l'analyser FFT global
    const merger = state.audioCtx.createChannelMerger(1);

    // Connexions
    sourceNode.connect(state.splitter);
    state.splitter.connect(state.analyserL, 0);   // L → analyser L
    state.splitter.connect(state.analyserR, 1);   // R → analyser R
    state.splitter.connect(merger, 0, 0);
    state.splitter.connect(merger, 1, 0);
    merger.connect(state.analyserFFT);

    // Sortie audible (streams uniquement — évite le larsen avec la carte son)
    if (toDestination) sourceNode.connect(state.audioCtx.destination);
}

/** Arrête la capture audio (carte son ET stream) */
function stopAudio() {
    state.running = false;
    if (state.rafId) { cancelAnimationFrame(state.rafId); state.rafId = null; }
    if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
    if (state.audioEl) {
        state.audioEl.pause();
        state.audioEl.removeAttribute('src');
        state.audioEl.load();
        state.audioEl = null;
    }
    if (state.audioCtx) { state.audioCtx.close(); state.audioCtx = null; }
}

// ═══════════════════════════════════════════════
// MONITORING D'UN STREAM EN LIGNE
// Lit un flux audio (<audio>) → Web Audio → analysers + haut-parleurs.
// Le son de la carte son est coupé pendant l'écoute du stream.
// ═══════════════════════════════════════════════

/** Vérifie qu'une chaîne est une URL http(s) exploitable */
function isValidStreamUrl(url) {
    try {
        const u = new URL(url);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
        return false;
    }
}

/** Démarre l'écoute + l'analyse d'un flux en ligne */
async function startStream(url) {
    stopAudio();

    state.streamMode = true;
    state.streamUrl  = url;
    state.lufsBuffer = [];

    try {
        state.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 });

        const audioEl = new Audio();
        audioEl.crossOrigin = 'anonymous';   // requis pour l'analyse Web Audio (CORS)
        audioEl.preload     = 'auto';
        audioEl.src         = url;
        state.audioEl = audioEl;

        // Erreurs réseau / décodage / CORS arrivent via l'event "error"
        audioEl.addEventListener('error', onStreamMediaError, { once: true });

        // Branche le flux sur les analysers ET sur les haut-parleurs (audible)
        state.source = state.audioCtx.createMediaElementSource(audioEl);
        connectAnalysers(state.source, true);

        await audioEl.play();
        if (state.audioCtx.state === 'suspended') await state.audioCtx.resume();

        saveRecentStream(url);
        closeStreamModal();
        showApp();
        updateStreamButtons();

        state.running       = true;
        state.lufsStartTime = Date.now();
        loop();
    } catch (err) {
        failStream(streamErrorMessage(err));
    }
}

/** Arrête le stream et repasse sur le son de la carte son */
async function stopStream() {
    state.streamMode = false;
    state.streamUrl  = '';
    updateStreamButtons();
    // Revient sur la dernière entrée audio choisie
    const savedId = selectedInputDeviceId && selectedInputDeviceId !== 'default'
        ? selectedInputDeviceId : null;
    await startAudio(savedId);
}

/** Annule le stream en cours et affiche l'erreur dans la modale */
function failStream(msg) {
    stopAudio();
    state.streamMode = false;
    updateStreamButtons();
    openStreamModal();
    showStreamError(msg);
}

/** Gère l'event "error" de l'élément <audio> */
function onStreamMediaError() {
    if (!state.streamMode) return;
    const e = state.audioEl ? state.audioEl.error : null;
    let msg = "Impossible de lire ce flux. Vérifiez l'URL.";
    if (e) {
        switch (e.code) {
            case e.MEDIA_ERR_ABORTED:
                msg = 'Lecture interrompue.';
                break;
            case e.MEDIA_ERR_NETWORK:
                msg = 'Erreur réseau : le serveur du flux est injoignable.';
                break;
            case e.MEDIA_ERR_DECODE:
                msg = 'Flux illisible : erreur de décodage audio.';
                break;
            case e.MEDIA_ERR_SRC_NOT_SUPPORTED:
                msg = "Flux inaccessible : format non supporté, ou le serveur n'autorise pas le CORS "
                    + "(en-tête Access-Control-Allow-Origin manquant).";
                break;
        }
    }
    failStream(msg);
}

/** Construit un message lisible à partir d'une erreur play()/createMediaElementSource */
function streamErrorMessage(err) {
    if (!err) return 'Erreur inconnue lors de la lecture du flux.';
    switch (err.name) {
        case 'NotAllowedError':
            return "Lecture bloquée par le navigateur. Cliquez à nouveau sur « Monitorer ».";
        case 'NotSupportedError':
            return "Flux non supporté ou CORS non autorisé par le serveur.";
        case 'AbortError':
            return 'Lecture interrompue.';
        default:
            return 'Impossible de lire ce flux : ' + (err.message || err.name);
    }
}

/** Met à jour l'état visuel des boutons stream */
function updateStreamButtons() {
    if (state.streamMode) {
        dom.streamBtn.classList.add('active');
        dom.streamBtn.textContent = '📡 Stream en cours';
        dom.stopStreamBtn.classList.remove('hidden');
    } else {
        dom.streamBtn.classList.remove('active');
        dom.streamBtn.textContent = '📡 Monitorer un stream';
        dom.stopStreamBtn.classList.add('hidden');
    }
}

// ─── Modale de saisie de l'URL ───
function openStreamModal() {
    dom.streamError.classList.add('hidden');
    dom.streamUrlInput.value = state.streamUrl || '';
    renderRecentStreams();
    dom.streamModal.classList.add('active');
    setTimeout(() => dom.streamUrlInput.focus(), 50);
}

function closeStreamModal() {
    dom.streamModal.classList.remove('active');
}

function showStreamError(msg) {
    dom.streamError.textContent = msg;
    dom.streamError.classList.remove('hidden');
}

/** Valide la saisie puis lance le stream */
function submitStream() {
    const url = dom.streamUrlInput.value.trim();
    if (!url) {
        showStreamError('Veuillez saisir une URL de flux.');
        return;
    }
    if (!isValidStreamUrl(url)) {
        showStreamError('URL invalide : elle doit commencer par http:// ou https://');
        return;
    }
    dom.streamError.classList.add('hidden');
    startStream(url);
}

// ─── Historique des flux récents (localStorage) ───
const RECENT_STREAMS_KEY = 'lm_recentStreams';

function loadRecentStreams() {
    try {
        const list = JSON.parse(localStorage.getItem(RECENT_STREAMS_KEY));
        return Array.isArray(list) ? list : [];
    } catch (_) {
        return [];
    }
}

function saveRecentStream(url) {
    let list = loadRecentStreams().filter(u => u !== url);
    list.unshift(url);
    list = list.slice(0, 6);
    localStorage.setItem(RECENT_STREAMS_KEY, JSON.stringify(list));
}

function renderRecentStreams() {
    const container = dom.streamRecent;
    container.innerHTML = '';
    loadRecentStreams().forEach(url => {
        const item = document.createElement('div');
        item.className = 'stream-recent-item';
        item.title = url;

        const icon = document.createElement('span');
        icon.textContent = '🕑';
        const label = document.createElement('span');
        label.className = 'sr-url';
        label.textContent = url;

        item.append(icon, label);
        item.addEventListener('click', () => {
            dom.streamUrlInput.value = url;
            dom.streamUrlInput.focus();
        });
        container.appendChild(item);
    });
}

// ═══════════════════════════════════════════════
// UTILITAIRES DSP
// ═══════════════════════════════════════════════

/**
 * Seuil de déclenchement du CLIP, exprimé sur le niveau affiché par le VU-mètre
 * (RMS max L/R en dBFS). Le CLIP s'allume quand l'aiguille atteint le sommet de
 * l'échelle. Ajustable : -1.0 = pile en haut, -3.0 = plus sensible.
 */
const CLIP_DB_THRESHOLD = -1.0;

/** Convertit une valeur linéaire (0–1) en dBFS */
function linToDb(lin) {
    return lin > 0 ? 20 * Math.log10(lin) : -Infinity;
}

/** Convertit dBFS en pourcentage d'affichage (–60dB = 0%, 0dB = 100%) */
function dbToPercent(db) {
    const min = -60, max = 0;
    return Math.max(0, Math.min(100, ((db - min) / (max - min)) * 100));
}

/**
 * RMS d'un buffer Float32
 * @param {Float32Array} buf
 * @returns {number} valeur RMS 0–1
 */
function rms(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
}

// ═══════════════════════════════════════════════
// LUFS (EBU R128 simplifié)
// Filtre K-weighting (approx. biquad)
// ═══════════════════════════════════════════════

/** Buffer circulaire pour la moyenne glissante LUFS intégré */
const LUFS_BLOCK_DURATION_MS = 100; // blocs de 100ms

/** Calcul LUFS momentané à partir d'un bloc de samples */
function computeLufsBlock(samplesL, samplesR) {
    // K-weighting simplifié : pré-filtre + pondération haute fréquence
    // On utilise ici la puissance RMS² pondérée par canal
    const kL = kWeightedRms(samplesL);
    const kR = kWeightedRms(samplesR);
    const meanSquare = (kL * kL + kR * kR) / 2;
    if (meanSquare <= 0) return -Infinity;
    // LUFS = -0.691 + 10*log10(somme des carrés pondérés)
    return -0.691 + 10 * Math.log10(meanSquare);
}

/** RMS avec pondération K (filtre passe-haut 1er ordre simplifié) */
function kWeightedRms(samples) {
    // Pré-filtre HPF à ~60 Hz (coefficient simplifié pour 48kHz)
    const fc = 60 / 48000;
    const a1 = 1 - 2 * Math.PI * fc;
    let x1 = 0, sum = 0;
    for (let i = 0; i < samples.length; i++) {
        const y = samples[i] - a1 * x1;
        x1 = samples[i];
        sum += y * y;
    }
    return Math.sqrt(sum / samples.length);
}

/** Calcule le LUFS intégré (moyenne des blocs > seuil) */
function computeIntegratedLufs() {
    if (state.lufsBuffer.length < 4) return null;
    // Seuil relatif : ne prend que les blocs > –70 LUFS
    const valid = state.lufsBuffer.filter(v => v > -70);
    if (valid.length === 0) return null;
    const meanSquareSum = valid.reduce((acc, l) => acc + Math.pow(10, (l + 0.691) / 10), 0) / valid.length;
    return -0.691 + 10 * Math.log10(meanSquareSum);
}

// ═══════════════════════════════════════════════
// DÉTECTION DE FRÉQUENCE FONDAMENTALE (autocorrélation)
// ═══════════════════════════════════════════════
function detectFundamentalFreq(buffer, sampleRate) {
    const SIZE = buffer.length;
    const correlations = new Float32Array(SIZE);
    // Autocorrélation
    for (let lag = 0; lag < SIZE / 2; lag++) {
        let sum = 0;
        for (let i = 0; i < SIZE / 2; i++) sum += buffer[i] * buffer[i + lag];
        correlations[lag] = sum;
    }
    // Cherche le premier pic après le minimum
    let d = 0;
    while (d < SIZE / 2 && correlations[d] > correlations[d + 1]) d++;
    let maxVal = -Infinity, maxPos = -1;
    for (let i = d; i < SIZE / 2; i++) {
        if (correlations[i] > maxVal) { maxVal = correlations[i]; maxPos = i; }
    }
    if (maxPos < 2) return 0;
    // Interpolation parabolique
    const y1 = correlations[maxPos - 1];
    const y2 = correlations[maxPos];
    const y3 = correlations[maxPos + 1] || 0;
    const delta = (y3 - y1) / (2 * (2 * y2 - y1 - y3) || 1);
    const freq = sampleRate / (maxPos + delta);
    return (freq > 20 && freq < 20000) ? freq : 0;
}

// ═══════════════════════════════════════════════
// CORRÉLATION STÉRÉO (PHASE METER)
// ═══════════════════════════════════════════════
function computeCorrelation(bufL, bufR) {
    let sumL = 0, sumR = 0, sumLR = 0;
    const n = Math.min(bufL.length, bufR.length);
    for (let i = 0; i < n; i++) {
        sumL  += bufL[i] * bufL[i];
        sumR  += bufR[i] * bufR[i];
        sumLR += bufL[i] * bufR[i];
    }
    const denom = Math.sqrt(sumL * sumR);
    return denom > 0 ? sumLR / denom : 0;
}

// ═══════════════════════════════════════════════
// RENDER : VU-MÈTRE
// ═══════════════════════════════════════════════
function renderVuMeter(dbL, dbR, peakDbL, peakDbR, isClipping) {
    const now = performance.now();

    // Overlay sombre : couvre la portion "vide" (haut de la barre)
    // height = (100 - fill%) → quand signal monte, l'overlay recule
    dom.vuFillL.style.height = (100 - dbToPercent(dbL)) + '%';
    dom.vuFillR.style.height = (100 - dbToPercent(dbR)) + '%';

    // Peak L
    if (dbL > state.peakL) { state.peakL = dbL; state.peakLTimer = now; }
    if (now - state.peakLTimer > state.PEAK_HOLD_MS) {
        state.peakL = Math.max(state.peakL - 0.5, -60);
    }
    const peakPctL = dbToPercent(state.peakL);
    dom.vuPeakL.style.bottom = peakPctL + '%';
    dom.vuPeakL.classList.toggle('visible', peakPctL > 1);

    // Peak R
    if (dbR > state.peakR) { state.peakR = dbR; state.peakRTimer = now; }
    if (now - state.peakRTimer > state.PEAK_HOLD_MS) {
        state.peakR = Math.max(state.peakR - 0.5, -60);
    }
    const peakPctR = dbToPercent(state.peakR);
    dom.vuPeakR.style.bottom = peakPctR + '%';
    dom.vuPeakR.classList.toggle('visible', peakPctR > 1);

    // Valeur dB numérique (max L/R)
    const dbMax = Math.max(dbL, dbR);
    dom.dbValue.textContent = isFinite(dbMax) ? dbMax.toFixed(1) : '−∞';

    // Couleur dB en fonction du niveau
    if (dbMax >= -6)        dom.dbValue.style.color = 'var(--vu-red)';
    else if (dbMax >= -12)  dom.dbValue.style.color = 'var(--vu-orange)';
    else                    dom.dbValue.style.color = 'var(--text-main)';

    // Indicateur CLIP
    if (isClipping) {
        state.clipTimer = now;
        dom.clipIndicator.classList.add('clipping');
    } else if (now - state.clipTimer > state.CLIP_HOLD_MS) {
        dom.clipIndicator.classList.remove('clipping');
    }
}

// ═══════════════════════════════════════════════
// RENDER : SPECTRE FFT
// ═══════════════════════════════════════════════
const specCtx = dom.spectrumCanvas.getContext('2d');

// Hover cursor sur le spectre
const spectrumHover = { active: false, x: 0 };
dom.spectrumCanvas.addEventListener('mousemove', e => {
    const rect = dom.spectrumCanvas.getBoundingClientRect();
    spectrumHover.active = true;
    spectrumHover.x = e.clientX - rect.left;
});
dom.spectrumCanvas.addEventListener('mouseleave', () => {
    spectrumHover.active = false;
});

function renderSpectrum(dataArray) {
    const canvas = dom.spectrumCanvas;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W;
        canvas.height = H;
    }

    specCtx.clearRect(0, 0, W, H);

    // Fond grille
    specCtx.strokeStyle = 'rgba(255,255,255,0.04)';
    specCtx.lineWidth = 1;
    for (let db = -12; db >= -60; db -= 12) {
        const y = H - ((db + 90) / 90) * H;
        specCtx.beginPath();
        specCtx.moveTo(0, y);
        specCtx.lineTo(W, y);
        specCtx.stroke();
    }

    const bufLen = dataArray.length;
    const sampleRateLocal = state.audioCtx ? state.audioCtx.sampleRate : 48000;
    const fftSizeLocal = state.analyserFFT ? state.analyserFFT.fftSize : 2048;
    const freqPerBinLocal = sampleRateLocal / fftSizeLocal;
    const minFreq = 20;
    const maxFreq = 20000;
    const logMin = Math.log10(minFreq);
    const logMax = Math.log10(maxFreq);

    // Barres de 2px fixes, chaque colonne représente la fréquence log à sa position X.
    // À gauche : chaque barre couvre peu de Hz. À droite : chaque barre couvre beaucoup de Hz.
    const BAR_W  = 4;
    const TOP_PAD = 6;
    let maxMag = 0, maxBin = 0;

    for (let px = 0; px + BAR_W <= W; px += BAR_W) {
        // Fréquences correspondant aux bords gauche et droit (linéaire)
        const freqLow  = minFreq + (px / W)          * (maxFreq - minFreq);
        const freqHigh = minFreq + ((px + BAR_W) / W) * (maxFreq - minFreq);

        const binLow  = Math.max(1,          Math.floor(freqLow  / freqPerBinLocal));
        const binHigh = Math.min(bufLen - 1, Math.ceil (freqHigh / freqPerBinLocal));

        // Valeur max dans la plage de bins couverte par cette colonne
        let barVal = 0, barBin = binLow;
        for (let i = binLow; i <= binHigh; i++) {
            if (dataArray[i] > barVal) { barVal = dataArray[i]; barBin = i; }
        }

        const mag  = (barVal / 255) * 90 - 90;
        const barH = Math.min(H - TOP_PAD, ((mag + 90) / 90) * H);

        // Dégradé bleu-violet → cyan
        const t   = px / W;
        const hue = 260 - t * 80;
        specCtx.fillStyle = `hsla(${hue}, 75%, 58%, 0.9)`;
        specCtx.fillRect(px, H - barH, BAR_W - 1, barH);

        if (barVal > maxMag) { maxMag = barVal; maxBin = barBin; }
    }

    // Fréquence dominante dans le badge
    const domFreq = maxBin * freqPerBinLocal;
    dom.dominantFreq.textContent = domFreq > 0
        ? (domFreq < 1000 ? domFreq.toFixed(0) + ' Hz' : (domFreq / 1000).toFixed(2) + ' kHz')
        : '– Hz';

    // Curseur de survol : ligne verticale + étiquette fréquence
    if (spectrumHover.active) {
        const hx = spectrumHover.x;
        const hoverFreq = minFreq + (hx / W) * (maxFreq - minFreq);
        const freqLabel = hoverFreq < 1000
            ? hoverFreq.toFixed(0) + ' Hz'
            : (hoverFreq / 1000).toFixed(2) + ' kHz';

        // Ligne verticale
        specCtx.save();
        specCtx.strokeStyle = 'rgba(255,255,255,0.55)';
        specCtx.lineWidth = 1;
        specCtx.setLineDash([4, 3]);
        specCtx.beginPath();
        specCtx.moveTo(hx, 0);
        specCtx.lineTo(hx, H);
        specCtx.stroke();
        specCtx.setLineDash([]);

        // Bulle d'étiquette
        specCtx.font = '600 11px Inter, sans-serif';
        const tw = specCtx.measureText(freqLabel).width;
        const PAD = 6;
        const bW = tw + PAD * 2;
        const bH = 20;
        const bY = 8;
        let bX = hx + 8;
        if (bX + bW > W) bX = hx - bW - 8;

        specCtx.fillStyle = 'rgba(20,20,35,0.82)';
        specCtx.beginPath();
        specCtx.roundRect(bX, bY, bW, bH, 4);
        specCtx.fill();

        specCtx.fillStyle = '#e0e8ff';
        specCtx.textBaseline = 'middle';
        specCtx.fillText(freqLabel, bX + PAD, bY + bH / 2);
        specCtx.restore();
    }

    return domFreq;
}

// ═══════════════════════════════════════════════
// RENDER : LUFS
// ═══════════════════════════════════════════════
function renderLufs(lufsM, lufsI) {
    // LUFS momentané
    dom.lufsM.textContent = isFinite(lufsM) ? lufsM.toFixed(1) : '–';
    dom.lufsI.textContent = lufsI !== null && isFinite(lufsI) ? lufsI.toFixed(1) : '–';

    // Barre (-40 à 0 LUFS → 0% à 100%)
    const pct = Math.max(0, Math.min(100, ((lufsM + 40) / 40) * 100));
    dom.lufsMBar.style.width = pct + '%';

    if (lufsM > -9)       dom.lufsMBar.style.background = 'var(--vu-red)';
    else if (lufsM > -18) dom.lufsMBar.style.background = 'var(--vu-orange)';
    else                  dom.lufsMBar.style.background = 'var(--vu-green)';
}

// ═══════════════════════════════════════════════
// RENDER : CORRÉLATION STÉRÉO (lissajous + gauge)
// ═══════════════════════════════════════════════
const phaseCtx = dom.phaseCanvas.getContext('2d');
let phaseSmooth = 0;

function renderPhase(bufL, bufR, correlation) {
    // Lissage de la valeur de corrélation
    phaseSmooth = phaseSmooth * 0.9 + correlation * 0.1;
    const corr = Math.max(-1, Math.min(1, phaseSmooth));

    // Curseur gauge : 0% = -1, 50% = 0, 100% = +1
    const pct = ((corr + 1) / 2) * 100;
    dom.phaseCursor.style.left = pct + '%';

    // Valeur numérique
    dom.phaseValue.textContent = (corr >= 0 ? '+' : '') + corr.toFixed(2);

    // Statut
    if (corr > 0.3) {
        dom.phaseStatus.textContent = 'Phase correcte';
        dom.phaseStatus.className = 'phase-status ok';
    } else if (corr > -0.1) {
        dom.phaseStatus.textContent = 'Phase incertaine';
        dom.phaseStatus.className = 'phase-status warn';
    } else {
        dom.phaseStatus.textContent = 'Phase inversée !';
        dom.phaseStatus.className = 'phase-status bad';
    }

    // Lissajous
    const canvas = dom.phaseCanvas;
    const W = canvas.offsetWidth || 160;
    const H = 120;
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }

    phaseCtx.fillStyle = 'rgba(28,28,32,0.4)';
    phaseCtx.fillRect(0, 0, W, H);

    // Axes
    phaseCtx.strokeStyle = 'rgba(255,255,255,0.06)';
    phaseCtx.lineWidth = 1;
    phaseCtx.beginPath();
    phaseCtx.moveTo(W / 2, 0); phaseCtx.lineTo(W / 2, H);
    phaseCtx.moveTo(0, H / 2); phaseCtx.lineTo(W, H / 2);
    phaseCtx.stroke();

    // Tracé Lissajous
    const n = Math.min(bufL.length, bufR.length);
    if (n > 0) {
        phaseCtx.beginPath();
        phaseCtx.strokeStyle = 'rgba(99,102,241,0.7)';
        phaseCtx.lineWidth = 1.5;
        for (let i = 0; i < n; i++) {
            const x = (bufR[i] * 0.45 + 0.5) * W;
            const y = (1 - (bufL[i] * 0.45 + 0.5)) * H;
            i === 0 ? phaseCtx.moveTo(x, y) : phaseCtx.lineTo(x, y);
        }
        phaseCtx.stroke();
    }
}

// ═══════════════════════════════════════════════
// JOURNAL DE SILENCE
// ═══════════════════════════════════════════════

function addSilenceLogEntry(type) {
    const now = new Date();
    const entry = { type, time: now };
    if (type === 'resume' && silenceLog.length > 0) {
        const last = [...silenceLog].reverse().find(e => e.type === 'silence');
        if (last) entry.duration = Math.round((now - last.time) / 1000);
    }
    silenceLog.push(entry);
    if (silenceLog.length > 500) silenceLog.shift();
}

function formatLogDate(date) {
    return date.toLocaleDateString('fr-FR') + ' ' + date.toLocaleTimeString('fr-FR', { hour12: false });
}

function renderLogEntries() {
    const container = dom.logEntries;
    if (!container) return;
    if (silenceLog.length === 0) {
        container.innerHTML = '<div class="log-empty">Aucun événement enregistré.</div>';
        return;
    }
    container.innerHTML = '';
    [...silenceLog].reverse().forEach(entry => {
        const div = document.createElement('div');
        div.className = 'log-entry ' + entry.type;
        const icon  = entry.type === 'silence' ? '🔇' : '🔊';
        const label = entry.type === 'silence' ? 'Silence détecté' : 'Son repris';
        const sub   = entry.duration != null ? `durée : ${entry.duration}s` : '';
        div.innerHTML =
            `<span class="log-entry-icon">${icon}</span>` +
            `<span class="log-entry-text"><strong>${label}</strong>${sub ? '<span>' + sub + '</span>' : ''}</span>` +
            `<span class="log-entry-time">${formatLogDate(entry.time)}</span>`;
        container.appendChild(div);
    });
}

// ═══════════════════════════════════════════════
// RENDER : SILENCE
// ═══════════════════════════════════════════════
function updateSilenceDetection(dbMax) {
    // Si détection désactivée, on nettoie et on sort
    if (!silenceDetectionActive) {
        if (state.silenceDetected) {
            state.silenceDetected = false;
            silenceOverlayDismissed = false;
            dom.silenceIndicator.classList.remove('silent');
            dom.silenceOverlay.classList.add('hidden');
        }
        return;
    }

    const THRESHOLD_DB = -50; // niveau en-dessous duquel on considère le silence
    const silenceSec   = parseInt(dom.silenceThreshold.value) || 5;

    if (dbMax > THRESHOLD_DB) {
        // Signal présent : réinitialise tout
        state.lastSignalTime = Date.now();
        if (state.silenceDetected) {
            state.silenceDetected    = false;
            silenceOverlayDismissed  = false; // le prochain silence rouvrira l'alerte
            dom.silenceIndicator.classList.remove('silent');
            dom.silenceOverlay.classList.add('hidden');
            addSilenceLogEntry('resume');
        }
    } else {
        const elapsed = (Date.now() - state.lastSignalTime) / 1000;

        if (elapsed >= silenceSec) {
            // Passe en état "silence détecté"
            if (!state.silenceDetected) {
                state.silenceDetected = true;
                dom.silenceIndicator.classList.add('silent');
                addSilenceLogEntry('silence');
            }

            // Met à jour le compteur de secondes dans l'overlay
            if (dom.silenceDuration) {
                dom.silenceDuration.textContent = Math.floor(elapsed);
            }

            // Affiche l'overlay plein écran si l'utilisateur ne l'a pas fermé
            if (!silenceOverlayDismissed) {
                dom.silenceOverlay.classList.remove('hidden');
            }
        }
    }
}

// ═══════════════════════════════════════════════
// FRÉQUENCE FONDAMENTALE
// ═══════════════════════════════════════════════
let fundCounter = 0;
const FUND_UPDATE_INTERVAL = 8; // rafraîchir toutes les 8 frames

function updateFundamentalFreq(bufL) {
    fundCounter++;
    if (fundCounter % FUND_UPDATE_INTERVAL !== 0) return;
    const sampleRate = state.audioCtx ? state.audioCtx.sampleRate : 48000;
    const freq = detectFundamentalFreq(bufL, sampleRate);
    dom.fundFreq.textContent = freq > 0
        ? (freq < 1000 ? Math.round(freq) : (freq / 1000).toFixed(2) + 'k')
        : '–';
}

// ═══════════════════════════════════════════════
// BOUCLE PRINCIPALE (requestAnimationFrame)
// ═══════════════════════════════════════════════
let lufsBlockTimer = 0;

function loop(timestamp) {
    if (!state.running) return;
    state.rafId = requestAnimationFrame(loop);

    const bufSize = state.analyserL.fftSize;

    // Buffers time-domain
    const tdL = new Float32Array(bufSize);
    const tdR = new Float32Array(bufSize);
    state.analyserL.getFloatTimeDomainData(tdL);
    state.analyserR.getFloatTimeDomainData(tdR);

    // Buffer fréquentiel
    const freqData = new Uint8Array(state.analyserFFT.frequencyBinCount);
    state.analyserFFT.getByteFrequencyData(freqData);

    // ── Niveaux ──────────────────────────────
    const rmsL = rms(tdL), rmsR = rms(tdR);
    const dbL  = linToDb(rmsL);
    const dbR  = linToDb(rmsR);
    // CLIP basé sur le niveau global affiché par le VU-mètre (RMS max L/R) :
    // s'allume seulement quand l'aiguille atteint le haut de l'échelle (≈ 0 dB)
    const isClipping = Math.max(dbL, dbR) >= CLIP_DB_THRESHOLD;

    renderVuMeter(dbL, dbR, dbL, dbR, isClipping);

    // ── Spectre ───────────────────────────────
    const specDomFreq = renderSpectrum(freqData);

    // ── LUFS (blocs de ~100ms) ────────────────
    const now = performance.now();
    if (now - lufsBlockTimer >= 100) {
        lufsBlockTimer = now;
        const lufsBlock = computeLufsBlock(tdL, tdR);
        if (isFinite(lufsBlock)) state.lufsBuffer.push(lufsBlock);
        // Garde max 10 minutes de mesure
        if (state.lufsBuffer.length > 6000) state.lufsBuffer.shift();
        // LUFS momentané : moyenne des 4 derniers blocs (~400ms)
        const recent = state.lufsBuffer.slice(-4);
        let lufsM = -Infinity;
        if (recent.length > 0) {
            const sq = recent.reduce((a, v) => a + Math.pow(10, (v + 0.691) / 10), 0) / recent.length;
            lufsM = sq > 0 ? -0.691 + 10 * Math.log10(sq) : -Infinity;
        }
        const lufsI = computeIntegratedLufs();
        renderLufs(lufsM, lufsI);
    }

    // ── Corrélation stéréo ────────────────────
    const corr = computeCorrelation(tdL, tdR);
    // Sous-échantillonnage du buffer pour le lissajous
    const lissStep = Math.max(1, Math.floor(bufSize / 256));
    const lissL = tdL.filter((_, i) => i % lissStep === 0);
    const lissR = tdR.filter((_, i) => i % lissStep === 0);
    renderPhase(lissL, lissR, corr);

    // ── Fréquence fondamentale ─────────────────
    if (specDomFreq > 0) {
        dom.fundFreq.textContent = specDomFreq < 1000
            ? Math.round(specDomFreq)
            : (specDomFreq / 1000).toFixed(2) + 'k';
    } else {
        dom.fundFreq.textContent = '–';
    }

    // ── Détection de silence ───────────────────
    updateSilenceDetection(Math.max(dbL, dbR));

    // ── PiP ────────────────────────────────────
    if (state.pipActive) renderPip(dbL, dbR, isClipping);
}

// ═══════════════════════════════════════════════
// PICTURE-IN-PICTURE
// Via canvas → captureStream → <video> → PiP
// ═══════════════════════════════════════════════
let pipCtx = dom.pipCanvas.getContext('2d');

/**
 * Rendu PiP — portrait 9:16 (270×480)
 * Deux barres VU verticales côte-à-côte avec gradient vert/orange/rouge
 */
function renderPip(dbL, dbR, isClipping) {
    const REF_W = 160, REF_H = 285;
    const PAD   = 12;
    const W = pipCtx.canvas.width  || REF_W;
    const H = pipCtx.canvas.height || REF_H;

    // ── Fond (couvre tout le canvas, letterbox compris) ──
    pipCtx.fillStyle = '#1c1c20';
    pipCtx.fillRect(0, 0, W, H);

    // ── Mise à l'échelle uniforme centrée (ratio 160:285 préservé) ──
    const scale = Math.min(W / REF_W, H / REF_H);
    const ox = (W - REF_W * scale) / 2;
    const oy = (H - REF_H * scale) / 2;
    pipCtx.save();
    pipCtx.translate(ox, oy);
    pipCtx.scale(scale, scale);

    // ── Titre ──
    pipCtx.fillStyle = '#a1a1aa';
    pipCtx.font = '600 8px Inter, sans-serif';
    pipCtx.textAlign = 'center';
    pipCtx.fillText('LEVEL METER', REF_W / 2, 12);

    // ── Valeur dB ──
    const dbMax = Math.max(dbL, dbR);
    const dbStr = isFinite(dbMax) ? dbMax.toFixed(1) + ' dB' : '−∞ dB';
    pipCtx.fillStyle = dbMax >= -6 ? '#ef4444' : dbMax >= -12 ? '#f59e0b' : '#fafafa';
    pipCtx.font = '800 25px Inter, monospace';
    pipCtx.textAlign = 'center';
    pipCtx.fillText(dbStr, REF_W / 2, 40);

    // ── CLIP ──
    if (isClipping) {
        pipCtx.strokeStyle = '#ef4444';
        pipCtx.lineWidth = 1.5;
        pipCtx.font = '800 8px Inter, sans-serif';
        pipCtx.textAlign = 'center';
        // Badge CLIP
        pipCtx.fillStyle = 'rgba(239,68,68,0.2)';
        pipCtx.beginPath();
        pipCtx.roundRect(REF_W / 2 - 17, 46, 34, 12, 3);
        pipCtx.fill();
        pipCtx.strokeRect(REF_W / 2 - 17, 46, 34, 12);
        pipCtx.fillStyle = '#ef4444';
        pipCtx.fillText('CLIP', REF_W / 2, 55);
    }

    // ── Barres VU ──
    const SCALE_W = 15;
    const BAR_TOP = 64;
    const BAR_BOT = REF_H - 19;
    const BAR_H   = BAR_BOT - BAR_TOP;
    const totalBarsW = REF_W - PAD * 2 - SCALE_W;
    const barW = (totalBarsW / 2) - 2;
    const barLX = PAD;
    const barRX = PAD + barW + SCALE_W + 5;

    /** Dessine une barre VU avec gradient baked-in + overlay vide */
    function drawVuBar(x, db, label) {
        const bx = x, by = BAR_TOP, bw = barW, bh = BAR_H;

        // Gradient (vert bas → orange → rouge haut)
        const grad = pipCtx.createLinearGradient(0, by + bh, 0, by);
        grad.addColorStop(0,    '#22c55e');
        grad.addColorStop(0.60, '#22c55e');
        grad.addColorStop(0.60, '#f59e0b');
        grad.addColorStop(0.80, '#f59e0b');
        grad.addColorStop(0.80, '#ef4444');
        grad.addColorStop(1,    '#ef4444');

        pipCtx.fillStyle = grad;
        pipCtx.beginPath();
        pipCtx.roundRect(bx, by, bw, bh, 2);
        pipCtx.fill();

        // Overlay sombre pour la partie vide (du haut)
        const pct = dbToPercent(db) / 100;
        const emptyH = bh * (1 - pct);
        pipCtx.fillStyle = '#1c1c20';
        pipCtx.beginPath();
        pipCtx.roundRect(bx, by, bw, emptyH, [2, 2, 0, 0]);
        pipCtx.fill();

        // Bordure
        pipCtx.strokeStyle = '#3d3d45';
        pipCtx.lineWidth = 1;
        pipCtx.beginPath();
        pipCtx.roundRect(bx, by, bw, bh, 2);
        pipCtx.stroke();

        // Label L / R
        pipCtx.fillStyle = '#a1a1aa';
        pipCtx.font = '700 8px Inter, sans-serif';
        pipCtx.textAlign = 'center';
        pipCtx.fillText(label, bx + bw / 2, BAR_BOT + 11);
    }

    drawVuBar(barLX, dbL, 'L');
    drawVuBar(barRX, dbR, 'R');

    // ── Échelle graduée centrale ──
    const scaleX = PAD + barW + 2;
    const dbMarks = [0, -6, -12, -20, -30, -40, -60];
    pipCtx.font = '500 6px Inter, monospace';
    pipCtx.textAlign = 'center';
    dbMarks.forEach(db => {
        const pct = dbToPercent(db) / 100;
        const y = BAR_TOP + BAR_H * (1 - pct);
        // Tiret
        pipCtx.fillStyle = '#3d3d45';
        pipCtx.fillRect(scaleX, y - 0.5, SCALE_W - 2, 1);
        // Valeur
        pipCtx.fillStyle = '#71717a';
        pipCtx.fillText(db === 0 ? '0' : db, scaleX + (SCALE_W - 2) / 2, y + 3);
    });

    pipCtx.restore();
}

async function togglePip() {
    const PIP_W = 160, PIP_H = 285;

    // ── Fermeture ──
    if (state.pipActive) {
        if (window.documentPictureInPicture?.window) {
            window.documentPictureInPicture.window.close();
        } else {
            try { await document.exitPictureInPicture(); } catch (_) {}
        }
        state.pipActive = false;
        pipCtx = dom.pipCanvas.getContext('2d');
        dom.pipBtn.classList.remove('active');
        return;
    }

    // ── Document PiP (Chrome 116+) : taille de fenêtre précise ──
    if ('documentPictureInPicture' in window) {
        try {
            const pipWin = await window.documentPictureInPicture.requestWindow({
                width: PIP_W, height: PIP_H,
            });
            pipWin.document.body.style.cssText =
                'margin:0;padding:0;overflow:hidden;background:#1c1c20;';
            const cvs = pipWin.document.createElement('canvas');
            cvs.width = PIP_W; cvs.height = PIP_H;
            cvs.style.cssText = 'display:block;width:100%;height:100%;';
            pipWin.document.body.appendChild(cvs);
            pipCtx = cvs.getContext('2d');

            // Synchronise la résolution du canvas à la taille réelle de la fenêtre PiP
            pipWin.addEventListener('resize', () => {
                cvs.width  = pipWin.innerWidth;
                cvs.height = pipWin.innerHeight;
                if (!state.running) renderPip(-Infinity, -Infinity, false);
            });

            renderPip(-Infinity, -Infinity, false);
            state.pipActive = true;
            dom.pipBtn.classList.add('active');

            pipWin.addEventListener('pagehide', () => {
                state.pipActive = false;
                pipCtx = dom.pipCanvas.getContext('2d');
                dom.pipBtn.classList.remove('active');
            });
            return;
        } catch (e) {
            console.warn('Document PiP non disponible, fallback vidéo :', e);
        }
    }

    // ── Fallback : video PiP classique (canvas → captureStream) ──
    if (!document.pictureInPictureEnabled) {
        alert('Votre navigateur ne supporte pas le mode Picture-in-Picture.\nUtilisez Chrome ou Edge pour cette fonctionnalité.');
        return;
    }
    try {
        pipCtx = dom.pipCanvas.getContext('2d');
        renderPip(-Infinity, -Infinity, false);
        const stream = dom.pipCanvas.captureStream(30);
        dom.pipVideo.srcObject = stream;
        await dom.pipVideo.play();
        await dom.pipVideo.requestPictureInPicture();
        state.pipActive = true;
        dom.pipBtn.classList.add('active');
    } catch (e) {
        console.error('PiP error:', e);
        alert('Impossible d\'activer le mode Picture-in-Picture : ' + e.message);
    }
}

// Synchronise l'état PiP quand l'utilisateur ferme la fenêtre vidéo-PiP manuellement
document.addEventListener('leavepictureinpicture', () => {
    state.pipActive = false;
    pipCtx = dom.pipCanvas.getContext('2d');
    dom.pipBtn.classList.remove('active');
});

// ═══════════════════════════════════════════════
// EVENTS
// ═══════════════════════════════════════════════

// Demande d'accès initial — démarre avec le device sauvegardé si disponible
dom.requestPermBtn.addEventListener('click', () => {
    const savedId = selectedInputDeviceId && selectedInputDeviceId !== 'default'
        ? selectedInputDeviceId : null;
    startAudio(savedId);
});

// Retry après erreur
dom.retryBtn.addEventListener('click', () => {
    dom.errorOverlay.classList.remove('active');
    dom.permOverlay.classList.add('active');
});

// Bouton source audio → ouvre le panneau flottant
dom.audioSourceBtn.addEventListener('click', e => {
    e.stopPropagation();
    openInputSourcePanel(dom.audioSourceBtn);
});

// ─── Stream : ouverture modale, connexion, arrêt ───
dom.streamBtn.addEventListener('click', openStreamModal);
dom.stopStreamBtn.addEventListener('click', stopStream);
dom.streamConnectBtn.addEventListener('click', submitStream);
dom.streamCancelBtn.addEventListener('click', closeStreamModal);
dom.streamUrlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitStream(); }
    if (e.key === 'Escape') closeStreamModal();
});
// Fermeture au clic sur le fond de la modale
dom.streamModal.addEventListener('click', e => {
    if (e.target === dom.streamModal) closeStreamModal();
});

// Fermer l'overlay silence (dismissed jusqu'au prochain retour du signal)
dom.silenceDismissBtn.addEventListener('click', () => {
    silenceOverlayDismissed = true;
    dom.silenceOverlay.classList.add('hidden');
});

// Toggle activation/désactivation de la détection de silence
dom.silenceEnabled.addEventListener('change', () => {
    silenceDetectionActive = dom.silenceEnabled.checked;
    dom.silenceEnabledLabel.textContent = silenceDetectionActive ? 'Actif' : 'Désactivé';
    if (!silenceDetectionActive) {
        // Nettoie immédiatement les indicateurs
        state.silenceDetected   = false;
        silenceOverlayDismissed = false;
        state.lastSignalTime    = Date.now();
        dom.silenceIndicator.classList.remove('silent');
        dom.silenceOverlay.classList.add('hidden');
    }
});

// Reset peak
dom.resetPeakBtn.addEventListener('click', () => {
    state.peakL = -Infinity;
    state.peakR = -Infinity;
    state.peakLTimer = 0;
    state.peakRTimer = 0;
});

// Reset LUFS intégré
dom.resetLufsBtn.addEventListener('click', () => {
    state.lufsBuffer = [];
    state.lufsStartTime = Date.now();
    dom.lufsI.textContent = '–';
});

// PiP
dom.pipBtn.addEventListener('click', togglePip);

// Log — ouvre la fenêtre journal
dom.logBtn.addEventListener('click', () => {
    dom.silenceLogModal.classList.remove('hidden');
    renderLogEntries();
});

// Fermer le journal
dom.closeLogBtn.addEventListener('click', () => {
    dom.silenceLogModal.classList.add('hidden');
});

// Effacer le journal
dom.clearLogBtn.addEventListener('click', () => {
    silenceLog.length = 0;
    renderLogEntries();
});

// Fermeture au clic sur le fond
dom.silenceLogModal.addEventListener('click', e => {
    if (e.target === dom.silenceLogModal) dom.silenceLogModal.classList.add('hidden');
});

// ═══════════════════════════════════════════════
// VÉRIFICATION DU SUPPORT WEB AUDIO API
// ═══════════════════════════════════════════════
(function init() {
    if (!window.AudioContext && !window.webkitAudioContext) {
        dom.permOverlay.classList.remove('active');
        showError(
            'Navigateur non supporté',
            'La Web Audio API n\'est pas disponible dans votre navigateur. Veuillez utiliser Chrome, Firefox ou Edge dans leur dernière version.'
        );
        return;
    }

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        dom.permOverlay.classList.remove('active');
        showError(
            'Fonctionnalité indisponible',
            'L\'accès aux périphériques audio n\'est pas supporté par ce navigateur ou ce contexte. Assurez-vous d\'utiliser HTTPS.'
        );
        return;
    }

    // Restaure le label sauvegardé dès le démarrage
    updateSourceBtnLabel();

    // Si la permission micro est déjà accordée, démarre directement sans overlay
    const savedId = selectedInputDeviceId && selectedInputDeviceId !== 'default'
        ? selectedInputDeviceId : null;

    if (navigator.permissions) {
        navigator.permissions.query({ name: 'microphone' }).then(result => {
            if (result.state === 'granted') {
                showApp();
                startAudio(savedId);
            }
        }).catch(() => {
            // Permissions API non dispo → comportement normal (overlay visible)
        });
    }

    // Si la permission avait déjà été accordée (session précédente),
    // on peut affiner le label sauvegardé sans demander à nouveau.
    navigator.mediaDevices.enumerateDevices().then(devices => {
        const labeled = devices.filter(d => d.kind === 'audioinput' && d.label !== '');
        if (labeled.length > 0 && !selectedInputLabel) {
            const saved = labeled.find(d => d.deviceId === selectedInputDeviceId)
                       || labeled[0];
            if (saved) {
                selectedInputLabel = saved.label;
                selectedInputDeviceId = saved.deviceId;
                updateSourceBtnLabel();
            }
        }
    }).catch(() => {});

    // Rafraîchit le panneau si des périphériques sont branchés/débranchés
    navigator.mediaDevices.addEventListener('devicechange', () => {
        const panel = document.getElementById('audioInputPanel');
        if (panel) {
            panel.remove();
            openInputSourcePanel(dom.audioSourceBtn);
        }
        // Si le flux tourne, met aussi à jour le label
        if (state.running) {
            const track = state.stream?.getAudioTracks()[0];
            const activeId = track?.getSettings().deviceId;
            navigator.mediaDevices.enumerateDevices().then(devices => {
                const dev = devices.find(d => d.deviceId === activeId);
                if (dev?.label) { selectedInputLabel = dev.label; updateSourceBtnLabel(); }
            }).catch(() => {});
        }
    });

    // L'overlay de permission est déjà actif par défaut (cf HTML)
})();
