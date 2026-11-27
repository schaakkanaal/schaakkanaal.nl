import { Chessboard, COLOR, INPUT_EVENT_TYPE, BORDER_TYPE } from "https://cdn.jsdelivr.net/npm/cm-chessboard@8.15.8/src/Chessboard.js";
import { RightClickAnnotator } from "https://cdn.jsdelivr.net/npm/cm-chessboard@8.15.8/src/extensions/right-click-annotator/RightClickAnnotator.js";
import { MARKER_TYPE, Markers } from "https://cdn.jsdelivr.net/npm/cm-chessboard@8.15.8/src/extensions/markers/Markers.js";
import { PROMOTION_DIALOG_RESULT_TYPE, PromotionDialog } from "https://cdn.jsdelivr.net/npm/cm-chessboard@8.15.8/src/extensions/promotion-dialog/PromotionDialog.js";
import { Chess } from "https://cdn.jsdelivr.net/npm/chess.js@1.4.0/dist/esm/chess.js";
import { Maia3 } from "https://esm.sh/maia3-js@0.2.0/web";

const el = document.getElementById("board");
const wrap = document.getElementById("board-wrap");
const status = document.getElementById("status");
const assetsUrl = "https://cdn.jsdelivr.net/npm/cm-chessboard@8.15.8/assets/";
const pieceIds = ["bp", "bn", "bb", "br", "bq", "bk", "wp", "wn", "wb", "wr", "wq", "wk"];
const CHECK_MARKER = { class: "marker-check-glow", slice: "markerSquare" };
// Maia-3 draait volledig in de browser van de bezoeker. Het 5M-model wordt
// pas geladen wanneer het openingsboek geen bruikbare zet meer heeft.
let MAIA_ELO = 1500;
let gameStarted = false;
let gameFinished = false;
let endSoundPlayed = false;
let botMateAnimationPlayed = false;
let botMateOverlay = null;
const startSound = new Audio(new URL("game-start.mp3", document.baseURI).href);
const endSound = new Audio(new URL("game-end.mp3", document.baseURI).href);
const moveSound = new Audio(new URL("move.mp3", document.baseURI).href);
const captureSound = new Audio(new URL("capture.mp3", document.baseURI).href);
const checkSound = new Audio(new URL("check.mp3", document.baseURI).href);
const castleSound = new Audio(new URL("castle.mp3", document.baseURI).href);
startSound.preload = "auto";
endSound.preload = "auto";
for (const sound of [moveSound, captureSound, checkSound, castleSound]) sound.preload = "auto";
function playSound(audio) {
    try { audio.currentTime = 0; const result = audio.play(); if (result?.catch) result.catch(() => {}); }
    catch (error) { console.warn("Geluid kon niet worden afgespeeld:", error); }
}

function playMoveSound(move) {
    if (chess.isCheck()) playSound(checkSound);
    else if (move?.flags?.includes("k") || move?.flags?.includes("q")) playSound(castleSound);
    else if (move?.captured) playSound(captureSound);
    else playSound(moveSound);
}

// Speel deze animatie uitsluitend af wanneer DimitriBot schaakmat is gezet.
// chess.turn() is na mat de kleur die mat staat; dat is niet de kleur van de speler.
function showBotMateAnimation() {
    if (botMateAnimationPlayed) return;
    botMateAnimationPlayed = true;

    if (!botMateOverlay) {
        const previousPosition = getComputedStyle(wrap).position;
        if (previousPosition === "static") wrap.style.position = "relative";

        botMateOverlay = document.createElement("div");
        botMateOverlay.setAttribute("role", "dialog");
        botMateOverlay.setAttribute("aria-label", "DimitriBot is schaakmat gezet");
        Object.assign(botMateOverlay.style, {
            position: "absolute",
            inset: "0",
            zIndex: "100",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "12px",
            boxSizing: "border-box",
            background: "rgba(0, 0, 0, 0.82)",
            borderRadius: "inherit",
            cursor: "pointer"
        });

        const video = document.createElement("video");
        video.src = new URL("Dimitri RLE.webm", document.baseURI).href;
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.preload = "auto";
        video.loop = false;
        Object.assign(video.style, {
            display: "block",
            maxWidth: "100%",
            maxHeight: "100%",
            width: "100%",
            height: "100%",
            objectFit: "contain",
            pointerEvents: "none"
        });

        botMateOverlay.appendChild(video);
        wrap.appendChild(botMateOverlay);

        const closeAnimation = () => {
            if (botMateOverlay) { botMateOverlay.hidden = true; botMateOverlay.style.display = "none"; }
            video.pause();
        };
        botMateOverlay.addEventListener("click", closeAnimation);
        video.addEventListener("ended", closeAnimation);
        video.addEventListener("error", () => {
            console.warn("DimitriBot-matanimatie kon niet worden geladen:", video.src);
            closeAnimation();
        });
    }

    botMateOverlay.hidden = false;
    botMateOverlay.style.display = "flex";
    const video = botMateOverlay.querySelector("video");
    video.currentTime = 0;
    const playback = video.play();
    if (playback?.catch) playback.catch(error => {
        console.warn("DimitriBot-matanimatie kon niet automatisch starten:", error);
        botMateOverlay.hidden = true;
        botMateOverlay.style.display = "none";
    });
}
let maia = null;
let maiaLoadPromise = null;

