const { ipcRenderer } = require('electron');
const path = require('path');
const { THREE, GLTFLoader, DRACOLoader, MeshoptDecoder } = window.V;

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'low-power' });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(1); // render at CSS pixel size: 2-4x cheaper on hi-DPI screens
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
scene.add(new THREE.HemisphereLight(0xffffff, 0x666677, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.0); sun.position.set(2, 4, 5); scene.add(sun);
const fill = new THREE.DirectionalLight(0xffffff, 0.6); fill.position.set(-3, 2, -2); scene.add(fill);

const pivot = new THREE.Group(); scene.add(pivot);
let model = null, mixer = null, clips = {}, current = null, currentName = null, oneShot = null;
let cfg = { anims: {}, yaw: 0 }, st = { state: 'idle', dir: 1 }, yawNow = 0;
const clock = new THREE.Clock();

function resize() {
  renderer.setPixelRatio(1);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
}
window.addEventListener('resize', resize); resize();

function disposeModel() {
  if (!model) return;
  pivot.remove(model);
  model.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => {
      for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose();
      m.dispose();
    });
  });
  model = null; mixer = null; clips = {}; current = null; currentName = null; oneShot = null; fitKey = null;
  for (const k in boxCache) delete boxCache[k];
}

const boxCache = {};
function measure(name) { // bounding box of the model while posed by a clip (cached)
  const key = name && clips[name] ? name : '';
  if (boxCache[key]) return boxCache[key];
  const keep = model.position.clone(), rot = pivot.rotation.y;
  model.position.set(0, 0, 0); pivot.rotation.y = 0;
  const box = new THREE.Box3();
  const add = () => { pivot.updateMatrixWorld(true); model.traverse(o => { if (o.isSkinnedMesh) o.skeleton.update(); }); box.union(new THREE.Box3().setFromObject(model, true)); };
  if (key) {
    const m2 = new THREE.AnimationMixer(model), clip = clips[key], act = m2.clipAction(clip);
    act.play();
    [0, 0.33, 0.66].forEach(f => { m2.setTime(clip.duration * f); add(); });
    m2.stopAllAction(); m2.uncacheRoot(model);
  } else add();
  model.position.copy(keep); pivot.rotation.y = rot; pivot.updateMatrixWorld(true);
  if (box.isEmpty() || !isFinite(box.min.x) || !isFinite(box.max.y)) box.set(new THREE.Vector3(-0.5, 0, -0.5), new THREE.Vector3(0.5, 1, 0.5));
  return (boxCache[key] = box);
}
let fitKey = null, yTarget = 0;
function fit() { // frame the camera on the idle pose
  const idle = (cfg.anims || {}).idle || '';
  if (fitKey === idle) return; fitKey = idle;
  const box = measure(idle);
  const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
  model.position.x = -c.x; model.position.z = -c.z; model.position.y = yTarget = -box.min.y;
  const wide = Math.hypot(size.x, size.z);
  const v = Math.max(size.y, wide * 0.9, 1e-4) * 1.12;
  camera.left = -v / 2; camera.right = v / 2; camera.bottom = -v * 0.03; camera.top = v * 0.97;
  camera.near = 0.01 * v; camera.far = 100 * v;
  camera.position.set(0, v * 0.12, v * 10); camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
}

function play(name) {
  if (!mixer || name === currentName) return;
  const next = name && clips[name] ? mixer.clipAction(clips[name]) : null;
  if (next) { next.reset(); next.setLoop(THREE.LoopRepeat, Infinity); next.enabled = true; next.setEffectiveWeight(1); next.play(); }
  if (current && next) current.crossFadeTo(next, 0.25, false);
  else if (current) current.fadeOut(0.25);
  current = next; currentName = name;
}
function applyState(force) {
  if (!model) return;
  const a = cfg.anims || {};
  fit();
  if (st.state === 'click' && a.click && clips[a.click]) { // play the "saat diklik" animation once
    if (!force && oneShot && oneShot.isRunning && oneShot.isRunning()) return; // keep it playing
    const act = mixer.clipAction(clips[a.click]);
    act.reset(); act.setLoop(THREE.LoopOnce, 1); act.clampWhenFinished = true; act.enabled = true; act.setEffectiveWeight(1);
    act.fadeIn(0.12); act.play();
    if (current && current !== act) current.fadeOut(0.12);
    current = act; currentName = a.click; oneShot = act;
    yTarget = -measure(a.click).min.y;
    canvas.classList.remove('drag');
    sendHitbox();
    return;
  }
  const nm = st.state === 'walk' ? a.walk : st.state === 'drag' ? a.drag : a.idle;
  yTarget = -measure(nm).min.y; // keep the feet on the ground for every animation
  play(st.state === 'walk' ? a.walk : st.state === 'drag' ? a.drag : a.idle);
  canvas.classList.toggle('drag', st.state === 'drag');
  sendHitbox();
}

function sendHitbox() { // on-screen box of the character, 0..1 relative to the window
  if (!model || process.platform !== 'linux') return;
  try {
    const box = measure(currentName);
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    for (let i = 0; i < 8; i++) {
      const v = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      pivot.localToWorld(v); v.project(camera);
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
    }
    const pad = 0.02;
    ipcRenderer.send('hitbox', {
      x: Math.max(0, (x0 + 1) / 2) - pad, y: Math.max(0, (1 - y1) / 2) - pad,
      w: Math.min(2, (x1 - x0) / 2) + pad * 2, h: Math.min(2, (y1 - y0) / 2) + pad * 2
    });
  } catch (e) {}
}

