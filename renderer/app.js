const $ = (id) => document.getElementById(id);

const folderLabel = $("folderLabel");
const remainingLabel = $("remainingLabel");
const pickedMeta = $("pickedMeta");
const revealBody = $("revealBody");
const pickedList = $("pickedList");
const hint = $("hint");

const btnPickFolder = $("btnPickFolder");
const btnCards = $("btnCards");
const btnSpin = $("btnSpin");
const btnBall = $("btnBall");
const btnReset = $("btnReset");

const drum = $("drum");
const drumHatch = $("drumHatch");
const drumBumps = $("drumBumps");
const drumPool = $("drumPool");
const chuteSlot = $("chuteSlot");
const stageEl = document.querySelector(".stage");
const isElectron = Boolean(window.bomboAPI?.selectFolder);
const webBlobUrlByFile = new WeakMap();

let allFiles = [];
let bag = [];          // shuffled remaining
let lastPicked = null;
let pickedHistory = [];
let spinning = false;

let physicsBalls = [];
let drumPegs = [];
let rafId = null;
let lastFrameTime = 0;
let spinPromise = null;
let extracting = false;
let loadingFolderAnimation = false;
let spinIntensity = 0;
let pixiDrum = null;
let stageSplitInstance = null;

// ─── Persistencia de partida ─────────────────────────────────────────────────
const SAVE_KEY = "bingo-game-state";

function saveGameState() {
  if (!allFiles.length) return;
  try {
    const base = {
      dir: folderLabel.textContent,
      bagNames: bag.map(getFileName),
      pickedNames: pickedHistory.map(getFileName),
      lastPickedName: lastPicked ? getFileName(lastPicked) : null,
    };
    const extra = isElectron
      ? { allFiles, bag, pickedHistory, lastPicked }
      : { allFileNames: allFiles.map(getFileName) };
    localStorage.setItem(SAVE_KEY, JSON.stringify({ ...base, ...extra }));
  } catch {}
}

function clearGameState() {
  try { localStorage.removeItem(SAVE_KEY); } catch {}
}

function loadSavedState() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || "null"); } catch { return null; }
}

// Intenta restaurar estado guardado en la selección de carpeta.
// Devuelve true si se restauró con éxito (modifica bag, pickedHistory, lastPicked).
function tryMatchSavedState(saved, dir, files) {
  if (!saved || saved.dir !== dir) return false;
  try {
    if (isElectron) {
      const fileSet = new Set(files);
      const restoredBag = (saved.bag || []).filter(f => fileSet.has(f));
      const restoredHistory = (saved.pickedHistory || []).filter(f => fileSet.has(f));
      if (restoredBag.length + restoredHistory.length === 0) return false;
      bag = restoredBag;
      pickedHistory = restoredHistory;
      lastPicked = saved.lastPicked && fileSet.has(saved.lastPicked) ? saved.lastPicked : null;
    } else {
      const nameToFile = new Map(files.map(f => [getFileName(f), f]));
      const restoredBag = (saved.bagNames || []).map(n => nameToFile.get(n)).filter(Boolean);
      const restoredHistory = (saved.pickedNames || []).map(n => nameToFile.get(n)).filter(Boolean);
      if (restoredBag.length + restoredHistory.length === 0) return false;
      bag = restoredBag;
      pickedHistory = restoredHistory;
      lastPicked = saved.lastPickedName ? (nameToFile.get(saved.lastPickedName) || null) : null;
    }
    return true;
  } catch { return false; }
}

// Auto-restaura la partida en Electron (rutas disponibles sin re-seleccionar carpeta).
async function tryRestoreElectronState() {
  if (!isElectron) return;
  const saved = loadSavedState();
  if (!saved?.allFiles?.length) return;

  allFiles = saved.allFiles;
  folderLabel.textContent = saved.dir || "—";
  const fileSet = new Set(allFiles);
  bag = (saved.bag || []).filter(f => fileSet.has(f));
  pickedHistory = (saved.pickedHistory || []).filter(f => fileSet.has(f));
  lastPicked = saved.lastPicked && fileSet.has(saved.lastPicked) ? saved.lastPicked : null;

  if (!bag.length && !pickedHistory.length) return;

  remainingLabel.textContent = String(bag.length);
  loadingFolderAnimation = true;
  setButtonsEnabled(false);
  hint.textContent = "Restaurando partida guardada…";

  renderDrumBumps();
  ensurePhysicsLoop();
  clearChuteBall();
  physicsBalls = [];

  const engine = ensurePixiMatterDrum();
  if (engine) engine.clearBalls();
  else if (drumPool) drumPool.innerHTML = "";

  await animateFolderIntoDrum(bag);

  const engineAfterLoad = ensurePixiMatterDrum();
  if (!engineAfterLoad || engineAfterLoad.getBallCount() === 0) renderDrumPool();

  loadingFolderAnimation = false;
  setButtonsEnabled(true);
  if (pickedHistory.length) renderPickedHistory();
  hint.textContent = `Partida restaurada · ${bag.length} imagen(es) restante(s).`;
}
// ─────────────────────────────────────────────────────────────────────────────

const USE_PIXI_MATTER = Boolean(window.PIXI && window.Matter && window.PixiMatterDrum);

let drumRotationDeg = 0;
let drumAngularVelocity = 0;
let drumMotionMode = "idle"; // idle | spinning | stabilizing
let settleResolver = null;

const SPIN_DURATION_MS = 5000;
const DRUM_SPIN_SPEED_DPS = 220;
const MAX_VISIBLE_BALLS = 120;
const FOLDER_LOAD_MAX_SHOTS = 160;

const PHYSICS = {
  gravity: 690,
  airDamping: 0.997,
  wallBounce: 0.8,
  collisionBounce: 0.9,
  spinForce: 190,
  spinCenterPull: 95,
  pegBounce: 0.86,
  pegSlide: 150,
  pegPushout: 1.1,
  pegColliderShrink: 1.6,
  antiJamInward: 240,
  antiJamTangential: 210,
  idleJitter: 24
};

function setButtonsEnabled(ready) {
  const disabled = !ready || extracting || loadingFolderAnimation;
  btnSpin.disabled = disabled;
  btnBall.disabled = disabled;
  btnReset.disabled = disabled;
}