async function getMaia() {
    if (maia?.isLoaded()) return maia;
    if (!maiaLoadPromise) {
        maia = new Maia3({
            variant: "5m",
            temperature: 0.8,
            topK: 5,
            onProgress: (loaded, total) => {
                if (total > 0) status.textContent = `Maia laden… ${Math.round(loaded / total * 100)}%`;
            }
        });
        maiaLoadPromise = maia.load().then(() => {
            console.info("DimitriBot: Maia-3 5M geladen");
            return maia;
        }).catch(error => {
            maia = null;
            maiaLoadPromise = null;
            throw error;
        });
    }
    return maiaLoadPromise;
}

// chess.js blijft de enige bron voor de spelstelling en zetgeschiedenis.
const chess = new Chess();
let board;
let orientation = COLOR.white;
let theme = "classic-wood";
let pieces = "cburnett";
let coordinateMode = "outside";
let pieceLoadNumber = 0;
let playerColor = "w";
let botThinking = false;
let botRequestId = 0;
let pendingHumanMove = null;

// Test 99: het persoonlijke openingsboek wordt in de browser geladen,
// net als in de bewezen oude DimitriBot. Een fout bij het laden blokkeert Maia niet.
let openingBook = {};
const openingBookReady = fetch(new URL("openingbook.json", document.baseURI), { cache: "no-store" })
    .then(response => {
        if (!response.ok) throw new Error(`Openingboek HTTP ${response.status}`);
        return response.json();
    })
    .then(data => {
        openingBook = data && typeof data === "object" ? data : {};
        console.info("DimitriBot: openingsboek geladen", Object.keys(openingBook).length, "stellingen");
    })
    .catch(error => {
        openingBook = {};
        console.warn("DimitriBot: openingsboek kon niet worden geladen; Maia wordt gebruikt", error);
    });

function chooseOpeningBookMove() {
    // De oude generator gebruikt alleen de stukplaatsing als sleutel.
    const positionKey = chess.fen().split(" ")[0];
    const storedMoves = openingBook[positionKey];
    if (!storedMoves || typeof storedMoves !== "object") return null;

    // Filter SAN-zetten tegen de actuele legale zettenlijst. Dit vangt ook
    // mogelijke sleutelbotsingen op doordat de boek-FEN geen beurt/rokaderechten bevat.
    const legalSanMoves = new Set(chess.moves());
    const candidates = [];
    let totalWeight = 0;
    for (const [san, rawWeight] of Object.entries(storedMoves)) {
        const weight = Number(rawWeight);
        if (legalSanMoves.has(san) && Number.isFinite(weight) && weight > 0) {
            candidates.push({ san, weight });
            totalWeight += weight;
        }
    }
    if (!candidates.length || totalWeight <= 0) return null;

    let roll = Math.random() * totalWeight;
    for (const candidate of candidates) {
        roll -= candidate.weight;
        if (roll < 0) return candidate.san;
    }
    return candidates[candidates.length - 1].san;
}

function isGameOver() {
    return chess.isGameOver();
}

