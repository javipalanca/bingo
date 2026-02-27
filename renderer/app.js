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

if (btnCards) {
  btnCards.hidden = isElectron;
  if (!isElectron) {
    btnCards.addEventListener("click", () => {
      window.location.href = "/cards";
    });
  }
}

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

function resetBag() {
  resetRoundState();
  initDrumPhysics();
  hint.textContent = "";
}

function renderDrumPool() {
  if (!drumPool) return;
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
        if (!drumPool || physicsBalls.length >= shotCount) return;

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
  if (!physicsBalls.length || !drumPool) return;

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
  return "file://" + normalized;
}

function pickBallNearestHatch() {
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

    const hatchX = drumPool.clientWidth / 2;
    const hatchY = drumPool.clientHeight + ballObj.r + 22;

    ballObj.el.classList.add("exiting");
    ballObj.el.style.transform = `translate(${hatchX - ballObj.r}px, ${hatchY - ballObj.r}px)`;

    setTimeout(() => {
      ballObj.el.remove();
      resolve();
    }, 900);
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
  if (selectedBall) {
    physicsBalls = physicsBalls.filter((b) => b !== selectedBall);
  }

  let ball = null;
  await openDrumHatchAndDrop(async () => {
    await animateSelectedBallExit(selectedBall);
    clearChuteBall();
    ball = makeBallEl();
    chuteSlot.appendChild(ball);
    requestAnimationFrame(() => ball.classList.add("pop"));
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

  // open ball effect then reveal
  setTimeout(() => {
    if (ball) ball.classList.add("opening");
  }, 520);

  setTimeout(() => {
    revealPicked(picked).then(() => {
      pickedHistory.push(picked);
      renderPickedHistory();
      extracting = false;
      setButtonsEnabled(Boolean(allFiles.length));
    });
    hint.textContent = bag.length
      ? "Imagen revelada. Puedes girar y sacar la siguiente."
      : "Última imagen revelada. Pulsa «Reinicio» para volver a empezar.";
  }, 1500);
}

function revealPicked(fp) {
  const name = getFileName(fp);

  //pickedMeta.textContent = name;

  return animatePaperFromDrum(fp);
}

function animatePaperFromDrum(fp) {
  return new Promise((resolve) => {
    const sourceRect = drum.getBoundingClientRect();
    const targetRect = revealBody.getBoundingClientRect();
    const fromX = sourceRect.left + sourceRect.width / 2;
    const fromY = sourceRect.bottom - 26;
    const toX = targetRect.left + targetRect.width / 2;
    const toY = targetRect.top + Math.min(targetRect.height * 0.42, 210);

    const flight = document.createElement("div");
    flight.className = "paper-flight";
    flight.style.left = `${fromX}px`;
    flight.style.top = `${fromY}px`;
    flight.style.setProperty("--dx", `${toX - fromX}px`);
    flight.style.setProperty("--dy", `${toY - fromY}px`);

    document.body.appendChild(flight);
    requestAnimationFrame(() => {
      flight.classList.add("launch");
    });

    setTimeout(() => {
      flight.remove();
      revealPickedFinal(fp).then(resolve);
    }, 820);
  });
}

function revealPickedFinal(fp) {
  const url = fileToURL(fp);
  const name = getFileName(fp);

  revealBody.innerHTML = "";

  const paperWrap = document.createElement("div");
  paperWrap.className = "paper-reveal";

  const paper = document.createElement("div");
  paper.className = "paper-sheet unfolding";

  const img = document.createElement("img");
  img.className = "reveal-img";
  img.alt = name;
  img.src = url;

  paper.appendChild(img);
  paperWrap.appendChild(paper);
  revealBody.appendChild(paperWrap);

  return new Promise((resolve) => {
    paper.addEventListener("animationend", () => {
      paper.classList.add("ready");
      setTimeout(resolve, 360);
    }, { once: true });
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

  loadingFolderAnimation = true;
  setButtonsEnabled(false);
  hint.textContent = "Cargando imágenes al bombo…";
  resetRoundState();
  renderDrumBumps();
  ensurePhysicsLoop();
  clearChuteBall();
  drumPool.innerHTML = "";
  physicsBalls = [];

  await animateFolderIntoDrum(bag);

  loadingFolderAnimation = false;
  setButtonsEnabled(true);
  hint.textContent = "Bombo cargado. Puedes girar y sacar bola.";
});

btnSpin.addEventListener("click", startSpin);
btnBall.addEventListener("click", drawBall);

btnReset.addEventListener("click", () => {
  if (!allFiles.length) return;
  clearChuteBall();
  resetBag();
});

window.addEventListener("resize", () => {
  if (!allFiles.length) return;
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
  }
});