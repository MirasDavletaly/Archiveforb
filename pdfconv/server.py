# PDF services for Files, reached only over the compose network; holds no files (everything happens in memory or in
# a temporary folder deleted right after). One job at a time: the NAS CPU is small.
#   POST /pdf2docx   PDF -> DOCX (editing a PDF as a Word document): two engines, the closer-looking result wins
#   POST /inspect    PDF -> JSON: per page its size, an image (PNG or JPEG) and the text spans with position, font, style
#   POST /apply      one JSON line of edits, "\n", then the PDF -> the edited PDF. The changes are appended to the file
#                    (incremental save), so everything else stays byte for byte. Only the text being replaced or erased
#                    is removed (drawings, images and backgrounds under it stay); new text is written at the original
#                    baseline in the PDF's own font when it has the letters, otherwise in a look-alike of the same width.
import base64, http.server, io, json, multiprocessing, os, re, secrets, subprocess, tempfile, threading
import pymupdf
from fontTools import subset as fts
from pdf2docx import Converter

MAX = 50 * 1024 * 1024
MAX_PAGES = 100
DPI = 216
one = threading.Semaphore(1)

# Look-alike fonts by file name ("Carlito-Bold.ttf"), found once at start.
FONT_FILES = {}
for root, _, files in os.walk('/usr/share/fonts'):
    for f in files:
        if f.endswith('.ttf'):
            FONT_FILES.setdefault(f[:-4], os.path.join(root, f))


DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'


def soffice(d, *args, timeout=120):
    """One headless LibreOffice run with a private profile; raises if it fails or takes too long."""
    subprocess.run(['soffice', '--headless', '--norestore', '--nologo', '--nodefault', '--nolockcheck',
                    f'-env:UserInstallation=file://{d}/lo-profile', *args],
                   cwd=d, timeout=timeout, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _flow(src, dst):
    cv = Converter(src)
    try:
        cv.convert(dst)
    finally:
        cv.close()


def fix_layout_docx(path):
    """LibreOffice's PDF import puts every line in a text box at its exact page position, but writes the position as
    if measured from the margins (everything moves by the margin) and gives the boxes a fixed size (a slightly wider
    substitute font then cuts off the end of a line). Positions are made page-relative and boxes grow with their text."""
    import zipfile
    tmp = path + '.fixed'
    with zipfile.ZipFile(path) as zin, zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == 'word/document.xml':
                xml = data.decode('utf-8')
                xml = xml.replace('<wp:positionH relativeFrom="column">', '<wp:positionH relativeFrom="page">')
                xml = xml.replace('<wp:positionV relativeFrom="paragraph">', '<wp:positionV relativeFrom="page">')
                xml = re.sub(r'(style="position:absolute;)', r'\1mso-position-horizontal-relative:page;mso-position-vertical-relative:page;', xml)
                xml = xml.replace('<wp:wrapSquare wrapText="bothSides"/>', '<wp:wrapNone/>')
                xml = re.sub(r'<wps:bodyPr wrap="square"', '<wps:bodyPr wrap="none"', xml)
                xml = xml.replace('<a:noAutofit/>', '<a:spAutoFit/>')
                data = xml.encode('utf-8')
            zout.writestr(item, data)
    os.replace(tmp, path)


def gray_pages(path, n=3, dpi=40):
    """The first pages as small, slightly blurred grayscale pictures, for comparing how two files look: the blur
    makes a letter one pixel off count little, while moved or missing text, lines and tables still count."""
    import numpy as np
    doc = pymupdf.open(path)
    out = []
    for page in list(doc)[:n]:
        pix = page.get_pixmap(dpi=dpi, colorspace=pymupdf.csGRAY)
        a = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width).astype(np.float32)
        p = np.pad(a, 1, mode='edge')
        out.append(sum(p[1 + dy:1 + dy + a.shape[0], 1 + dx:1 + dx + a.shape[1]] for dy in (-1, 0, 1) for dx in (-1, 0, 1)) / 9)
    return out, doc.page_count


def difference(original, candidate):
    """How differently the candidate looks from the original PDF: mean pixel difference over the first pages,
    plus a penalty for every page gained or lost. Lower is better."""
    a, an = gray_pages(original)
    b, bn = gray_pages(candidate)
    scores = []
    for x, y in zip(a, b):
        h, w = min(x.shape[0], y.shape[0]), min(x.shape[1], y.shape[1])
        scores.append(float(abs(x[:h, :w] - y[:h, :w]).mean()) + 40 * (1 - h * w / max(x.size, 1)))
    return (sum(scores) / len(scores) if scores else 255) + 30 * abs(an - bn)