function updateStatus() {
    if (chess.isCheckmate()) {
        status.textContent = `Schaakmat – ${chess.turn() === "w" ? "Zwart" : "Wit"} wint`;
    } else if (chess.isStalemate()) {
        status.textContent = "Patstelling – remise";
    } else if (chess.isThreefoldRepetition()) {
        status.textContent = "Drievoudige herhaling – remise mogelijk";
    } else if (chess.isInsufficientMaterial()) {
        status.textContent = "Onvoldoende materiaal – remise";
    } else if (chess.isDraw()) {
        status.textContent = "Remise";
    } else {
        const side = chess.turn() === "w" ? "Wit" : "Zwart";
        status.textContent = chess.isCheck() ? `Schaak – ${side} aan zet` : `${side} aan zet`;
    }
}

function updateGameStatus() {
    refreshGamePanel();
    if (!gameStarted) {
        status.textContent = "Kies een tegenstander en start een partij";
        return;
    }
    if (isGameOver() || gameFinished) {
        if (chess.isGameOver() && !gameFinished) chess.header("Result", getPgnResult());
        if (!endSoundPlayed) { playSound(endSound); endSoundPlayed = true; }
        if (chess.isCheckmate() && chess.turn() !== playerColor) {
            showBotMateAnimation();
        }
        updateStatus();
    } else if (botThinking) {
        status.textContent = "DimitriBot denkt na…";
    } else if (chess.turn() !== playerColor) {
        status.textContent = "DimitriBot is aan zet";
    } else {
        status.textContent = `Jij bent aan zet (${playerColor === "w" ? "wit" : "zwart"})`;
    }
}

function getPgnResult() {
    if (gameFinished) return chess.header().Result || "*";
    if (chess.isCheckmate()) return chess.turn() === "w" ? "0-1" : "1-0";
    if (chess.isDraw()) return "1/2-1/2";
    return "*";
}

function refreshGamePanel() {
    const panel = document.getElementById("game-panel");
    if (!panel) return;
    const active = gameStarted;
    panel.hidden = !active;
    document.getElementById("bot-gallery").hidden = active || !document.getElementById("bot-options").hidden;
    document.getElementById("bot-options").hidden = active || document.getElementById("bot-options").hidden;
    if (!active) return;

    const finished = gameFinished || chess.isGameOver();
    const state = document.getElementById("game-state");
    state.textContent = finished ? "Partij beëindigd" : (botThinking ? "DimitriBot denkt na…" : "Partij bezig");
    state.classList.toggle("finished", finished);
    document.getElementById("resignBtn").disabled = finished;
    document.getElementById("restartBtn").disabled = false;

    const moves = chess.history();
    const pgn = chess.pgn({ maxWidth: 38, newline: "\n" });
    document.getElementById("pgn-display").textContent = pgn || "De zetten verschijnen hier automatisch…";
    document.getElementById("pgn-move-count").textContent = `${moves.length} ${moves.length === 1 ? "zet" : "zetten"}`;
    document.getElementById("downloadPgnBtn").disabled = !finished;
    document.getElementById("pgn-help").textContent = finished
        ? "Je kunt de volledige partij nu downloaden als PGN-bestand."
        : "De notatie wordt automatisch bijgewerkt. Downloaden kan na afloop.";
}

function setGameHeaders() {
    chess.header(
        "Event", "CommunityBots – DimitriBot",
        "Site", "https://schaakkanaal.nl",
        "Date", new Date().toISOString().slice(0, 10).replaceAll("-", "."),
        "White", playerColor === "w" ? "Speler" : "DimitriBot",
        "Black", playerColor === "b" ? "Speler" : "DimitriBot",
        "Result", "*"
    );
    chess.header(playerColor === "w" ? "BlackElo" : "WhiteElo", String(MAIA_ELO));
}

function resignGame() {
    if (!gameStarted || gameFinished || chess.isGameOver()) return;
    const result = playerColor === "w" ? "0-1" : "1-0";
    gameFinished = true;
    botRequestId++;
    botThinking = false;
    pendingHumanMove = null;
    chess.header("Result", result);
    updateGameStatus();
}

function restartGame() {
    if (!gameStarted) return;
    startGame();
}

