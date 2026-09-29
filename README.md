# Face Attendance (InsightFace)

Dataset: `BTECH/<branch>/<class>/faces/<student_name>/*.jpg` (5-15 clear photos per student).
Adding/removing a student = add/remove their folder. Embeddings are cached in `_gallery.npz` and rebuilt automatically when photos change.

    pip install -r requirements.txt
    python app.py          # first run downloads the buffalo_l model (~280 MB)
    open http://localhost:5000

Tuning (environment variables): MATCH_THRESHOLD (default 0.45; raise if wrong people get matched, lower if known students are missed), LIVE_CONFIRM (live scans required before marking present, default 2), DET_SIZE (default 1280; larger finds smaller faces in big group photos, slower).
Camera access needs http://localhost or HTTPS.