def pdf2docx(data, only=None):
    """PDF -> Word with two engines: LibreOffice's PDF import (every line, frame and picture stays where it was) and
    pdf2docx (running text). Both results are turned back into PDF and the one that looks closer to the original
    is returned; if one engine fails or hangs, the other one's result is used."""
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, 'original.pdf')
        with open(src, 'wb') as f:
            f.write(data)
        cands = {}
        try:
            if only == 'flow':
                raise RuntimeError('skipped')
            os.mkdir(os.path.join(d, 'lo'))
            soffice(d, '--infilter=writer_pdf_import', '--convert-to', 'docx:MS Word 2007 XML', '--outdir', os.path.join(d, 'lo'), src)
            os.rename(os.path.join(d, 'lo', 'original.docx'), os.path.join(d, 'layout.docx'))
            fix_layout_docx(os.path.join(d, 'layout.docx'))
            cands['layout'] = os.path.join(d, 'layout.docx')
        except Exception as e:
            print(f'pdf2docx: LibreOffice import failed ({e})', flush=True)
        if only != 'layout':
            p = multiprocessing.get_context('fork').Process(target=_flow, args=(src, os.path.join(d, 'flow.docx')), daemon=True)
            p.start()
            p.join(90)
            if p.is_alive():
                p.kill()
                p.join()
                print('pdf2docx: pdf2docx took too long', flush=True)
            elif os.path.exists(os.path.join(d, 'flow.docx')):
                cands['flow'] = os.path.join(d, 'flow.docx')
        if not cands:
            raise ValueError('This PDF could not be prepared for editing.')
        best = next(iter(cands))
        if len(cands) > 1:
            try:
                os.mkdir(os.path.join(d, 'back'))
                soffice(d, '--convert-to', 'pdf', '--outdir', os.path.join(d, 'back'), *cands.values())
                scores = {k: difference(src, os.path.join(d, 'back', f'{k}.pdf')) for k in cands}
                best = min(scores, key=scores.get)
                print('pdf2docx: ' + ', '.join(f'{k} {v:.1f}' for k, v in scores.items()) + f' -> {best}', flush=True)
            except Exception as e:
                print(f'pdf2docx: comparison failed ({e}), keeping {best}', flush=True)
        with open(cands[best], 'rb') as f:
            return f.read(), DOCX_TYPE


def open_pdf(src):
    doc = pymupdf.open(src) if isinstance(src, str) else pymupdf.open(stream=src, filetype='pdf')
    if doc.needs_pass:
        raise ValueError('The PDF is protected by a password.')
    if doc.page_count > MAX_PAGES:
        raise ValueError(f'PDFs with more than {MAX_PAGES} pages cannot be edited in the browser.')
    return doc


def font_label(raw):
    """'ABCDEF+Calibri-Bold' -> 'Calibri', 'ArialMT' -> 'Arial' (for showing the line in a similar font)."""
    name = raw.split('+', 1)[-1]
    name = re.split(r'[-,]', name)[0]
    return re.sub(r'(PSMT|MT|PS)$', '', name) or raw


def inspect(data):
    doc = open_pdf(data)
    pages = []
    for page in doc:
        spans = []
        if page.rotation == 0:  # text on turned pages is shown but not offered for editing
            for block in page.get_text('dict')['blocks']:
                for line in block.get('lines', []):
                    if tuple(round(v, 3) for v in line['dir']) != (1.0, 0.0):
                        continue  # rotated or vertical text
                    for s in line['spans']:
                        if not s['text'].strip():
                            continue
                        flags, name, c = s['flags'], s['font'].lower(), s['color']
                        family = family_of(flags, font_label(s['font']))
                        spans.append({
                            'text': s['text'], 'bbox': [round(v, 2) for v in s['bbox']], 'origin': [round(v, 2) for v in s['origin']],
                            'size': round(s['size'], 2), 'color': [round((c >> 16 & 255) / 255, 3), round((c >> 8 & 255) / 255, 3), round((c & 255) / 255, 3)],
                            'family': family, 'bold': bool(flags & 16) or 'bold' in name, 'italic': bool(flags & 2) or 'italic' in name or 'oblique' in name,
                            'font': font_label(s['font']), 'pdfFont': s['font'],
                        })
        # Sharp enough for a full-width page on high-density screens. PNG keeps text crisp; pages that are mostly
        # photos or scans go as JPEG when that is much smaller.
        pix = page.get_pixmap(dpi=DPI)
        png, jpg = pix.tobytes('png'), pix.tobytes('jpeg', jpg_quality=92)
        image, mime = (png, 'image/png') if len(png) <= 1.5 * len(jpg) else (jpg, 'image/jpeg')
        pages.append({'width': round(page.rect.width, 2), 'height': round(page.rect.height, 2), 'rotated': page.rotation != 0,
                      'image': base64.b64encode(image).decode(), 'mime': mime, 'spans': spans})
    return json.dumps({'pages': pages}).encode(), 'application/json'


