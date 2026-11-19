FROM python:3.12-slim
# libglib2.0-0: needed by OpenCV, which pdf2docx uses for layout analysis.
# Keep this RUN line byte-for-byte: Docker reuses the built layer only while it is unchanged, and rebuilding it means
# ~200 MB from PyPI at ~100 KB/s on the NAS. It resolved (2026-11-18) to: PyMuPDF 2.1, pymupdf-layout 2.1,
# pymupdf4llm 2.1, opencv-python-headless 5.1.0.95, numpy 2.5.5, onnxruntime 1.32.0, python-docx 1.2.0,
# fonttools 4.68.0, lxml 6.1.3. Pin them here if this layer ever has to be rebuilt.
RUN apt-get update && apt-get install -y --no-install-recommends libglib2.0-0 && rm -rf /var/lib/apt/lists/* \
 && pip install --no-cache-dir pdf2docx==0.5.8
# Look-alike fonts with Cyrillic for lines whose own font lacks a letter: same width as the originals (Liberation for
# Arial, Times New Roman and Courier New; Carlito for Calibri; Caladea for Cambria), so the layout does not move.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea \
 && rm -rf /var/lib/apt/lists/*
# LibreOffice without a GUI, with its PDF import: the second PDF -> Word engine, which keeps every line, frame and
# picture where it was (server.py keeps whichever result looks closer to the PDF).
RUN apt-get update && apt-get install -y --no-install-recommends libreoffice-writer-nogui libreoffice-draw-nogui \
 && rm -rf /var/lib/apt/lists/*
COPY server.py /app/server.py
USER 65534:65534
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
EXPOSE 8090
CMD ["python", "-u", "/app/server.py"]
