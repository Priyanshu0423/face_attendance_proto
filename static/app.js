const $ = id => document.getElementById(id);
let session = null, mode = "live", stream = null, liveTimer = null, busy = false, photos = [];
const MAX_W = 1600;

async function j(url, opt) {
  const r = await fetch(url, opt); const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Request failed"); return d;
}
const post = (u, b) => j(u, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(b)});

async function loadBranches() {
  const b = await j("/api/branches");
  $("branch").innerHTML = b.map(x => `<option>${x}</option>`).join("");
  await loadClasses();
}
async function loadClasses() {
  const c = await j("/api/classes?branch=" + encodeURIComponent($("branch").value));
  $("cls").innerHTML = c.map(x => `<option>${x}</option>`).join("");
}
$("branch").onchange = loadClasses;

$("start").onclick = async () => {
  $("setupMsg").textContent = "Preparing class gallery (first time can take a minute)...";
  $("start").disabled = true;
  try {
    const d = await post("/api/session", {branch: $("branch").value, class: $("cls").value});
    session = d.session; $("work").hidden = false;
    let m = `${d.roster.length} students, ${d.photos} reference photos loaded.`;
    if (d.skipped.length) m += ` No face found in ${d.skipped.length} reference photo(s): ${d.skipped.slice(0, 5).join(", ")}`;
    $("setupMsg").textContent = m; renderRoster(d.roster);
  } catch (e) { $("setupMsg").textContent = e.message; }
  $("start").disabled = false;
};

function renderRoster(r) {
  const p = r.filter(x => x.present), a = r.filter(x => !x.present);
  const li = x => `<li data-n="${x.name}">${x.name}${x.how === "manual" ? " (manual)" : ""}</li>`;
  $("presentList").innerHTML = p.map(li).join("");
  $("absentList").innerHTML = a.map(li).join("");
  $("counts").textContent = `Present ${p.length} / Absent ${a.length}`;
}
document.addEventListener("click", async e => {
  const li = e.target.closest("li[data-n]"); if (!li || !session) return;
  renderRoster((await post("/api/toggle", {session, name: li.dataset.n})).roster);
});

document.querySelectorAll(".tab").forEach(t => t.onclick = () => {
  mode = t.dataset.mode;
  document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === t));
  $("livePane").hidden = mode !== "live"; $("clickPane").hidden = mode !== "click";
  $("uploadPane").hidden = mode !== "upload"; $("galleryPane").hidden = mode === "live";
  if (mode !== "live") stopCam();
  if (mode !== "click") stopClickCam();
});

// Draw image/frame to canvas (bakes in orientation), return JPEG blob
function toBlob(src, w, h) {
  const s = Math.min(1, MAX_W / Math.max(w, h)), c = document.createElement("canvas");
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return new Promise(res => c.toBlob(res, "image/jpeg", 0.92));
}
async function scanBlob(blob, m) {
  const f = new FormData(); f.append("session", session); f.append("mode", m); f.append("image", blob, "x.jpg");
  return j("/api/scan", {method: "POST", body: f});
}
function drawBoxes(cv, d) {
  const ctx = cv.getContext("2d"); const k = cv.width / d.width;
  ctx.lineWidth = Math.max(2, cv.width / 300); ctx.font = `${Math.max(14, cv.width / 40)}px sans-serif`;
  d.faces.forEach(f => {
    const [x1, y1, x2, y2] = f.box.map(v => v * k), col = f.name ? "#1a9e5c" : "#d64545";
    ctx.strokeStyle = col; ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const t = f.name || "Unknown", tw = ctx.measureText(t).width + 8, fh = parseInt(ctx.font) + 6;
    ctx.fillStyle = col; ctx.fillRect(x1, Math.max(0, y1 - fh), tw, fh);
    ctx.fillStyle = "#fff"; ctx.fillText(t, x1 + 4, Math.max(fh - 5, y1 - 6));
  });
}