# Font names in PDFs -> a free font of the same look and width installed here.
LOOKALIKE = [('calibri', 'Carlito'), ('carlito', 'Carlito'), ('cambria', 'Caladea'), ('caladea', 'Caladea'),
             ('liberationsans', 'LiberationSans'), ('arial', 'LiberationSans'), ('helvetica', 'LiberationSans'),
             ('liberationserif', 'LiberationSerif'), ('times', 'LiberationSerif'),
             ('liberationmono', 'LiberationMono'), ('courier', 'LiberationMono')]
SANS_HINTS = ('sans', 'arial', 'helvetica', 'calibri', 'carlito', 'verdana', 'tahoma', 'segoe', 'roboto', 'gothic', 'futura')


def family_of(flags, name):
    """sans / serif / mono, from the font name first (flags in PDFs are often wrong), then the flags."""
    n = name.lower().replace(' ', '')
    if 'mono' in n or 'courier' in n or 'consol' in n:
        return 'mono'
    if any(h in n for h in SANS_HINTS):
        return 'sans'
    if 'serif' in n or 'times' in n or 'cambria' in n or 'caladea' in n or 'georgia' in n or 'garamond' in n:
        return 'serif'
    return 'mono' if flags & 8 else 'serif' if flags & 4 else 'sans'


def lookalike(e):
    """Font file of the same look and width as the line's font: Carlito for Calibri, Caladea for Cambria,
    Liberation for Arial / Times New Roman / Courier New; otherwise by kind (sans, serif, mono)."""
    name = (e.get('font') or '').lower().replace(' ', '').replace('-', '')
    family = next((f for key, f in LOOKALIKE if key in name), None) or \
        {'serif': 'LiberationSerif', 'mono': 'LiberationMono'}.get(e.get('family'), 'LiberationSans')
    style = ('Bold' if e.get('bold') else '') + ('Italic' if e.get('italic') else '') or 'Regular'
    return FONT_FILES.get(f'{family}-{style}') or FONT_FILES.get(f'{family}-Regular') or FONT_FILES.get('LiberationSans-Regular')


def subset(path, text):
    """A font file cut down to the letters actually written: a few KB instead of hundreds."""
    opts = fts.Options()
    opts.notdef_outline = True
    opts.name_IDs = ['*']
    opts.name_languages = ['*']
    font = fts.load_font(path, opts)
    sub = fts.Subsetter(opts)
    sub.populate(text=text + ' ')
    sub.subset(font)
    buf = io.BytesIO()
    fts.save_font(font, buf, opts)
    return buf.getvalue()


def own_font(doc, page, raw, text):
    """The PDF's own embedded font for this line, if it can draw every letter of the new text."""
    if not raw:
        return None
    bare = raw.split('+', 1)[-1]
    for f in page.get_fonts(full=True):
        if f[3].split('+', 1)[-1] != bare:  # embedded subsets are named "ABCDEF+Font"; spans drop the prefix
            continue
        try:
            _, ext, _, buf = doc.extract_font(f[0])
            if ext not in ('ttf', 'otf', 'cff') or not buf:
                return None
            font = pymupdf.Font(fontbuffer=buf)
            return buf if all(font.has_glyph(ord(ch)) for ch in set(text)) else None
        except Exception:
            return None
    return None


