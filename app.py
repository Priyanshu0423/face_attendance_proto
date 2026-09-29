"""Face-recognition attendance (InsightFace: SCRFD detector + ArcFace embeddings).

Dataset layout:  BTECH/<branch>/<class>/faces/<student_name>/*.jpg
(if there is no 'faces' folder, student folders directly under <class> are used).
Adding a student = adding a folder of photos. No training step.
"""
import os, csv, time, uuid, threading, datetime, hashlib
import numpy as np, cv2
from PIL import Image, ImageOps
from flask import Flask, request, jsonify, send_from_directory, render_template

BASE = os.path.dirname(os.path.abspath(__file__))
DATASET = os.environ.get("DATASET_DIR", os.path.join(BASE, "BTECH"))
OUT_DIR = os.path.join(BASE, "attendance_records")
THRESHOLD = float(os.environ.get("MATCH_THRESHOLD", 0.45))  # cosine similarity
LIVE_CONFIRM = int(os.environ.get("LIVE_CONFIRM", 2))       # live scans needed to mark present
DET_SIZE = int(os.environ.get("DET_SIZE", 1280))
IMG_EXT = (".jpg", ".jpeg", ".png", ".bmp", ".webp")
os.makedirs(OUT_DIR, exist_ok=True)

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024

_model, _lock = None, threading.Lock()
_gallery_cache, _sessions = {}, {}


def model():
    global _model
    if _model is None:
        from insightface.app import FaceAnalysis
        m = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"],
                         allowed_modules=["detection", "recognition"])
        m.prepare(ctx_id=-1, det_size=(DET_SIZE, DET_SIZE), det_thresh=0.5)
        _model = m
    return _model


def read_image(fs):
    """Decode upload; applies EXIF rotation so phone photos aren't sideways."""
    im = ImageOps.exif_transpose(Image.open(fs).convert("RGB"))
    return cv2.cvtColor(np.array(im), cv2.COLOR_RGB2BGR)


def detect(img):
    with _lock:
        return model().get(img)


# ---------- dataset ----------
def subdirs(p):
    return sorted(d for d in os.listdir(p) if os.path.isdir(os.path.join(p, d))) if os.path.isdir(p) else []


def faces_dir(branch, cls):
    root = os.path.join(DATASET, branch, cls)
    f = os.path.join(root, "faces")
    return f if os.path.isdir(f) else root