function setupStageSplit() {
  if (!stageEl) return;

  const shouldSplit = window.matchMedia("(min-width: 981px)").matches;

  if (!window.Split || !shouldSplit) {
    if (stageSplitInstance) {
      stageSplitInstance.destroy();
      stageSplitInstance = null;
      const machine = stageEl.querySelector(":scope > .machine");
      const reveal = stageEl.querySelector(":scope > .reveal");
      if (machine) machine.style.width = "";
      if (reveal) reveal.style.width = "";
    }
    return;
  }

  if (stageSplitInstance) return;

  let persisted = null;
  try {
    persisted = JSON.parse(localStorage.getItem("bingo-stage-split") || "null");
  } catch {
    persisted = null;
  }

  const sizes = Array.isArray(persisted) && persisted.length === 2 ? persisted : [58, 42];

  stageSplitInstance = window.Split([".stage > .machine", ".stage > .reveal"], {
    sizes,
    minSize: [560, 360],
    gutterSize: 12,
    snapOffset: 18,
    cursor: "col-resize",
    onDragEnd: (nextSizes) => {
      try {
        localStorage.setItem("bingo-stage-split", JSON.stringify(nextSizes));
      } catch {
      }
    }
  });
}

if (btnCards) {
  btnCards.hidden = isElectron;
  if (!isElectron) {
    btnCards.addEventListener("click", () => {
      window.location.href = "/cards";
    });
  }
}

setupStageSplit();

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isImageFileName(name) {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name || "");
}

function getFileName(fileRef) {
  if (typeof fileRef === "string") {
    return fileRef.split(/[\\/]/).pop() || fileRef;
  }
  return fileRef?.name || "imagen";
}

async function selectFolderWeb() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.setAttribute("webkitdirectory", "");
    input.setAttribute("directory", "");
    input.accept = "image/png,image/jpeg,image/gif,image/webp,image/bmp";
    input.style.display = "none";
    document.body.appendChild(input);

    input.addEventListener("change", () => {
      const files = Array.from(input.files || []).filter((f) => isImageFileName(f.name));
      if (!files.length) {
        input.remove();
        resolve({ canceled: true });
        return;
      }

      files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
      const firstRel = files[0]?.webkitRelativePath || "";
      const dir = firstRel.includes("/") ? firstRel.split("/")[0] : "carpeta web";
      input.remove();
      resolve({ canceled: false, dir, files });
    }, { once: true });

    input.click();
  });
}

function normalizeAngle180(deg) {
  let normalized = deg % 360;
  if (normalized > 180) normalized -= 360;
  if (normalized < -180) normalized += 360;
  return normalized;
}

function applyDrumTransform() {
  if (!drum) return;
  drum.style.transform = `rotate(${drumRotationDeg}deg)`;
}

function resetDrumMotion() {
  drumRotationDeg = 0;
  drumAngularVelocity = 0;
  drumMotionMode = "idle";
  spinIntensity = 0;
  settleResolver = null;
  spinning = false;
  applyDrumTransform();
}

function beginStabilizeDrum() {
  drumMotionMode = "stabilizing";
  hint.textContent = "Bombo frenando y alineando compuerta…";
}

function updateDrumMotion(dt) {
  if (drumMotionMode === "spinning") {
    drumAngularVelocity = DRUM_SPIN_SPEED_DPS;
    drumRotationDeg += drumAngularVelocity * dt;
    spinIntensity = 1;
    applyDrumTransform();
    return;
  }

  if (drumMotionMode === "stabilizing") {
    const error = normalizeAngle180(drumRotationDeg);
    const spring = 26;
    const damping = 9;
    const accel = -spring * error - damping * drumAngularVelocity;

    drumAngularVelocity += accel * dt;
    drumRotationDeg += drumAngularVelocity * dt;

    spinIntensity = Math.min(1, Math.max(0, Math.abs(drumAngularVelocity) / DRUM_SPIN_SPEED_DPS));
    applyDrumTransform();

    if (Math.abs(error) < 0.35 && Math.abs(drumAngularVelocity) < 2.2) {
      drumRotationDeg = 0;
      drumAngularVelocity = 0;
      drumMotionMode = "idle";
      spinIntensity = 0;
      spinning = false;
      applyDrumTransform();

      if (settleResolver) {
        const resolve = settleResolver;
        settleResolver = null;
        resolve(true);
      }
    }
    return;
  }

  spinIntensity = 0;
  drumRotationDeg = normalizeAngle180(drumRotationDeg);
  applyDrumTransform();
}