def apply(data):
    cut = data.index(b'\n')
    edits = json.loads(data[:cut])
    with tempfile.TemporaryDirectory() as d:
        path = os.path.join(d, 'in.pdf')
        with open(path, 'wb') as f:
            f.write(data[cut + 1:])
        doc = open_pdf(path)
        pages = {}
        for e in edits:
            pages.setdefault(int(e['page']), []).append(e)
        for pno, es in pages.items():
            page = doc[pno]
            if page.rotation != 0:
                raise ValueError('Turned pages cannot be edited.')
            # Decided before anything is removed: whether the page's own font can write each new line.
            writes = []
            for e in es:
                if e['type'] in ('replace', 'add') and e['text'].strip():
                    writes.append((e, own_font(doc, page, e.get('pdfFont') if e['type'] == 'replace' else None, e['text'])))
            removing = [e for e in es if e['type'] in ('replace', 'erase')]
            for e in removing:
                x0, y0, x1, y1 = e['bbox']
                h = y1 - y0
                # The middle band of the line only, slightly inside: neighbouring lines and words are not touched.
                page.add_redact_annot(pymupdf.Rect(x0 + 0.4, y0 + h * 0.3, x1 - 0.4, y1 - h * 0.3), fill=False, cross_out=False)
            if removing:
                page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                                      text=pymupdf.PDF_REDACT_TEXT_REMOVE)
            # Look-alike fonts are subset once per font for all the lines written in it.
            needs = {}
            for e, own in writes:
                if own is None:
                    needs.setdefault(lookalike(e), []).append(e['text'])
            cut_fonts = {p: subset(p, ''.join(t)) for p, t in needs.items()}
            print(f'apply: page {pno + 1}: {sum(own is not None for _, own in writes)} line(s) in their own font, '
                  f'look-alikes: {", ".join(sorted(os.path.basename(p) for p in needs)) or "none"}', flush=True)
            for e, own in writes:
                name = 'F' + secrets.token_hex(4)  # never reuse a font (and its letters) from an earlier save
                page.insert_font(fontname=name, fontbuffer=own if own is not None else cut_fonts[lookalike(e)])
                page.insert_text(pymupdf.Point(*e['origin']), e['text'], fontsize=float(e['size']), fontname=name, color=tuple(e['color']))
        try:
            if not doc.can_save_incrementally():
                raise RuntimeError('the file had to be repaired when opened')
            doc.saveIncr()  # appended: every original byte stays as it was
            doc.close()
            with open(path, 'rb') as f:
                return f.read(), 'application/pdf'
        except Exception as e:  # files that had to be repaired when opened cannot be appended to
            print(f'apply: full save instead of appending ({e})', flush=True)
            return doc.tobytes(garbage=0, deflate=False), 'application/pdf'


JOBS = {'/pdf2docx': (pdf2docx, 330), '/inspect': (inspect, 120), '/apply': (apply, 90),
        # one engine only, for checking how each converts a file
        '/pdf2docx/layout': (lambda d: pdf2docx(d, 'layout'), 200), '/pdf2docx/flow': (lambda d: pdf2docx(d, 'flow'), 200)}


def _child(path, data, conn):
    try:
        conn.send(('ok', JOBS[path][0](data)))
    except Exception as e:
        conn.send(('error', str(e)[:300]))


# Each job runs in a child process with a time limit: a PDF that makes a library hang (one did) is killed instead of
# blocking every job after it.
def run_limited(path, data):
    parent, child = multiprocessing.Pipe(duplex=False)
    # Not a daemon: a job may start its own helper process (pdf2docx under its own time limit).
    p = multiprocessing.get_context('fork').Process(target=_child, args=(path, data, child), daemon=False)
    p.start()
    child.close()
    try:
        if not parent.poll(JOBS[path][1]):
            raise TimeoutError('This PDF took too long to process.')
        kind, value = parent.recv()
    except EOFError:
        raise RuntimeError('Processing this PDF failed.')
    finally:
        if p.is_alive():
            p.kill()
        p.join()
    if kind != 'ok':
        raise ValueError(value)
    return value


class Handler(http.server.BaseHTTPRequestHandler):
    def reply(self, status, body, ctype='text/plain; charset=utf-8'):
        self.send_response(status)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path not in JOBS:
            return self.send_error(404)
        n = int(self.headers.get('Content-Length') or 0)
        if not 0 < n <= MAX + 4 * 1024 * 1024:
            return self.send_error(413)
        data = self.rfile.read(n)
        try:
            with one:
                body, ctype = run_limited(self.path, data)
        except Exception as e:  # damaged, encrypted or image-only PDFs, bad edits
            return self.reply(422, str(e).encode()[:300])
        self.reply(200, body, ctype)

    def log_message(self, *args):
        pass


http.server.ThreadingHTTPServer(('0.0.0.0', 8090), Handler).serve_forever()