def load_gallery(branch, cls):
    """Embeddings for every student photo in this class; cached on disk + memory."""
    root = faces_dir(branch, cls)
    files = []
    for s in subdirs(root):
        for fn in sorted(os.listdir(os.path.join(root, s))):
            if fn.lower().endswith(IMG_EXT):
                p = os.path.join(root, s, fn)
                files.append((s, p, os.path.getmtime(p)))
    sig = hashlib.md5(repr([(s, os.path.basename(p), m) for s, p, m in files]).encode()).hexdigest()
    key = (branch, cls)
    if key in _gallery_cache and _gallery_cache[key]["sig"] == sig:
        return _gallery_cache[key]
    cache = os.path.join(root, "_gallery.npz")
    if os.path.exists(cache):
        z = np.load(cache, allow_pickle=True)
        if str(z["sig"]) == sig:
            g = dict(sig=sig, emb=z["emb"], labels=list(z["labels"]), students=list(z["students"]), skipped=[])
            _gallery_cache[key] = g
            return g
    embs, labels, skipped = [], [], []
    for s, p, _ in files:
        img = cv2.imread(p)
        fs = detect(img) if img is not None else []
        if not fs:
            skipped.append(os.path.relpath(p, root)); continue
        f = max(fs, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        embs.append(f.normed_embedding); labels.append(s)
    students = subdirs(root)
    emb = np.array(embs, dtype=np.float32) if embs else np.zeros((0, 512), np.float32)
    np.savez(cache, sig=sig, emb=emb, labels=np.array(labels), students=np.array(students))
    g = dict(sig=sig, emb=emb, labels=labels, students=students, skipped=skipped)
    _gallery_cache[key] = g
    return g


def match(g, emb):
    """Best student for one face embedding -> (name or None, score)."""
    if len(g["emb"]) == 0:
        return None, 0.0
    sims = g["emb"] @ emb
    best = {}
    for lab, s in zip(g["labels"], sims):
        if s > best.get(lab, -1): best[lab] = float(s)
    name, score = max(best.items(), key=lambda kv: kv[1])
    return (name if score >= THRESHOLD else None), score


# ---------- routes ----------
@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/branches")
def branches():
    return jsonify(subdirs(DATASET))


@app.route("/api/classes")
def classes():
    return jsonify(subdirs(os.path.join(DATASET, request.args.get("branch", ""))))


@app.route("/api/session", methods=["POST"])
def new_session():
    d = request.get_json(force=True)
    branch, cls = d.get("branch", ""), d.get("class", "")
    if not (os.path.isdir(os.path.join(DATASET, branch, cls)) and ".." not in branch + cls):
        return jsonify(error="Unknown branch/class"), 400
    g = load_gallery(branch, cls)
    if not g["students"]:
        return jsonify(error="No student folders found for this class"), 400
    sid = uuid.uuid4().hex[:10]
    _sessions[sid] = dict(branch=branch, cls=cls, students=g["students"], present={}, hits={})
    return jsonify(session=sid, roster=roster(sid), skipped=g["skipped"], photos=len(g["emb"]))


def roster(sid):
    s = _sessions[sid]
    return [dict(name=n, present=n in s["present"], how=s["present"].get(n, {}).get("how", ""))
            for n in s["students"]]


@app.route("/api/scan", methods=["POST"])
def scan():
    sid = request.form.get("session")
    if sid not in _sessions: return jsonify(error="Session expired, start again"), 400
    live = request.form.get("mode") == "live"
    s = _sessions[sid]
    g = load_gallery(s["branch"], s["cls"])
    try:
        img = read_image(request.files["image"])
    except Exception:
        return jsonify(error="Could not read image"), 400
    h, w = img.shape[:2]
    out, seen = [], set()
    for f in detect(img):
        name, score = match(g, f.normed_embedding)
        out.append(dict(box=[float(v) for v in f.bbox], name=name, score=round(score, 3)))
        if name and name not in seen:
            seen.add(name)
            s["hits"][name] = s["hits"].get(name, 0) + 1
            if not live or s["hits"][name] >= LIVE_CONFIRM:
                s["present"].setdefault(name, dict(how="scan", t=datetime.datetime.now().strftime("%H:%M:%S")))
    return jsonify(faces=out, width=w, height=h, roster=roster(sid),
                   total=len(out), recognized=len(seen))


@app.route("/api/toggle", methods=["POST"])
def toggle():
    d = request.get_json(force=True)
    s = _sessions.get(d.get("session"))
    if not s or d.get("name") not in s["students"]: return jsonify(error="bad request"), 400
    n = d["name"]
    if n in s["present"]: s["present"].pop(n); s["hits"].pop(n, None)
    else: s["present"][n] = dict(how="manual", t=datetime.datetime.now().strftime("%H:%M:%S"))
    return jsonify(roster=roster(d["session"]))


@app.route("/api/finalize", methods=["POST"])
def finalize():
    sid = request.get_json(force=True).get("session")
    s = _sessions.get(sid)
    if not s: return jsonify(error="Session expired"), 400
    now = datetime.datetime.now()
    fn = f"attendance_{s['branch']}_{s['cls']}_{now:%Y%m%d_%H%M%S}.csv"
    with open(os.path.join(OUT_DIR, fn), "w", newline="", encoding="utf-8") as fh:
        wr = csv.writer(fh)
        wr.writerow(["Date", "Branch", "Class", "Student", "Status", "Marked By", "Time"])
        for n in s["students"]:
            p = s["present"].get(n)
            wr.writerow([now.date(), s["branch"], s["cls"], n, "Present" if p else "Absent",
                         p["how"] if p else "", p["t"] if p else ""])
    present = len(s["present"])
    return jsonify(file=fn, url=f"/download/{fn}", present=present, absent=len(s["students"]) - present)


@app.route("/download/<path:fn>")
def download(fn):
    return send_from_directory(OUT_DIR, fn, as_attachment=True)


if __name__ == "__main__":
    print("Loading InsightFace model (first run downloads ~280 MB)...")
    model()
    app.run(host="0.0.0.0", port=5000, debug=False, threaded=True)
