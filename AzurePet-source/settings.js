const { ipcRenderer } = require('electron');
const $ = id => document.getElementById(id);
let data = { pets: [] }, sel = null;

function fillSel(el, names, value) {
  el.innerHTML = '';
  const none = document.createElement('option'); none.value = ''; none.textContent = '(tanpa animasi)'; el.appendChild(none);
  names.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; el.appendChild(o); });
  el.value = names.includes(value) ? value : '';
}
function labels() {
  $('v_size').textContent = $('size').value + ' px';
  $('v_speed').textContent = $('speed').value;
  $('v_yaw').textContent = $('yaw').value + '°';
}
function cur() { return data.pets.find(p => p.id === sel) || null; }
function render() {
  if (!cur()) sel = data.pets.length ? data.pets[0].id : null;
  const list = $('list'), top = list.scrollTop; list.innerHTML = '';
  data.pets.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'item' + (p.id === sel ? ' sel' : '');
    const n = document.createElement('span'); n.className = 'n'; n.textContent = (i + 1) + '. ' + p.name; n.title = p.cfg.modelPath;
    const s = document.createElement('span'); const bad = /Gagal/.test(p.status.msg);
    s.className = 's' + (p.status.ok ? '' : bad ? ' bad' : ' wait'); s.textContent = p.status.ok ? '✔ ' + p.status.msg : bad ? '✖ gagal' : 'memuat...';
    const b = document.createElement('button'); b.textContent = 'Hapus';
    b.onclick = ev => { ev.stopPropagation(); ipcRenderer.send('remove-pet', p.id); };
    d.onclick = () => { sel = p.id; render(); };
    d.append(n, s, b); list.appendChild(d);
  });
  list.scrollTop = top;
  $('count').textContent = '(' + data.pets.length + '/' + (data.max || 12) + ')';
  $('add').disabled = data.pets.length >= (data.max || 12);
  $('onTop').checked = !!data.onTop;
  $('autoStart').checked = !!data.autoStart;
  $('toggle').textContent = data.allVisible ? 'Sembunyikan semua' : 'Tampilkan semua';
  const p = cur();
  $('edit').classList.toggle('off', !p);
  if (!p) { $('editname').textContent = '-'; $('err').textContent = ''; return; }
  const c = p.cfg;
  $('editname').textContent = p.name;
  $('err').textContent = /Gagal/.test(p.status.msg) ? p.status.msg : '';
  ['idle', 'walk', 'drag', 'click'].forEach(k => fillSel($('a_' + k), p.animList, c.anims[k]));
  $('size').value = c.size; $('speed').value = c.speed; $('yaw').value = c.yaw; $('mode').value = c.mode;
  $('autoWalk').checked = c.autoWalk;
  labels();
}
function send(patch) { const p = cur(); if (!p) return; Object.assign(p.cfg, patch.anims ? {} : patch); if (patch.anims) Object.assign(p.cfg.anims, patch.anims); ipcRenderer.send('set-config', { id: p.id, patch }); }

ipcRenderer.on('data', (e, d) => { data = d; render(); });
ipcRenderer.on('select', (e, id) => { sel = id; render(); });
['idle', 'walk', 'drag', 'click'].forEach(k => $('a_' + k).addEventListener('change', e => send({ anims: { [k]: e.target.value } })));
['size', 'speed', 'yaw'].forEach(k => $(k).addEventListener('input', e => { labels(); send({ [k]: Number(e.target.value) }); }));
$('mode').addEventListener('change', e => send({ mode: e.target.value }));
$('autoWalk').addEventListener('change', e => send({ autoWalk: e.target.checked }));
$('onTop').addEventListener('change', e => ipcRenderer.send('set-global', { onTop: e.target.checked }));
$('autoStart').addEventListener('change', e => ipcRenderer.send('set-autostart', e.target.checked));
$('add').onclick = () => ipcRenderer.send('add-pet');
$('change').onclick = () => { if (cur()) ipcRenderer.send('change-model', sel); };
$('dup').onclick = () => { if (cur()) ipcRenderer.send('duplicate-pet', sel); };
$('toggle').onclick = () => ipcRenderer.send('toggle-all');
$('quit').onclick = () => ipcRenderer.send('quit');
window.addEventListener('dragover', e => { e.preventDefault(); document.body.classList.add('dropping'); });
window.addEventListener('dragleave', () => document.body.classList.remove('dropping'));
window.addEventListener('drop', e => {
  e.preventDefault(); document.body.classList.remove('dropping');
  const files = Array.from(e.dataTransfer.files).map(f => f.path).filter(Boolean);
  if (files.length) ipcRenderer.send('drop-models', files);
});
if (process.platform === 'linux') { // wording for Linux
  $('optBottom').textContent = 'Di atas panel (bawah layar)';
  $('autoLabel').textContent = 'Jalankan otomatis saat komputer menyala';
  $('closeHint').textContent = 'Menutup jendela ini tidak mematikan karakter. Buka lagi lewat ikon AzurePet di menu aplikasi, ikon di area tray, atau klik kanan karakternya.';
}
if (process.platform === 'darwin') { // wording for macOS
  $('optBottom').textContent = 'Di atas Dock (bawah layar)';
  $('autoLabel').textContent = 'Jalankan otomatis saat Mac menyala';
  $('closeHint').textContent = 'Menutup jendela ini tidak mematikan karakter. Buka lagi lewat ikon AzurePet di Dock, ikon di menu bar (kanan atas), atau klik kanan karakternya.';
}
ipcRenderer.send('settings-ready');