function downloadPgn() {
    if (!gameStarted || !(gameFinished || chess.isGameOver())) return;
    const result = getPgnResult();
    chess.header("Result", result);
    const pgn = chess.pgn({ maxWidth: 80, newline: "\n" });
    const blob = new Blob([pgn + "\n"], { type: "application/x-chess-pgn;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `DimitriBot-${new Date().toISOString().slice(0, 10)}.pgn`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

function ensureCheckGlowGradient() {
    const svg = el.querySelector("svg");
    if (!svg || svg.querySelector("#checkGlowGradient")) return;
    const ns = "http://www.w3.org/2000/svg";
    let defs = svg.querySelector("defs");
    if (!defs) {
        defs = document.createElementNS(ns, "defs");
        svg.insertBefore(defs, svg.firstChild);
    }
    const gradient = document.createElementNS(ns, "radialGradient");
    gradient.setAttribute("id", "checkGlowGradient");
    gradient.setAttribute("cx", "50%");
    gradient.setAttribute("cy", "50%");
    gradient.setAttribute("r", "72%");
    [["0%", "#c92f2f", "0.42"], ["48%", "#d93636", "0.24"], ["100%", "#d93636", "0"]].forEach(([offset, color, opacity]) => {
        const stop = document.createElementNS(ns, "stop");
        stop.setAttribute("offset", offset);
        stop.setAttribute("stop-color", color);
        stop.setAttribute("stop-opacity", opacity);
        gradient.appendChild(stop);
    });
    defs.appendChild(gradient);
}

function updateCheckMarker() {
    if (!board) return;
    ensureCheckGlowGradient();
    board.removeMarkers(CHECK_MARKER);
    if (!chess.isCheck()) return;
    const checkedColor = chess.turn();
    const king = chess.board().flat().find(piece => piece && piece.type === "k" && piece.color === checkedColor);
    if (king) board.addMarker(CHECK_MARKER, king.square);
}

function syncPosition(animate = true) {
    return board.setPosition(chess.fen(), animate).then(() => {
        updateCheckMarker();
        updateGameStatus();
    });
}

function afterHumanMove() {
    updateCheckMarker();
    updateGameStatus();
    if (!isGameOver()) requestBotMove();
}

async function waitMinimumThinkTime(startTime) {
    const elapsed = Date.now() - startTime;
    const remaining = 2000 - elapsed;
    if (remaining > 0) {
        await new Promise(resolve => setTimeout(resolve, remaining));
    }
}

async function requestBotMove() {
    if (!gameStarted || botThinking || isGameOver() || chess.turn() === playerColor) return;

    const requestId = ++botRequestId;
    const thinkingStartedAt = Date.now();
    const fenAtRequest = chess.fen();
    botThinking = true;
    updateGameStatus();

    try {
        console.info("DimitriBot: openingsboek controleren", fenAtRequest);
        await openingBookReady;
        if (requestId !== botRequestId) return;
        if (chess.fen() !== fenAtRequest) throw new Error("De stelling is tijdens het wachten op het openingsboek gewijzigd.");

        const bookSan = chooseOpeningBookMove();
        if (bookSan) {
            await waitMinimumThinkTime(thinkingStartedAt);
            if (requestId !== botRequestId) return;
            const bookMove = chess.move(bookSan);
            if (bookMove) {
                playMoveSound(bookMove);
                console.info("DimitriBot: boekzet gespeeld", bookMove.san);
                await board.setPosition(chess.fen(), true);
                updateCheckMarker();
                return;
            }
            console.warn("DimitriBot: geselecteerde boekzet kon niet worden uitgevoerd; Maia neemt over", bookSan);
        }

        console.info("DimitriBot: geen bruikbare boekzet; Maia-3 aanvragen", fenAtRequest);
        status.textContent = "Maia wordt geladen…";
        const engine = await getMaia();
        if (requestId !== botRequestId) return;
        if (chess.fen() !== fenAtRequest) throw new Error("De stelling is tijdens het laden van Maia gewijzigd; zet niet uitgevoerd.");

        // Geef Maia de volledige partijgeschiedenis mee. Zo kan het model
        // gebruikmaken van de zetten die tot deze stelling hebben geleid.
        const priorMoves = chess.history({ verbose: true }).map(move =>
            move.from + move.to + (move.promotion || "")
        );
        const result = await engine.predict({
            fen: fenAtRequest,
            selfElo: MAIA_ELO,
            priorMoves
        });

        await waitMinimumThinkTime(thinkingStartedAt);
        if (requestId !== botRequestId) return;
        if (chess.fen() !== fenAtRequest) throw new Error("De stelling is tijdens het denken gewijzigd; zet niet uitgevoerd.");

        const uci = result?.bestMove;
        if (typeof uci !== "string" || !/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(uci)) {
            throw new Error(`Maia gaf geen geldige zet terug: ${String(uci)}`);
        }

        const engineMove = chess.move({
            from: uci.slice(0, 2),
            to: uci.slice(2, 4),
            ...(uci.length === 5 ? { promotion: uci[4] } : {})
        });
        if (!engineMove) throw new Error(`Maia gaf een ongeldige zet: ${uci}`);
        playMoveSound(engineMove);

        await board.setPosition(chess.fen(), true);
        updateCheckMarker();
        console.info("DimitriBot: Maia-zet uitgevoerd", engineMove.san, result);
    } catch (error) {
        if (requestId === botRequestId) {
            console.error("DimitriBot Maia-fout:", error);
            status.textContent = `Maia-fout: ${error.message}`;
        }
    } finally {
        if (requestId === botRequestId) {
            botThinking = false;
            updateGameStatus();
        }
    }
}

function handlePromotion(event) {
    const promotions = chess.moves({ square: event.squareFrom, verbose: true })
        .filter(move => move.to === event.squareTo && move.promotion);
    if (!promotions.length) return false;

    const movingColor = chess.turn() === "w" ? COLOR.white : COLOR.black;
    event.chessboard.showPromotionDialog(event.squareTo, movingColor, result => {
        if (result.type === PROMOTION_DIALOG_RESULT_TYPE.pieceSelected) {
            const promotion = result.piece.charAt(1);
            const move = chess.move({ from: event.squareFrom, to: event.squareTo, promotion });
            if (move) { playMoveSound(move); syncPosition(true).then(afterHumanMove); }
        } else {
            event.chessboard.setPosition(chess.fen(), true);
            updateCheckMarker();
            updateGameStatus();
        }
    });
    return true;
}

function inputHandler(event) {
    if (!gameStarted) return false;
    // De engine krijgt exclusief de beurt; invoer van de speler wordt dan geweigerd.
    if (botThinking || chess.turn() !== playerColor || isGameOver()) return false;
    if (event.type === INPUT_EVENT_TYPE.movingOverSquare) return;

    if (event.type !== INPUT_EVENT_TYPE.moveInputFinished) {
        event.chessboard.removeLegalMovesMarkers?.();
    }

    if (event.type === INPUT_EVENT_TYPE.moveInputStarted) {
        const legalMoves = chess.moves({ square: event.squareFrom, verbose: true });
        event.chessboard.addLegalMovesMarkers?.(legalMoves);

        // Test 97: verwijder alleen de automatische bevel-markers
        // (de hoekmarkeringen op bezette slagvelden). Gebruik de exacte
        // type-objecten uit getMarkers(), zodat de Markers-API ze herkent.
        requestAnimationFrame(() => {
            if (!board) return;
            const currentMarkers = board.getMarkers?.() || [];
            for (const marker of currentMarkers) {
                if (marker.type?.class === "marker-bevel") {
                    board.removeMarkers(marker.type, marker.square);
                }
            }
        });

        return legalMoves.length > 0;
    }

    if (event.type === INPUT_EVENT_TYPE.validateMoveInput) {
        const candidates = chess.moves({ square: event.squareFrom, verbose: true })
            .filter(move => move.to === event.squareTo);
        if (!candidates.length) return false;
        if (candidates.some(move => move.promotion)) return handlePromotion(event);

        // Belangrijk: de spelstand wordt pas bijgewerkt bij moveInputFinished.
        // Zo wachten we niet op de interne moveInputProcess-promise van het bord.
        pendingHumanMove = { from: event.squareFrom, to: event.squareTo };
        return true;
    }

    if (event.type === INPUT_EVENT_TYPE.moveInputFinished) {
        const moveData = pendingHumanMove;
        pendingHumanMove = null;
        if (event.legalMove && moveData) {
            const move = chess.move(moveData);
            if (move) {
                playMoveSound(move);
                syncPosition(true).then(afterHumanMove).catch(error => {
                    console.error("Bord synchroniseren mislukt:", error);
                    status.textContent = `Bordfout: ${error.message}`;
                });
            }
        }
        return false;
    }
    return false;
}

function build() {
    if (board) board.destroy();
    board = new Chessboard(el, {
        position: chess.fen(),
        orientation,
        assetsUrl,
        assetsCache: true,
        style: {
            aspectRatio: 1,
            showCoordinates: coordinateMode !== "off",
            borderType: BORDER_TYPE.frame,
            pieces: { file: new URL(`pieces/${pieces}.svg`, document.baseURI).href }
        },
        extensions: [
            { class: Markers },
            { class: RightClickAnnotator },
            { class: PromotionDialog }
        ]
    });
    board.enableMoveInput(inputHandler);
    applyTheme();
    requestAnimationFrame(() => board?.resize());
    updateCheckMarker();
    updateGameStatus();
}

function applyTheme() {
    wrap.classList.remove("theme-classic-wood", "theme-tournament", "theme-anthracite", "theme-ocean", "theme-lavender", "theme-minimalist", "theme-mahogany", "theme-night");
    wrap.classList.add(`theme-${theme}`);
}

async function switchPieceSet(nextSet) {
    const requestNumber = ++pieceLoadNumber;
    const spriteUrl = new URL(`pieces/${nextSet}.svg`, document.baseURI).href;
    status.textContent = `${nextSet} wordt geladen…`;
    try {
        const response = await fetch(spriteUrl, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const svgText = await response.text();
        const parsed = new DOMParser().parseFromString(svgText, "image/svg+xml");
        if (parsed.querySelector("parsererror")) throw new Error("Het SVG-bestand is ongeldig.");
        const missing = pieceIds.filter(id => !parsed.getElementById(id));
        if (missing.length) throw new Error("Ontbrekende stukken: " + missing.join(", "));
        if (requestNumber !== pieceLoadNumber) return;
        const spriteCache = document.getElementById("cm-chessboard-sprite");
        if (!spriteCache) throw new Error("De interne sprite-cache is niet gevonden.");
        spriteCache.innerHTML = svgText;
        board.props.style.pieces.file = spriteUrl;
        board.view.redrawPieces();
        pieces = nextSet;
        updateGameStatus();
    } catch (error) {
        if (requestNumber !== pieceLoadNumber) return;
        status.textContent = `Wisselen mislukt: ${error.message}`;
        document.getElementById("pieceSet").value = pieces;
        console.error("DimitriBot stukset:", error);
    }
}

function startGame() {
    botRequestId++;
    botThinking = false;
    pendingHumanMove = null;
    playerColor = document.getElementById("playerColor").value;
    MAIA_ELO = Number(document.getElementById("botStrength").value) || 1500;
    orientation = playerColor === "w" ? COLOR.white : COLOR.black;
    endSoundPlayed = false;
    gameFinished = false;
    botMateAnimationPlayed = false;
    if (botMateOverlay) { botMateOverlay.hidden = true; botMateOverlay.style.display = "none"; }
    gameStarted = true;
    chess.reset();
    setGameHeaders();
    document.getElementById("bot-gallery").hidden = true;
    document.getElementById("bot-options").hidden = true;
    document.getElementById("game-panel").hidden = false;
    build();
    playSound(startSound);
    if (playerColor === "b") requestBotMove();
}

function returnToBotGallery() {
    document.getElementById("bot-options").hidden = true;
    document.getElementById("bot-gallery").hidden = false;
    status.textContent = "Kies een tegenstander";
}

function resetToStartingPosition() {
    botRequestId++;
    botThinking = false;
    pendingHumanMove = null;
    gameStarted = false;
    gameFinished = false;
    endSoundPlayed = false;
    botMateAnimationPlayed = false;
    if (botMateOverlay) { botMateOverlay.hidden = true; botMateOverlay.style.display = "none"; }
    chess.reset();
    orientation = COLOR.white;
    build();
    status.textContent = "Kies een tegenstander en start een partij";
}

build();
status.textContent = "Kies een tegenstander en start een partij";
refreshGamePanel();

document.getElementById("dimitriBotCard").addEventListener("click", () => {
    document.getElementById("bot-gallery").hidden = true;
    document.getElementById("bot-options").hidden = false;
    status.textContent = "DimitriBot geselecteerd – stel je partij in";
});
document.getElementById("backToBotsBtn").addEventListener("click", returnToBotGallery);
document.getElementById("startGameBtn").addEventListener("click", startGame);
document.getElementById("resignBtn").addEventListener("click", resignGame);
document.getElementById("restartBtn").addEventListener("click", restartGame);
document.getElementById("downloadPgnBtn").addEventListener("click", downloadPgn);
document.getElementById("flipBtn").addEventListener("click", () => {
    orientation = orientation === COLOR.white ? COLOR.black : COLOR.white;
    board.setOrientation(orientation);
});
document.getElementById("theme").addEventListener("change", event => {
    theme = event.target.value;
    applyTheme();
});
document.getElementById("pieceSet").addEventListener("change", event => switchPieceSet(event.target.value));
document.getElementById("coordinateMode").addEventListener("change", event => {
    coordinateMode = event.target.value;
    build();
});
document.getElementById("showEvaluation").addEventListener("change", event => {
    const note = document.getElementById("evaluationNote");
    if (note) note.hidden = !event.target.checked;
});
document.getElementById("boardSettingsToggle").addEventListener("click", () => {
    const panel = document.getElementById("boardSettingsPopover");
    const isOpen = !panel.hidden;
    panel.hidden = isOpen;
    document.getElementById("boardSettingsToggle").setAttribute("aria-expanded", String(!isOpen));
});
document.addEventListener("click", event => {
    const popover = document.getElementById("boardSettingsPopover");
    const toggle = document.getElementById("boardSettingsToggle");
    if (!popover.hidden && !popover.contains(event.target) && !toggle.contains(event.target)) {
        popover.hidden = true;
        toggle.setAttribute("aria-expanded", "false");
    }
});

// Annotaties: herstel de bediening uit Test 81.
// Rechtermuisknop kort klikken = cirkel; slepen = pijl (RightClickAnnotator).
// Linkermuisknop op het bord = alle annotaties wissen.
let rightPress = null;
el.addEventListener("contextmenu", event => event.preventDefault());
el.addEventListener("mousedown", event => {
    if (event.button !== 2) return;
    const squareElement = event.target.closest?.("[data-square]");
    const square = squareElement?.getAttribute("data-square");
    rightPress = square ? { x: event.clientX, y: event.clientY, square } : null;
});
el.addEventListener("mouseup", event => {
    if (event.button !== 2 || !rightPress) return;
    const press = rightPress;
    rightPress = null;
    const distance = Math.hypot(event.clientX - press.x, event.clientY - press.y);
    const releaseSquare = event.target.closest?.("[data-square]")?.getAttribute("data-square");
    if (distance > 5 || releaseSquare !== press.square) return;

    const existing = board.getMarkers(MARKER_TYPE.square, press.square);
    if (existing.length) board.removeMarkers(MARKER_TYPE.square, press.square);
    else board.addMarker(MARKER_TYPE.square, press.square);
});
el.addEventListener("click", event => {
    if (event.button === 0) {
        board.removeArrows();
        board.removeMarkers();
        updateCheckMarker();
        // Bewust geen status-update: annotaties wissen mag de enginebeurt niet wijzigen.
    }
});

const resizeObserver = new ResizeObserver(() => board?.resize());
resizeObserver.observe(wrap);
window.addEventListener("resize", () => board?.resize());

// Schaakbord vergroten en verkleinen met het handvat.
const resizeHandle = document.getElementById("board-resize-handle");

if (resizeHandle) {
    let startX = 0;
    let startWidth = 0;

    resizeHandle.addEventListener("pointerdown", event => {
        event.preventDefault();

        startX = event.clientX;
        startWidth = wrap.getBoundingClientRect().width;

        resizeHandle.setPointerCapture(event.pointerId);
    });

    resizeHandle.addEventListener("pointermove", event => {
        if (!resizeHandle.hasPointerCapture(event.pointerId)) return;

        const difference = event.clientX - startX;
        const availableWidth = wrap.parentElement.clientWidth;

        const newSize = Math.max(
            240,
            Math.min(startWidth + difference, availableWidth)
        );

        wrap.style.width = `${newSize}px`;
        wrap.style.height = `${newSize}px`;

        board?.resize();
    });

    resizeHandle.addEventListener("pointerup", event => {
        if (resizeHandle.hasPointerCapture(event.pointerId)) {
            resizeHandle.releasePointerCapture(event.pointerId);
        }
    });
}