const loader = new GLTFLoader();
const draco = new DRACOLoader(); draco.setDecoderPath('draco/'); loader.setDRACOLoader(draco);
loader.setMeshoptDecoder(MeshoptDecoder);

ipcRenderer.on('load-model', (e, { data, cfg: c }) => {
  cfg = c;
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const base = 'file:///' + path.dirname(c.modelPath).replace(/\\/g, '/').replace(/^\//, '') + '/';
  try {
    loader.parse(ab, base, (gltf) => {
      disposeModel();
      model = gltf.scene; pivot.add(model);
      model.traverse(o => { o.frustumCulled = false; });
      mixer = new THREE.AnimationMixer(model);
      mixer.addEventListener('finished', (ev) => { if (oneShot && ev.action === oneShot) { oneShot = null; ipcRenderer.send('click-done'); } });
      const names = [], durs = {};
      gltf.animations.forEach((clip, i) => {
        let n = clip.name || ('Animasi ' + (i + 1));
        while (clips[n]) n += '_';
        clips[n] = clip; names.push(n); durs[n] = clip.duration || 0;
      });
      cfg = Object.assign({}, cfg, { anims: {} }); fit();
      ipcRenderer.send('model-loaded', names, durs);
    }, (err) => ipcRenderer.send('model-error', String(err && err.message || err)));
  } catch (err) { ipcRenderer.send('model-error', String(err && err.message || err)); }
});
ipcRenderer.on('config', (e, c) => { cfg = c; applyState(false); });
ipcRenderer.on('state', (e, s) => { st = s; applyState(true); });

// ---- mouse: click-through on transparent pixels, drag on the model ----
let mouse = null, over = false, dragging = false, mouseMoved = true, lastDraw = 0, frame = 0;
const px = new Uint8Array(4);
window.addEventListener('mousemove', e => { mouse = { x: e.clientX, y: e.clientY }; mouseMoved = true; });
document.addEventListener('mouseleave', () => { mouse = null; });
let downAt = 0, downPos = null, movedFar = false, down = false;
canvas.addEventListener('pointerdown', e => {
  if (!over) return;
  if (e.button === 0) {
    down = true; dragging = false; movedFar = false; downAt = performance.now(); downPos = { x: e.clientX, y: e.clientY };
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
  }
});
canvas.addEventListener('pointermove', e => {
  if (!down || !downPos) return;
  if (!movedFar && Math.hypot(e.clientX - downPos.x, e.clientY - downPos.y) > 6) {
    movedFar = true; dragging = true;
    ipcRenderer.send('drag-start', { x: downPos.x, y: downPos.y }); // grab exactly where the press started
  }
});
function endDrag() {
  if (!down) return;
  const moved = movedFar;
  down = false; dragging = false; downAt = 0; downPos = null; movedFar = false;
  if (moved) ipcRenderer.send('drag-end');
  else ipcRenderer.send('pet-click'); // a plain left click: play the reaction animation
}
function cancelPointer() {
  if (!down) return;
  const moved = movedFar;
  down = false; dragging = false; downAt = 0; downPos = null; movedFar = false;
  if (moved) ipcRenderer.send('drag-end');
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', cancelPointer);
window.addEventListener('blur', cancelPointer);
window.addEventListener('contextmenu', e => { e.preventDefault(); if (over) ipcRenderer.send('pet-menu'); });

function hitTest() {
  let o = false;
  if (mouse && model) {
    const gl = renderer.getContext(), r = renderer.getPixelRatio();
    const x = Math.floor(mouse.x * r), y = Math.floor(gl.drawingBufferHeight - mouse.y * r - 1);
    if (x >= 0 && y >= 0 && x < gl.drawingBufferWidth && y < gl.drawingBufferHeight) {
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); o = px[3] > 8;
    }
  }
  if (dragging) o = true;
  if (o !== over) { over = o; canvas.classList.toggle('over', o); ipcRenderer.send('hover', o); }
}

function loop(ts) {
  requestAnimationFrame(loop);
  if (!ts) ts = performance.now();
  if (document.hidden || !model) { clock.getDelta(); return; }         // nothing to draw: no CPU spent
  const busy = st.state !== 'idle' && st.state !== 'sit';
  if (ts - lastDraw < (busy ? 33 : 50)) return;                          // 30 fps while moving, 20 fps while resting
  lastDraw = ts;
  const dt = Math.min(0.1, clock.getDelta());
  if (mixer) mixer.update(dt);
  const base = (cfg.yaw || 0) * Math.PI / 180;
  const want = base + (st.state === 'walk' ? st.dir * Math.PI / 2 : 0);
  yawNow += (want - yawNow) * Math.min(1, dt * 10);
  pivot.rotation.y = yawNow;
  if (model) model.position.y += (yTarget - model.position.y) * Math.min(1, dt * 12);
  renderer.render(scene, camera);
  frame++;
  if (mouseMoved || (frame & 3) === 0) { hitTest(); mouseMoved = false; } // readPixels is expensive: only when needed
}
loop();
window.addEventListener('error', e => ipcRenderer.send('log', 'ERR ' + e.message));
