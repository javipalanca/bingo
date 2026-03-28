(() => {
  const { Engine, World, Bodies, Body } = window.Matter || {};
  const RUBBER = {
    ballRestitution: 0.42,
    ballFriction: 0.035,
    ballAir: 0.022,
    wallRestitution: 0.34,
    rimBounce: 0.36
  };

  function randomInCircle(radius) {
    const ang = Math.random() * Math.PI * 2;
    const dist = Math.sqrt(Math.random()) * radius;
    return { x: Math.cos(ang) * dist, y: Math.sin(ang) * dist };
  }

  class PixiMatterDrum {
    constructor() {
      this.app = null;
      this.containerEl = null;
      this.engine = null;
      this.world = null;
      this.boundaries = [];
      this.entries = [];
      this.width = 0;
      this.height = 0;
      this.centerX = 0;
      this.centerY = 0;
      this.limitRadius = 0;
      this.initialized = false;
      this.initPromise = null;
      this.pendingSet = null;
      this.pendingSync = null;
      this.failed = false;
      this.textureCache = new Map();
    }

    init(containerEl) {
      if (this.failed) return this.initPromise;
      if (this.initialized || !window.PIXI || !window.Matter || !containerEl) return this.initPromise;
      if (this.initPromise) return this.initPromise;

      this.containerEl = containerEl;
      this.width = Math.max(1, containerEl.clientWidth);
      this.height = Math.max(1, containerEl.clientHeight);
      this.centerX = this.width / 2;
      this.centerY = this.height / 2;
      this.limitRadius = Math.min(this.width, this.height) / 2 - 8;

      this.engine = Engine.create({
        gravity: { x: 0, y: 0 }
      });
      this.world = this.engine.world;

      const finishInit = () => {
        this.containerEl.innerHTML = "";
        const canvas = this.app.canvas || this.app.view;
        if (canvas) {
          canvas.style.width = "100%";
          canvas.style.height = "100%";
          canvas.style.display = "block";
          this.containerEl.appendChild(canvas);
        }
        this._buildBoundaryBodies();
        this.initialized = true;

        const pendingSet = this.pendingSet;
        this.pendingSet = null;
        if (pendingSet) {
          this.setBalls(pendingSet.files, pendingSet.fileToURL, pendingSet.maxVisible);
          this.pendingSync = null;
          return;
        }

        const pendingSync = this.pendingSync;
        this.pendingSync = null;
        if (pendingSync) {
          this.syncBag(pendingSync.bag, pendingSync.fileToURL, pendingSync.maxVisible);
        }
      };

      const app = new window.PIXI.Application({
        width: this.width,
        height: this.height,
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true,
        resolution: Math.min(2, window.devicePixelRatio || 1)
      });
      this.app = app;

      if (typeof app.init === "function") {
        this.initPromise = app
          .init({
            width: this.width,
            height: this.height,
            backgroundAlpha: 0,
            antialias: true,
            autoDensity: true,
            resolution: Math.min(2, window.devicePixelRatio || 1)
          })
          .then(() => {
            finishInit();
          })
          .catch((error) => {
            this.failed = true;
            this.initPromise = null;
            throw error;
          });
        return this.initPromise;
      }

      finishInit();
      this.initPromise = Promise.resolve();
      return this.initPromise;
    }

    _buildBoundaryBodies() {
      this._clearBoundaries();
      const segments = 32;
      const pegR = 7;
      const ringR = this.limitRadius + pegR * 0.32;

      for (let i = 0; i < segments; i++) {
        const ang = (i / segments) * Math.PI * 2;
        const x = this.centerX + Math.cos(ang) * ringR;
        const y = this.centerY + Math.sin(ang) * ringR;
        const body = Bodies.circle(x, y, pegR, {
          isStatic: true,
          restitution: RUBBER.wallRestitution,
          friction: 0.04,
          frictionStatic: 0.1
        });
        this.boundaries.push(body);
      }
      World.add(this.world, this.boundaries);
    }

    _clearBoundaries() {
      if (!this.boundaries.length) return;
      World.remove(this.world, this.boundaries);
      this.boundaries = [];
    }

    _removeEntry(entry) {
      World.remove(this.world, entry.body);
      this.app?.stage?.removeChild(entry.sprite);
    }

    clearBalls() {
      for (const entry of this.entries) this._removeEntry(entry);
      this.entries = [];
    }

    destroy() {
      if (!this.initialized) return;
      this.clearBalls();
      this._clearBoundaries();
      if (this.app) {
        this.app.destroy(true, { children: true });
      }
      this.app = null;
      this.engine = null;
      this.world = null;
      this.initialized = false;
    }

    _createBallSprite(url, radius) {
      const container = new window.PIXI.Container();

      const base = new window.PIXI.Graphics();
      if (typeof base.circle === "function" && typeof base.fill === "function") {
        base.circle(0, 0, radius).fill(0xd9e6ff);
      } else {
        base.beginFill(0xd9e6ff);
        base.drawCircle(0, 0, radius);
        base.endFill();
      }
      base.alpha = 0.95;
      container.addChild(base);

      const diameter = radius * 2;
      const sprite = new window.PIXI.Sprite();
      sprite.anchor.set(0.5);
      sprite.width = diameter;
      sprite.height = diameter;
      sprite.alpha = 0;

      const clip = new window.PIXI.Graphics();
      if (typeof clip.circle === "function" && typeof clip.fill === "function") {
        clip.circle(0, 0, radius).fill(0xffffff);
      } else {
        clip.beginFill(0xffffff);
        clip.drawCircle(0, 0, radius);
        clip.endFill();
      }

      sprite.mask = clip;

      const gloss = new window.PIXI.Graphics();
      if (typeof gloss.circle === "function" && typeof gloss.fill === "function") {
        gloss.circle(-radius * 0.28, -radius * 0.34, radius * 0.38).fill(0xffffff);
      } else {
        gloss.beginFill(0xffffff);
        gloss.drawCircle(-radius * 0.28, -radius * 0.34, radius * 0.38);
        gloss.endFill();
      }
      gloss.alpha = 0.26;

      const shadow = new window.PIXI.Graphics();
      if (typeof shadow.circle === "function" && typeof shadow.fill === "function") {
        shadow.circle(radius * 0.24, radius * 0.28, radius * 0.74).fill(0x000000);
      } else {
        shadow.beginFill(0x000000);
        shadow.drawCircle(radius * 0.24, radius * 0.28, radius * 0.74);
        shadow.endFill();
      }
      shadow.alpha = 0.18;

      container.addChild(sprite);
      container.addChild(clip);
      container.addChild(shadow);
      container.addChild(gloss);

      this._loadTexture(url)
        .then((texture) => {
          if (!texture) return;
          sprite.texture = texture;
          sprite.alpha = 0.98;
          base.alpha = 0.35;
        })
        .catch(() => {
          // keep fallback circle visible
        });

      return container;
    }

    _loadTexture(url) {
      if (this.textureCache.has(url)) {
        return Promise.resolve(this.textureCache.get(url));
      }

      return new Promise((resolve, reject) => {
        const img = new Image();
        img.decoding = "async";
        img.onload = () => {
          try {
            const texture = window.PIXI.Texture.from(img);
            this.textureCache.set(url, texture);
            resolve(texture);
          } catch (error) {
            reject(error);
          }
        };
        img.onerror = () => {
          try {
            const texture = window.PIXI.Texture.from(url);
            this.textureCache.set(url, texture);
            resolve(texture);
          } catch (error) {
            reject(error);
          }
        };
        img.src = url;
      });
    }

    _randomSpawn(radius) {
      const p = randomInCircle(Math.max(1, this.limitRadius - radius - 4));
      return { x: this.centerX + p.x, y: this.centerY + p.y };
    }

    _addBall(fileRef, x, y, radius, fileToURL) {
      const body = Bodies.circle(x, y, radius, {
        restitution: RUBBER.ballRestitution,
        friction: RUBBER.ballFriction,
        frictionAir: RUBBER.ballAir,
        density: 0.0018
      });
      Body.setVelocity(body, {
        x: (Math.random() - 0.5) * 2.2,
        y: (Math.random() - 0.5) * 2.2
      });

      const sprite = this._createBallSprite(fileToURL(fileRef), radius);
      sprite.x = x;
      sprite.y = y;

      World.add(this.world, body);
      this.app.stage.addChild(sprite);

      this.entries.push({ file: fileRef, body, sprite, radius });
    }

    addBall(fileRef, fileToURL, radius = 8.4, maxVisible = 120) {
      if (!this.initialized || this.entries.some((entry) => entry.file === fileRef)) return;
      if (this.entries.length >= maxVisible) return;
      const spawn = this._randomSpawn(radius);
      this._addBall(fileRef, spawn.x, spawn.y, radius, fileToURL);
    }

    setBalls(files, fileToURL, maxVisible = 120) {
      if (!this.initialized) {
        this.pendingSet = { files: [...files], fileToURL, maxVisible };
        return;
      }
      this.clearBalls();

      const sample = [...files].slice(0, Math.min(maxVisible, files.length));
      const packing = sample.length > 90 ? 0.36 : 0.46;
      const usableArea = Math.PI * this.limitRadius * this.limitRadius * packing;
      const avgAreaPerBall = usableArea / Math.max(sample.length, 1);
      const baseRadius = Math.max(6, Math.min(14, Math.sqrt(avgAreaPerBall / Math.PI) * 0.75));

      for (const fileRef of sample) {
        const radius = Math.max(5, baseRadius * (0.84 + Math.random() * 0.32));
        const spawn = this._randomSpawn(radius);
        this._addBall(fileRef, spawn.x, spawn.y, radius, fileToURL);
      }
    }

    syncBag(bag, fileToURL, maxVisible = 120) {
      if (!this.initialized) {
        this.pendingSync = { bag: [...bag], fileToURL, maxVisible };
        return;
      }
      const target = Math.min(maxVisible, bag.length);

      this.entries = this.entries.filter((entry) => {
        if (bag.includes(entry.file)) return true;
        this._removeEntry(entry);
        return false;
      });

      const existing = new Set(this.entries.map((entry) => entry.file));
      const toAdd = bag.filter((fileRef) => !existing.has(fileRef)).slice(0, Math.max(0, target - this.entries.length));
      for (const fileRef of toAdd) {
        const radius = 5.8 + Math.random() * 2.8;
        const spawn = this._randomSpawn(radius);
        this._addBall(fileRef, spawn.x, spawn.y, radius, fileToURL);
      }
    }

    getBallCount() {
      return this.entries.length;
    }

    pickBallNearestHatch() {
      if (!this.entries.length) return null;
      const hatchX = this.centerX;
      const hatchY = this.height - 6;
      let best = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const entry of this.entries) {
        const dx = entry.body.position.x - hatchX;
        const dy = entry.body.position.y - hatchY;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          best = entry;
        }
      }
      if (!best) return null;
      return {
        file: best.file,
        r: best.radius,
        x: best.body.position.x,
        y: best.body.position.y
      };
    }

    removeBallByFile(fileRef) {
      const idx = this.entries.findIndex((entry) => entry.file === fileRef);
      if (idx < 0) return;
      const [entry] = this.entries.splice(idx, 1);
      this._removeEntry(entry);
    }

    update(dt, spinIntensity, drumAngularVelocity, gravityAngleRad) {
      if (!this.initialized || !this.entries.length) return;

      const gravityX = Math.sin(gravityAngleRad) * 0.00145;
      const gravityY = Math.cos(gravityAngleRad) * 0.00145;
      const spinDir = drumAngularVelocity >= 0 ? 1 : -1;

      for (const entry of this.entries) {
        const body = entry.body;
        const px = body.position.x;
        const py = body.position.y;

        Body.applyForce(body, body.position, {
          x: gravityX,
          y: gravityY
        });

        if (spinIntensity > 0.01) {
          const dx = px - this.centerX;
          const dy = py - this.centerY;
          const len = Math.max(Math.hypot(dx, dy), 0.001);
          const tx = (-dy / len) * spinDir;
          const ty = (dx / len) * spinDir;

          Body.applyForce(body, body.position, {
            x: tx * 0.00022 * spinIntensity,
            y: ty * 0.00022 * spinIntensity
          });

          Body.applyForce(body, body.position, {
            x: (-dx / len) * 0.00012 * spinIntensity,
            y: (-dy / len) * 0.00012 * spinIntensity
          });
        }

        const dx = px - this.centerX;
        const dy = py - this.centerY;
        const dist = Math.hypot(dx, dy);
        const maxDist = this.limitRadius - entry.radius - 1;
        if (dist > maxDist) {
          const nx = dx / Math.max(dist, 0.001);
          const ny = dy / Math.max(dist, 0.001);
          const retreat = dist - maxDist;
          Body.translate(body, { x: -nx * retreat, y: -ny * retreat });

          const dot = body.velocity.x * nx + body.velocity.y * ny;
          if (dot > 0) {
            const bounce = 1 + RUBBER.rimBounce;
            Body.setVelocity(body, {
              x: body.velocity.x - bounce * dot * nx,
              y: body.velocity.y - bounce * dot * ny
            });
          }

          const speed = Math.hypot(body.velocity.x, body.velocity.y);
          if (speed < 1.1) {
            Body.setVelocity(body, {
              x: body.velocity.x - nx * 0.7,
              y: body.velocity.y - ny * 0.7
            });
          }
        }
      }

      Engine.update(this.engine, dt * 1000);

      for (const entry of this.entries) {
        const { x, y } = entry.body.position;
        entry.sprite.x = x;
        entry.sprite.y = y;
      }

      if (typeof this.app.render === "function") {
        this.app.render();
      } else if (this.app?.renderer?.render) {
        this.app.renderer.render(this.app.stage);
      }
    }

    resize() {
      if (!this.initialized || !this.containerEl) return;
      this.width = Math.max(1, this.containerEl.clientWidth);
      this.height = Math.max(1, this.containerEl.clientHeight);
      this.centerX = this.width / 2;
      this.centerY = this.height / 2;
      this.limitRadius = Math.min(this.width, this.height) / 2 - 8;

      this.app.renderer.resize(this.width, this.height);
      this._buildBoundaryBodies();

      for (const entry of this.entries) {
        const dx = entry.body.position.x - this.centerX;
        const dy = entry.body.position.y - this.centerY;
        const dist = Math.hypot(dx, dy) || 0.0001;
        const maxDist = this.limitRadius - entry.radius - 2;
        if (dist > maxDist) {
          Body.setPosition(entry.body, {
            x: this.centerX + (dx / dist) * maxDist,
            y: this.centerY + (dy / dist) * maxDist
          });
        }
      }
    }
  }

  window.PixiMatterDrum = PixiMatterDrum;
})();