// ---------- live ----------
async function startCam() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: "user", width: {ideal: 1280}}});
  } catch (e) { $("liveInfo").textContent = "Camera unavailable: " + e.message; return; }
  $("video").srcObject = stream; await $("video").play();
  $("camToggle").textContent = "Stop camera";
  liveTimer = setInterval(liveTick, 900);
}
function stopCam() {
  clearInterval(liveTimer); liveTimer = null;
  if (stream) stream.getTracks().forEach(t => t.stop()); stream = null;
  $("camToggle").textContent = "Start camera";
  const o = $("overlay"); o.getContext("2d").clearRect(0, 0, o.width, o.height);
}
$("camToggle").onclick = () => stream ? stopCam() : startCam();
async function liveTick() {
  const v = $("video"); if (busy || !v.videoWidth) return; busy = true;
  try {
    const d = await scanBlob(await toBlob(v, v.videoWidth, v.videoHeight), "live");
    const o = $("overlay"); o.width = d.width; o.height = d.height;
    o.getContext("2d").clearRect(0, 0, o.width, o.height); drawBoxes(o, d);
    $("liveInfo").textContent = `${d.total} face(s) in frame, ${d.recognized} recognised`;
    renderRoster(d.roster);
  } catch (e) { $("liveInfo").textContent = e.message; }
  busy = false;
}

// ---------- photos ----------
function addFiles(files) {
  [...files].forEach(f => photos.push({file: f, url: URL.createObjectURL(f)}));
  renderThumbs();
}
$("upload").onchange = e => { addFiles(e.target.files); e.target.value = ""; };
function renderThumbs() {
  $("thumbs").innerHTML = photos.map((p, i) =>
    `<div class="thumb"><img src="${p.url}"><button class="x" data-i="${i}">×</button></div>`).join("");
  $("scanAll").disabled = !photos.length;
  $("photoCount").textContent = photos.length ? `${photos.length} photo(s) ready` : "No photos yet";
}
$("clearAll").onclick = () => { photos = []; $("results").innerHTML = ""; renderThumbs(); };

// ---------- click photos (multiple, in-browser camera) ----------
let clickStream = null;
async function startClickCam() {
  try {
    clickStream = await navigator.mediaDevices.getUserMedia({video: {facingMode: "environment", width: {ideal: 1920}}});
  } catch (e) { $("clickInfo").textContent = "Camera unavailable: " + e.message; return; }
  const v = $("clickVideo"); v.srcObject = clickStream; await v.play();
  $("clickCamToggle").textContent = "Stop camera"; $("shutter").disabled = false;
}
function stopClickCam() {
  if (clickStream) clickStream.getTracks().forEach(t => t.stop()); clickStream = null;
  $("clickCamToggle").textContent = "Start camera"; $("shutter").disabled = true;
}
$("clickCamToggle").onclick = () => clickStream ? stopClickCam() : startClickCam();
$("shutter").onclick = async () => {
  const v = $("clickVideo"); if (!v.videoWidth) return;
  const blob = await toBlob(v, v.videoWidth, v.videoHeight);
  photos.push({file: blob, url: URL.createObjectURL(blob)});
  renderThumbs(); $("clickInfo").textContent = `${photos.length} photo(s) taken`;
};
$("thumbs").onclick = e => {
  const b = e.target.closest(".x"); if (!b) return;
  photos.splice(+b.dataset.i, 1); renderThumbs();
};
$("scanAll").onclick = async () => {
  $("scanAll").disabled = true; $("results").innerHTML = "";
  for (const p of photos) {
    const img = new Image(); img.src = p.url; await img.decode();   // browser applies EXIF orientation
    const blob = await toBlob(img, img.naturalWidth, img.naturalHeight);
    const box = document.createElement("div"); box.className = "thumb";
    box.innerHTML = '<div class="cap">Scanning...</div>'; $("results").appendChild(box);
    try {
      const d = await scanBlob(blob, "photo");
      const cv = document.createElement("canvas"); cv.width = d.width; cv.height = d.height;
      cv.getContext("2d").drawImage(await createImageBitmap(blob), 0, 0);
      drawBoxes(cv, d);
      box.innerHTML = ""; box.appendChild(cv);
      box.insertAdjacentHTML("beforeend", `<div class="cap">${d.total} face(s), ${d.recognized} recognised</div>`);
      renderRoster(d.roster);
    } catch (e) { box.innerHTML = `<div class="cap">${e.message}</div>`; }
  }
  photos = []; renderThumbs();
};

$("finalize").onclick = async () => {
  try {
    const d = await post("/api/finalize", {session});
    $("dl").href = d.url; $("dl").hidden = false;
    $("dl").textContent = `Download CSV (${d.present} present, ${d.absent} absent)`;
  } catch (e) { alert(e.message); }
};
loadBranches();