function shuffle(arr) {
  // Fisher-Yates
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function resetRoundState() {
  resetDrumMotion();
  bag = shuffle([...allFiles]);
  lastPicked = null;
  pickedHistory = [];
  remainingLabel.textContent = String(bag.length);
  pickedMeta.textContent = "—";
  revealBody.innerHTML = `
    <div class="placeholder">
      <div class="pixel-icon" aria-hidden="true"></div>
      <div class="placeholder-text"></div>
    </div>`;
  pickedList.innerHTML = "";
}

function ensurePhysicsLoop() {
  if (rafId) return;
  lastFrameTime = 0;
  rafId = requestAnimationFrame(stepPhysics);
}

function ensurePixiMatterDrum() {
  if (!USE_PIXI_MATTER || !drumPool) return null;
  if (pixiDrum?.failed) return null;
  if (!pixiDrum) {
    pixiDrum = new window.PixiMatterDrum();
    const maybePromise = pixiDrum.init(drumPool);
    if (maybePromise?.catch) {
      maybePromise.catch(() => {
        pixiDrum.failed = true;
      });
    }
  }
  return pixiDrum;
}

function resetBag() {
  resetRoundState();
  initDrumPhysics();
  hint.textContent = "";
}

function renderDrumPool() {
  if (!drumPool) return;
  const engine = ensurePixiMatterDrum();

  if (engine) {
    physicsBalls = [];
    engine.setBalls(shuffle([...bag]), fileToURL, MAX_VISIBLE_BALLS);
    setTimeout(() => {
      if (!engine.failed && engine.getBallCount() > 0) return;
      if (engine.failed) {
        renderDrumPool();
      }
    }, 320);
    return;
  }

  drumPool.innerHTML = "";

  physicsBalls = [];
  const sample = shuffle([...bag]).slice(0, Math.min(MAX_VISIBLE_BALLS, bag.length));
  const poolRect = drumPool.getBoundingClientRect();
  const w = poolRect.width;
  const h = poolRect.height;
  const centerX = w / 2;
  const centerY = h / 2;
  const limitRadius = Math.min(w, h) / 2 - 6;

  const packingTarget = sample.length > 90 ? 0.36 : 0.46;
  const usableArea = Math.PI * limitRadius * limitRadius * packingTarget;
  const avgAreaPerBall = usableArea / Math.max(sample.length, 1);
  const baseRadius = Math.max(6, Math.min(15, Math.sqrt(avgAreaPerBall / Math.PI) * 0.75));
  const radiusSpread = 0.24;

  for (const fp of sample) {
    const radius = Math.max(5.2, baseRadius * ((1 - radiusSpread) + Math.random() * (radiusSpread * 2)));
    const startAng = Math.random() * Math.PI * 2;
    const startDist = Math.random() * Math.max(limitRadius - radius, 1);
    let x = centerX + Math.cos(startAng) * startDist;
    let y = centerY + Math.sin(startAng) * startDist;

    const maxTries = 80;
    for (let tries = 0; tries < maxTries; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.random() * (limitRadius - radius);
      const tx = centerX + Math.cos(ang) * dist;
      const ty = centerY + Math.sin(ang) * dist;

      const overlapping = physicsBalls.some((b) => {
        const dx = b.x - tx;
        const dy = b.y - ty;
        return Math.hypot(dx, dy) < b.r + radius + 2;
      });

      if (!overlapping) {
        x = tx;
        y = ty;
        break;
      }
    }

    const ballEl = document.createElement("div");
    ballEl.className = "drum-ball";
    ballEl.style.width = `${radius * 2}px`;
    ballEl.style.height = `${radius * 2}px`;
    ballEl.style.setProperty("--img", `url('${fileToURL(fp)}')`);
    drumPool.appendChild(ballEl);

    physicsBalls.push({
      el: ballEl,
      file: fp,
      x,
      y,
      r: radius,
      vx: (Math.random() - 0.5) * 120,
      vy: (Math.random() - 0.5) * 120
    });
  }
}

function refillVisiblePool() {
  if (!drumPool || !bag.length) return;

  const engine = ensurePixiMatterDrum();
  if (engine) {
    engine.syncBag(bag, fileToURL, MAX_VISIBLE_BALLS);
    return;
  }

  const targetCount = Math.min(MAX_VISIBLE_BALLS, bag.length);
  if (physicsBalls.length >= targetCount) return;

  const inPool = new Set(physicsBalls.map((b) => b.file));
  const candidates = shuffle(bag.filter((fp) => !inPool.has(fp)));
  if (!candidates.length) return;

  const poolRect = drumPool.getBoundingClientRect();
  const w = poolRect.width;
  const h = poolRect.height;
  const centerX = w / 2;
  const centerY = h / 2;
  const limitRadius = Math.min(w, h) / 2 - 6;

  const remainingToSpawn = targetCount - physicsBalls.length;
  const packingTarget = targetCount > 90 ? 0.36 : 0.46;
  const usableArea = Math.PI * limitRadius * limitRadius * packingTarget;
  const avgAreaPerBall = usableArea / Math.max(targetCount, 1);
  const baseRadius = Math.max(6, Math.min(15, Math.sqrt(avgAreaPerBall / Math.PI) * 0.75));

  for (let i = 0; i < remainingToSpawn && i < candidates.length; i++) {
    const fp = candidates[i];
    const radius = Math.max(5.2, baseRadius * (0.84 + Math.random() * 0.32));
    let x = centerX;
    let y = centerY;

    for (let tries = 0; tries < 70; tries++) {
      const ang = Math.random() * Math.PI * 2;
      const dist = Math.random() * Math.max(limitRadius - radius, 1);
      const tx = centerX + Math.cos(ang) * dist;
      const ty = centerY + Math.sin(ang) * dist;

      const overlapping = physicsBalls.some((b) => {
        const dx = b.x - tx;
        const dy = b.y - ty;
        return Math.hypot(dx, dy) < b.r + radius + 2;
      });

      if (!overlapping) {
        x = tx;
        y = ty;
        break;
      }
    }

    const ballEl = document.createElement("div");
    ballEl.className = "drum-ball";
    ballEl.style.width = `${radius * 2}px`;
    ballEl.style.height = `${radius * 2}px`;
    ballEl.style.setProperty("--img", `url('${fileToURL(fp)}')`);
    drumPool.appendChild(ballEl);

    physicsBalls.push({
      el: ballEl,
      file: fp,
      x,
      y,
      r: radius,
      vx: (Math.random() - 0.5) * 80,
      vy: (Math.random() - 0.5) * 80
    });
  }
}

function animateFolderIntoDrum(files) {
  return new Promise((resolve) => {
    if (!Array.isArray(files) || !files.length || !drum || !drumPool) {
      resolve();
      return;
    }

    const shotCount = Math.min(files.length, MAX_VISIBLE_BALLS, FOLDER_LOAD_MAX_SHOTS);
    const shots = files.slice(0, shotCount);

    const drumRect = drum.getBoundingClientRect();
    const poolRect = drumPool.getBoundingClientRect();
    const entryRect = btnPickFolder.getBoundingClientRect();
    const drumCenterX = drumRect.left + drumRect.width / 2;
    const drumCenterY = drumRect.top + drumRect.height / 2;
    const endRadius = Math.min(drumRect.width, drumRect.height) * 0.26;
    const poolW = poolRect.width;
    const poolH = poolRect.height;
    const poolCenterX = poolW / 2;
    const poolCenterY = poolH / 2;
    const poolLimitRadius = Math.min(poolW, poolH) / 2 - 6;

    const packingTarget = shotCount > 90 ? 0.36 : 0.46;
    const usableArea = Math.PI * poolLimitRadius * poolLimitRadius * packingTarget;
    const avgAreaPerBall = usableArea / Math.max(shotCount, 1);
    const baseRadius = Math.max(6, Math.min(15, Math.sqrt(avgAreaPerBall / Math.PI) * 0.75));

    const layer = document.createElement("div");
    layer.className = "folder-feed-layer";
    document.body.appendChild(layer);

    const targetTotalMs = 3000;
    const duration = 420;
    const stagger = shots.length > 1
      ? Math.max(18, Math.min(220, Math.round((targetTotalMs - duration - 120) / (shots.length - 1))))
      : 0;

    shots.forEach((fp, idx) => {
      const token = document.createElement("div");
      token.className = "folder-feed-shot";
      const startX = entryRect.left + entryRect.width * (0.2 + Math.random() * 0.6);
      const startY = entryRect.top + entryRect.height * (0.2 + Math.random() * 0.6);
      const angle = Math.random() * Math.PI * 2;
      const rad = Math.random() * endRadius;
      const endX = drumCenterX + Math.cos(angle) * rad;
      const endY = drumCenterY + Math.sin(angle) * rad;
      const delay = idx * stagger;
      const startW = 96 + Math.random() * 32;
      const startH = startW * (0.72 + Math.random() * 0.12);

      token.style.setProperty("--sx", `${startX}px`);
      token.style.setProperty("--sy", `${startY}px`);
      token.style.setProperty("--tx", `${endX}px`);
      token.style.setProperty("--ty", `${endY}px`);
      token.style.setProperty("--delay", `${delay}ms`);
      token.style.setProperty("--dur", `${duration}ms`);
      token.style.setProperty("--sw", `${startW}px`);
      token.style.setProperty("--sh", `${startH}px`);
      token.style.setProperty("--img", `url('${fileToURL(fp)}')`);

      layer.appendChild(token);
      token.addEventListener("animationend", () => {
        if (!drumPool) return;

        const engine = ensurePixiMatterDrum();
        if (!engine && physicsBalls.length >= shotCount) return;

        const radius = Math.max(5.2, baseRadius * (0.84 + Math.random() * 0.32));
        let localX = endX - poolRect.left;
        let localY = endY - poolRect.top;

        const dx = localX - poolCenterX;
        const dy = localY - poolCenterY;
        const dist = Math.hypot(dx, dy);
        const maxDist = Math.max(0, poolLimitRadius - radius);
        if (dist > maxDist) {
          const nx = dx / Math.max(dist, 0.001);
          const ny = dy / Math.max(dist, 0.001);
          localX = poolCenterX + nx * maxDist;
          localY = poolCenterY + ny * maxDist;
        }

        if (engine) {
          engine.addBall(fp, fileToURL, radius, MAX_VISIBLE_BALLS);
          return;
        }

        const ballEl = document.createElement("div");
        ballEl.className = "drum-ball";
        ballEl.style.width = `${radius * 2}px`;
        ballEl.style.height = `${radius * 2}px`;
        ballEl.style.setProperty("--img", `url('${fileToURL(fp)}')`);
        drumPool.appendChild(ballEl);

        physicsBalls.push({
          el: ballEl,
          file: fp,
          x: localX,
          y: localY,
          r: radius,
          vx: (Math.random() - 0.5) * 120,
          vy: (Math.random() - 0.5) * 120
        });
      }, { once: true });

      requestAnimationFrame(() => token.classList.add("go"));
    });

    const totalMs = duration + Math.max(0, shots.length - 1) * stagger + 120;
    setTimeout(() => {
      layer.remove();
      resolve();
    }, totalMs);
  });
}

function renderDrumBumps() {
  if (!drumBumps) return;
  drumBumps.innerHTML = "";
  drumPegs = [];

  const rect = drumBumps.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  const cx = w / 2;
  const cy = h / 2;
  const rimRadius = Math.min(w, h) / 2 - 10;
  const spikeCount = 26;

  for (let i = 0; i < spikeCount; i++) {
    const ang = (i / spikeCount) * Math.PI * 2;
    const baseX = cx + Math.cos(ang) * rimRadius;
    const baseY = cy + Math.sin(ang) * rimRadius;

    const pegEl = document.createElement("div");
    pegEl.className = "drum-bump";
    pegEl.style.transform = `translate(${baseX - 7}px, ${baseY - 22}px) rotate(${ang + Math.PI / 2}rad)`;
    drumBumps.appendChild(pegEl);

    const tipInset = 16;
    const px = cx + Math.cos(ang) * (rimRadius - tipInset);
    const py = cy + Math.sin(ang) * (rimRadius - tipInset);
    drumPegs.push({ x: px, y: py, r: 5.8 });
  }
}

function initDrumPhysics() {
  renderDrumBumps();
  renderDrumPool();
  if (!rafId) {
    lastFrameTime = 0;
    rafId = requestAnimationFrame(stepPhysics);
  }
}

function stepPhysics(ts) {
  if (!lastFrameTime) lastFrameTime = ts;
  const dt = Math.min((ts - lastFrameTime) / 1000, 0.033);
  lastFrameTime = ts;

  updateDrumMotion(dt);
  updatePhysics(dt);
  rafId = requestAnimationFrame(stepPhysics);
}

function updatePhysics(dt) {
  if (!drumPool) return;

  const engine = ensurePixiMatterDrum();
  if (engine) {
    engine.update(dt, spinIntensity, drumAngularVelocity, (drumRotationDeg * Math.PI) / 180);
    return;
  }

  if (!physicsBalls.length) return;

  const poolRect = drumPool.getBoundingClientRect();
  const w = poolRect.width;
  const h = poolRect.height;
  const centerX = w / 2;
  const centerY = h / 2;
  const limitRadius = Math.min(w, h) / 2 - 6;
  const drumRad = (drumRotationDeg * Math.PI) / 180;
  const gravityX = PHYSICS.gravity * Math.sin(drumRad);
  const gravityY = PHYSICS.gravity * Math.cos(drumRad);

  for (const ball of physicsBalls) {
    ball.vx += gravityX * dt;
    ball.vy += gravityY * dt;

    if (spinIntensity > 0.01) {
      const dx = ball.x - centerX;
      const dy = ball.y - centerY;
      const len = Math.max(Math.hypot(dx, dy), 0.001);
      const tx = -dy / len;
      const ty = dx / len;
      ball.vx += tx * PHYSICS.spinForce * spinIntensity * dt;
      ball.vy += ty * PHYSICS.spinForce * spinIntensity * dt;
      ball.vx -= (dx / len) * PHYSICS.spinCenterPull * spinIntensity * dt;
      ball.vy -= (dy / len) * PHYSICS.spinCenterPull * spinIntensity * dt;
      ball.vx += (Math.random() - 0.5) * 100 * spinIntensity * dt;
      ball.vy += (Math.random() - 0.5) * 100 * spinIntensity * dt;
    } else {
      ball.vx += (Math.random() - 0.5) * PHYSICS.idleJitter * dt;
      ball.vy += (Math.random() - 0.5) * PHYSICS.idleJitter * dt;
    }

    ball.vx *= PHYSICS.airDamping;
    ball.vy *= PHYSICS.airDamping;
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    const dx = ball.x - centerX;
    const dy = ball.y - centerY;
    const dist = Math.hypot(dx, dy);
    const maxDist = limitRadius - ball.r;
    if (dist > maxDist) {
      const nx = dx / Math.max(dist, 0.001);
      const ny = dy / Math.max(dist, 0.001);
      ball.x = centerX + nx * maxDist;
      ball.y = centerY + ny * maxDist;

      const dot = ball.vx * nx + ball.vy * ny;
      if (dot > 0) {
        ball.vx -= (1 + PHYSICS.wallBounce) * dot * nx;
        ball.vy -= (1 + PHYSICS.wallBounce) * dot * ny;
      }

      const speed = Math.hypot(ball.vx, ball.vy);
      if (spinIntensity > 0.2 && speed < 70) {
        ball.vx -= nx * 90 * dt;
        ball.vy -= ny * 90 * dt;
      }
    }

    let pegHitCount = 0;

    for (const peg of drumPegs) {
      const pdx = ball.x - peg.x;
      const pdy = ball.y - peg.y;
      const pdist = Math.hypot(pdx, pdy) || 0.0001;
      const effectivePegR = Math.max(2.2, peg.r - PHYSICS.pegColliderShrink);
      const minPegDist = ball.r + effectivePegR;
      if (pdist >= minPegDist) continue;

      pegHitCount += 1;

      const pnx = pdx / pdist;
      const pny = pdy / pdist;
      const overlap = minPegDist - pdist;
      ball.x += pnx * (overlap + PHYSICS.pegPushout);
      ball.y += pny * (overlap + PHYSICS.pegPushout);

      const pDot = ball.vx * pnx + ball.vy * pny;
      if (pDot < 0) {
        ball.vx -= (1 + PHYSICS.pegBounce) * pDot * pnx;
        ball.vy -= (1 + PHYSICS.pegBounce) * pDot * pny;
      }

      const rdx = ball.x - centerX;
      const rdy = ball.y - centerY;
      const rlen = Math.max(Math.hypot(rdx, rdy), 0.001);
      const tnx = -rdy / rlen;
      const tny = rdx / rlen;
      const spinDir = drumAngularVelocity >= 0 ? 1 : -1;
      const slide = PHYSICS.pegSlide * (0.35 + spinIntensity) * dt;
      ball.vx += tnx * slide * spinDir;
      ball.vy += tny * slide * spinDir;
    }

    const bdx = ball.x - centerX;
    const bdy = ball.y - centerY;
    const bdist = Math.max(Math.hypot(bdx, bdy), 0.001);
    const rimBand = limitRadius - ball.r - bdist;
    const speed = Math.hypot(ball.vx, ball.vy);
    const jammedAtRim = rimBand < 8;

    if ((pegHitCount >= 2 && jammedAtRim) || (pegHitCount >= 1 && jammedAtRim && speed < 45)) {
      const inx = -bdx / bdist;
      const iny = -bdy / bdist;
      const tx = -iny;
      const ty = inx;
      const spinDir = drumAngularVelocity >= 0 ? 1 : -1;

      ball.vx += inx * PHYSICS.antiJamInward * dt;
      ball.vy += iny * PHYSICS.antiJamInward * dt;
      ball.vx += tx * PHYSICS.antiJamTangential * spinDir * dt;
      ball.vy += ty * PHYSICS.antiJamTangential * spinDir * dt;
      ball.vx += (Math.random() - 0.5) * 70 * dt;
      ball.vy += (Math.random() - 0.5) * 70 * dt;

      const retreat = Math.min(5, Math.max(2, ball.r * 0.45));
      ball.x += inx * retreat;
      ball.y += iny * retreat;
    }
  }

  for (let i = 0; i < physicsBalls.length; i++) {
    for (let j = i + 1; j < physicsBalls.length; j++) {
      const a = physicsBalls[i];
      const b = physicsBalls[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.hypot(dx, dy) || 0.0001;
      const minDist = a.r + b.r;

      if (dist >= minDist) continue;

      const nx = dx / dist;
      const ny = dy / dist;
      const overlap = minDist - dist;
      a.x -= nx * overlap * 0.5;
      a.y -= ny * overlap * 0.5;
      b.x += nx * overlap * 0.5;
      b.y += ny * overlap * 0.5;

      const rvx = b.vx - a.vx;
      const rvy = b.vy - a.vy;
      const velAlongNormal = rvx * nx + rvy * ny;
      if (velAlongNormal > 0) continue;

      const impulse = -(1 + PHYSICS.collisionBounce) * velAlongNormal / 2;
      const ix = impulse * nx;
      const iy = impulse * ny;
      a.vx -= ix;
      a.vy -= iy;
      b.vx += ix;
      b.vy += iy;

      if (spinIntensity > 0.2) {
        const tx = -ny;
        const ty = nx;
        const jitter = (Math.random() - 0.5) * 28 * spinIntensity;
        a.vx -= tx * jitter;
        a.vy -= ty * jitter;
        b.vx += tx * jitter;
        b.vy += ty * jitter;
      }
    }
  }

  for (const ball of physicsBalls) {
    const depth = Math.max(0, Math.min(1, ball.y / h));
    const scale = 0.82 + depth * 0.36;
    ball.el.style.transform = `translate(${ball.x - ball.r}px, ${ball.y - ball.r}px) scale(${scale})`;
    ball.el.style.zIndex = String(2 + Math.round(depth * 20));
    ball.el.style.opacity = String(0.72 + depth * 0.28);
  }
}

function startSpin() {
  return startSpinFor(SPIN_DURATION_MS);
}

function startSpinFor(durationMs) {
  if (!allFiles.length) return Promise.resolve(false);
  if (extracting) return Promise.resolve(false);
  if (spinning) return spinPromise || Promise.resolve(false);

  spinning = true;
  drumMotionMode = "spinning";
  drumAngularVelocity = DRUM_SPIN_SPEED_DPS;
  settleResolver = null;
  hint.textContent = "Bombo girando…";

  spinPromise = new Promise((resolve) => {
    setTimeout(() => {
      settleResolver = (ok) => {
        spinPromise = null;
        hint.textContent = "Compuerta alineada. Listo para sacar bola.";
        resolve(ok);
      };
      beginStabilizeDrum();
    }, durationMs);
  });

  return spinPromise;
}

function openDrumHatchAndDrop(onDrop) {
  return new Promise((resolve) => {
    if (!drumHatch) {
      if (onDrop) onDrop();
      resolve();
      return;
    }

    if (window.gsap) {
      let dropped = false;
      const safeDrop = () => {
        if (dropped) return;
        dropped = true;
        if (onDrop) onDrop();
      };

      window.gsap.killTweensOf(drumHatch);
      window.gsap.set(drumHatch, {
        xPercent: -50,
        rotateX: 0,
        transformOrigin: "50% 0%"
      });

      window.gsap.timeline({
        onComplete: () => {
          resolve();
        }
      })
        .to(drumHatch, {
          duration: 0.24,
          rotateX: 72,
          ease: "power2.out",
          onComplete: safeDrop
        })
        .to(drumHatch, {
          duration: 0.38,
          rotateX: 78,
          ease: "none"
        })
        .to(drumHatch, {
          duration: 0.28,
          rotateX: 0,
          ease: "power2.inOut"
        });
      return;
    }

    drumHatch.classList.remove("open");
    void drumHatch.offsetWidth;
    drumHatch.classList.add("open");

    setTimeout(() => {
      if (onDrop) onDrop();
    }, 360);

    setTimeout(() => {
      drumHatch.classList.remove("open");
      resolve();
    }, 1200);
  });
}

function clearChuteBall() {
  chuteSlot.innerHTML = "";
}

function makeBallEl() {
  const ball = document.createElement("div");
  ball.className = "ball";
  return ball;
}

function fileToURL(fp) {
  if (typeof fp !== "string") {
    if (!webBlobUrlByFile.has(fp)) {
      webBlobUrlByFile.set(fp, URL.createObjectURL(fp));
    }
    return webBlobUrlByFile.get(fp);
  }

  let normalized = fp.replaceAll("\\", "/");
  if (!normalized.startsWith("/")) normalized = "/" + normalized;
  return "file://" + encodeURI(normalized);
}

function pickBallNearestHatch() {
  const engine = ensurePixiMatterDrum();
  if (engine) {
    return engine.pickBallNearestHatch();
  }

  if (!physicsBalls.length || !drumPool) return null;

  const poolRect = drumPool.getBoundingClientRect();
  const hatchX = poolRect.width / 2;
  const hatchY = poolRect.height - 6;

  let nearestBall = null;
  let minDistSq = Infinity;

  for (const ball of physicsBalls) {
    const dx = ball.x - hatchX;
    const dy = ball.y - hatchY;
    const distSq = dx * dx + dy * dy;
    if (distSq < minDistSq) {
      minDistSq = distSq;
      nearestBall = ball;
    }
  }

  return nearestBall || null;
}

function animateSelectedBallExit(ballObj) {
  return new Promise((resolve) => {
    if (!ballObj || !drumPool) {
      resolve();
      return;
    }

    const engine = ensurePixiMatterDrum();
    const poolRect = drumPool.getBoundingClientRect();
    const hatchRect = drumHatch?.getBoundingClientRect();
    const chuteRect = chuteSlot?.getBoundingClientRect();

    const r = Math.max(4, ballObj.r || 8);
    const localX = typeof ballObj.x === "number" ? ballObj.x : drumPool.clientWidth / 2;
    const localY = typeof ballObj.y === "number" ? ballObj.y : drumPool.clientHeight * 0.65;

    const startX = poolRect.left + localX;
    const startY = poolRect.top + localY;
    const hatchX = hatchRect ? (hatchRect.left + hatchRect.width / 2) : (poolRect.left + poolRect.width / 2);
    const hatchY = hatchRect ? (hatchRect.top + hatchRect.height * 0.78) : (poolRect.bottom + 10);
    const chuteX = chuteRect ? (chuteRect.left + 22 + r) : hatchX;
    const chuteY = chuteRect ? (chuteRect.top + 14 + r) : (hatchY + 60);

    const flight = document.createElement("div");
    flight.className = "drum-ball";
    flight.style.position = "fixed";
    flight.style.left = "0";
    flight.style.top = "0";
    flight.style.zIndex = "1300";
    flight.style.pointerEvents = "none";
    flight.style.width = `${r * 2}px`;
    flight.style.height = `${r * 2}px`;
    flight.style.setProperty("--img", `url('${fileToURL(ballObj.file)}')`);
    document.body.appendChild(flight);

    if (engine && ballObj.file) {
      engine.removeBallByFile(ballObj.file);
    }
    if (!engine && ballObj.el) {
      ballObj.el.remove();
    }

    if (window.gsap) {
      window.gsap.set(flight, {
        x: startX - r,
        y: startY - r,
        scale: 1,
        rotation: -4
      });

      window.gsap.timeline({
        onComplete: () => {
          flight.remove();
          resolve();
        }
      })
        .to(flight, {
          duration: 0.33,
          x: hatchX - r,
          y: hatchY - r,
          scale: 1.03,
          rotation: 0,
          ease: "power2.out"
        })
        .to(flight, {
          duration: 0.5,
          x: chuteX - r,
          y: chuteY - r,
          scale: 1,
          ease: "power2.in"
        });
      return;
    }

    flight.style.transform = `translate(${startX - r}px, ${startY - r}px) scale(1)`;
    flight.style.transition = "transform 360ms cubic-bezier(.2,.85,.25,1)";
    requestAnimationFrame(() => {
      flight.style.transform = `translate(${hatchX - r}px, ${hatchY - r}px) scale(1)`;
      setTimeout(() => {
        flight.style.transition = "transform 520ms cubic-bezier(.12,.62,.2,1)";
        flight.style.transform = `translate(${chuteX - r}px, ${chuteY - r}px) scale(1)`;
        setTimeout(() => {
          flight.remove();
          resolve();
        }, 540);
      }, 370);
    });
  });
}

function animateChuteBallLifecycle(ball) {
  return new Promise((resolve) => {
    if (!ball) {
      resolve();
      return;
    }

    if (!window.gsap) {
      requestAnimationFrame(() => ball.classList.add("pop"));
      setTimeout(() => ball.classList.add("opening"), 520);
      setTimeout(resolve, 1420);
      return;
    }

    window.gsap.set(ball, {
      y: -104,
      x: 0,
      scale: 0.9,
      opacity: 0,
      rotation: -8,
      transformOrigin: "50% 50%"
    });

    window.gsap.timeline({ onComplete: resolve })
      .to(ball, {
        duration: 0.42,
        y: 12,
        opacity: 1,
        scale: 1.04,
        rotation: 0,
        ease: "back.out(1.45)"
      })
      .to(ball, {
        duration: 0.16,
        y: 10,
        scale: 1,
        ease: "power2.out"
      })
      .to(ball, {
        duration: 0.52,
        y: 10,
        scale: 1,
        opacity: 1,
        ease: "none"
      })
      .to(ball, {
        duration: 0.34,
        y: 6,
        scale: 1.06,
        opacity: 0.22,
        ease: "power2.inOut"
      }, "+=0.1");
  });
}

async function drawBall() {
  if (!allFiles.length) return;
  if (!bag.length) {
    hint.textContent = "No quedan imágenes. Pulsa «Reinicio» para volver a meterlas en el bombo.";
    return;
  }

  if (spinning || extracting) return;
  extracting = true;
  setButtonsEnabled(true);

  await startSpinFor(SPIN_DURATION_MS);

  await wait(420);

  const selectedBall = pickBallNearestHatch();
  const selectedFile = selectedBall?.file || null;
  if (selectedBall && !ensurePixiMatterDrum()) {
    physicsBalls = physicsBalls.filter((b) => b !== selectedBall);
  }

  let ball = null;
  await openDrumHatchAndDrop(async () => {
    await animateSelectedBallExit(selectedBall);
    clearChuteBall();
    ball = makeBallEl();
    chuteSlot.appendChild(ball);
  });

  // pick image from the same physical ball that exited the hatch
  let picked = null;
  if (selectedFile) {
    const idx = bag.indexOf(selectedFile);
    if (idx >= 0) {
      picked = selectedFile;
      bag.splice(idx, 1);
    }
  }
  if (!picked) {
    picked = bag.pop();
  }

  refillVisiblePool();

  lastPicked = picked;

  remainingLabel.textContent = String(bag.length);

  await animateChuteBallLifecycle(ball);

  await revealPicked(picked, ball);
  pickedHistory.push(picked);
  renderPickedHistory();
  saveGameState();
  extracting = false;
  setButtonsEnabled(Boolean(allFiles.length));
  hint.textContent = bag.length
    ? "Imagen revelada. Puedes girar y sacar la siguiente."
    : "Última imagen revelada. Pulsa «Reinicio» para volver a empezar.";
}

function revealPicked(fp, sourceBallEl = null) {
  return animateBallToReveal(fp, sourceBallEl);
}

function animateBallToReveal(fp, sourceBallEl) {
  return new Promise((resolve) => {
    const sourceRect = sourceBallEl?.getBoundingClientRect() || chuteSlot.getBoundingClientRect();
    const targetRect = revealBody.getBoundingClientRect();
    const fromX = sourceRect.left + sourceRect.width / 2;
    const fromY = sourceRect.top + sourceRect.height * 0.5;
    const toX = targetRect.left + targetRect.width / 2;
    const toY = targetRect.top + Math.min(targetRect.height * 0.42, 210);

    const flight = document.createElement("div");
    flight.className = "mail-flight";
    flight.style.setProperty("--img", `url('${fileToURL(fp)}')`);
    const flap = document.createElement("div");
    flap.className = "mail-flight-flap";
    flight.appendChild(flap);

    document.body.appendChild(flight);
    if (sourceBallEl) sourceBallEl.style.opacity = "0";

    const finish = () => {
      revealPickedFinal(fp, flight).then(() => {
        flight.remove();
        resolve();
      });
    };

    if (!window.gsap) {
      flight.style.transform = `translate(${fromX - 39}px, ${fromY - 39}px)`;
      requestAnimationFrame(() => {
        flight.style.transition = "transform 620ms cubic-bezier(.2,.85,.2,1), opacity 260ms ease";
        flight.style.transform = `translate(${toX - 39}px, ${toY - 39}px)`;
        setTimeout(finish, 700);
      });
      return;
    }

    const envelopeW = Math.min(300, targetRect.width * 0.9);
    const envelopeH = 186;

    window.gsap.set(flight, {
      width: envelopeW,
      height: envelopeH,
      x: fromX - envelopeW / 2,
      y: fromY - envelopeH / 2,
      rotation: -8,
      scaleX: 78 / envelopeW,
      scaleY: 78 / envelopeH,
      opacity: 1,
      borderRadius: 39,
      transformOrigin: "50% 50%",
      force3D: true
    });

    const arcMidX = fromX + (toX - fromX) * 0.38;
    const arcMidY = Math.min(fromY, toY) - 42;

    const tl = window.gsap.timeline({ onComplete: finish });
    tl.to(flight, {
      duration: 0.56,
      x: arcMidX - envelopeW / 2,
      y: arcMidY - envelopeH / 2,
      rotation: -2,
      scaleX: (78 / envelopeW) * 1.04,
      scaleY: (78 / envelopeH) * 1.04,
      ease: "power1.out"
    });

    tl.to(flight, {
      duration: 0.66,
      x: toX - envelopeW / 2,
      y: toY - envelopeH / 2,
      rotation: 0,
      scaleX: 1,
      scaleY: 1,
      ease: "power2.inOut"
    });

    tl.add(() => flight.classList.add("envelope"), "-=0.3");

    tl.to(flight, {
      duration: 0.34,
      borderRadius: 12,
      ease: "power2.inOut"
    }, "<");

    tl.to(flap, {
      duration: 0.34,
      opacity: 0.86,
      rotationX: -65,
      ease: "power2.out"
    }, "-=0.14");

    tl.to(flight, {
      duration: 0.12,
      y: `-=${6}`,
      ease: "sine.out"
    }).to(flight, {
      duration: 0.18,
      y: `+=${6}`,
      ease: "sine.in"
    });
  });
}

function revealPickedFinal(fp, fromElement = null) {
  const url = fileToURL(fp);
  const name = getFileName(fp);

  revealBody.innerHTML = "";

  const paperWrap = document.createElement("div");
  paperWrap.className = "paper-reveal";
  if (window.gsap) {
    paperWrap.style.perspective = "none";
  }

  const paper = document.createElement("div");
  paper.className = "paper-sheet";

  const img = document.createElement("img");
  img.className = "reveal-img";
  img.alt = name;
  img.src = url;
  img.style.visibility = "visible";
  img.style.opacity = "0";

  paper.appendChild(img);
  paperWrap.appendChild(paper);
  revealBody.appendChild(paperWrap);

  return new Promise((resolve) => {
    if (!window.gsap) {
      paper.classList.add("unfolding");
      paper.addEventListener("animationend", () => {
        paper.classList.add("ready");
        setTimeout(resolve, 360);
      }, { once: true });
      return;
    }

    window.gsap.set(img, { opacity: 0, scale: 0.985 });

    if (fromElement) {
      const fromRect = fromElement.getBoundingClientRect();
      const toRect = paper.getBoundingClientRect();

      const flap = fromElement.querySelector(".mail-flight-flap");

      const dx = toRect.left - fromRect.left;
      const dy = toRect.top - fromRect.top;
      const sx = Math.max(0.01, toRect.width / Math.max(1, fromRect.width));
      const sy = Math.max(0.01, toRect.height / Math.max(1, fromRect.height));

      window.gsap.set(fromElement, {
        left: fromRect.left,
        top: fromRect.top,
        width: fromRect.width,
        height: fromRect.height,
        x: 0,
        y: 0,
        scaleX: 1,
        scaleY: 1,
        margin: 0,
        zIndex: 1310,
        borderRadius: 12,
        opacity: 1,
        rotation: 0,
        rotateX: 0,
        rotateY: 0,
        rotateZ: 0,
        skewX: 0,
        skewY: 0,
        transformOrigin: "0% 0%",
        force3D: true
      });
      window.gsap.set(paperWrap, { opacity: 1 });
      window.gsap.set(paper, {
        opacity: 0.01,
        scale: 0.985,
        x: 0,
        y: 0,
        rotation: 0,
        rotateX: 0,
        rotateY: 0,
        rotateZ: 0,
        skewX: 0,
        skewY: 0,
        transformOrigin: "50% 50%"
      });

      window.gsap.timeline({
        onComplete: () => {
          fromElement.remove();
          resolve();
        }
      })
        .to(fromElement, {
          duration: 0.72,
          x: dx,
          y: dy,
          scaleX: sx,
          scaleY: sy,
          borderRadius: 6,
          ease: "power2.inOut"
        })
        .to(paper, {
          duration: 0.42,
          opacity: 1,
          scale: 1,
          ease: "power2.out"
        }, "-=0.36")
        .to(img, {
          duration: 0.46,
          opacity: 1,
          scale: 1,
          ease: "power2.out"
        }, "-=0.34")
        .to(fromElement, {
          duration: 0.34,
          opacity: 0,
          ease: "power1.out"
        }, "-=0.3")
        .to(flap || fromElement, {
          duration: 0.22,
          opacity: 0,
          ease: "power1.out"
        }, "-=0.28");
      return;
    }

    window.gsap.set(paper, {
      opacity: 0,
      scale: 0.85,
      y: 18,
      rotation: -1.2,
      transformOrigin: "50% 50%"
    });

    window.gsap.timeline({ onComplete: resolve })
      .to(paper, {
        duration: 0.36,
        opacity: 1,
        scale: 1.01,
        y: 0,
        rotation: 0,
        ease: "power2.out"
      })
      .to(paper, {
        duration: 0.16,
        scale: 1,
        ease: "power1.out"
      })
      .to(img, {
        duration: 0.26,
        opacity: 1,
        scale: 1,
        ease: "power1.out"
      }, "-=0.05");
  });
}

function renderPickedHistory() {
  pickedList.innerHTML = "";

  const recent = [...pickedHistory].reverse();
  for (const fp of recent) {
    const thumb = document.createElement("img");
    thumb.className = "picked-thumb";
    thumb.src = fileToURL(fp);
    thumb.alt = getFileName(fp);
    pickedList.appendChild(thumb);
  }
}

btnPickFolder.addEventListener("click", async () => {
  const res = isElectron
    ? await window.bomboAPI.selectFolder()
    : await selectFolderWeb();
  if (res?.canceled) return;

  allFiles = Array.isArray(res.files) ? res.files : [];
  folderLabel.textContent = res.dir || "—";

  if (!allFiles.length) {
    setButtonsEnabled(false);
    remainingLabel.textContent = "0";
    hint.textContent = "La carpeta no tiene imágenes compatibles (png/jpg/gif/webp/bmp).";
    return;
  }

  const saved = loadSavedState();
  const isRestoring = tryMatchSavedState(saved, res.dir || "—", allFiles);

  loadingFolderAnimation = true;
  setButtonsEnabled(false);

  if (!isRestoring) {
    hint.textContent = "Cargando imágenes al bombo…";
    resetRoundState();
  } else {
    hint.textContent = "Restaurando partida guardada…";
    remainingLabel.textContent = String(bag.length);
    pickedMeta.textContent = pickedHistory.length ? `${pickedHistory.length} / ${allFiles.length}` : "—";
  }

  renderDrumBumps();
  ensurePhysicsLoop();
  clearChuteBall();
  physicsBalls = [];

  const engine = ensurePixiMatterDrum();
  if (engine) {
    engine.clearBalls();
  } else {
    drumPool.innerHTML = "";
  }

  await animateFolderIntoDrum(bag);

  const engineAfterLoad = ensurePixiMatterDrum();
  if (!engineAfterLoad || engineAfterLoad.getBallCount() === 0) {
    renderDrumPool();
  }

  loadingFolderAnimation = false;
  setButtonsEnabled(true);

  if (isRestoring) {
    if (pickedHistory.length) renderPickedHistory();
    hint.textContent = `Partida restaurada · ${bag.length} imagen(es) restante(s).`;
  } else {
    hint.textContent = "Bombo cargado. Puedes girar y sacar bola.";
    saveGameState();
  }
});

btnSpin.addEventListener("click", startSpin);
btnBall.addEventListener("click", drawBall);

btnReset.addEventListener("click", () => {
  if (!allFiles.length) return;
  clearChuteBall();
  resetBag();
  clearGameState();
});

window.addEventListener("resize", () => {
  setupStageSplit();
  if (!allFiles.length) return;
  const engine = ensurePixiMatterDrum();
  if (engine) {
    engine.resize();
  }
  renderDrumBumps();
  renderDrumPool();
});

// UX: atajo teclado
window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (e.key === " " && !btnSpin.disabled) { // space
    e.preventDefault();
    startSpin();
  }
  if ((e.key === "Enter" || e.key === "Return") && !btnBall.disabled) {
    e.preventDefault();
    drawBall();
  }
  if ((e.key === "r" || e.key === "R") && !btnReset.disabled) {
    e.preventDefault();
    clearChuteBall();
    resetBag();
    clearGameState();
  }
});

// Restaurar automáticamente en Electron al arrancar (las rutas siguen disponibles)
requestAnimationFrame(() => tryRestoreElectronState());