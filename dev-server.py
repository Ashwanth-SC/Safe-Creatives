#!/usr/bin/env python3
"""Static dev server for the Safe Creatives site.

Plain `python -m http.server` sends no cache-control headers, so browsers
cache CSS and JS aggressively and keep serving stale files after an edit --
you fix a bug, reload, and see the old behaviour. This sends no-store on
everything so a reload always reflects what is on disk.

It also answers HTTP Range requests (206 Partial Content), which plain
http.server does not -- without that, <video>/<audio> can play straight
through but cannot SEEK (a seek clamps back to 0). Netlify serves ranges in
production; this matches it locally.

Usage:  python dev-server.py [port]     (default 8000)
"""

import os
import re
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        # Only intercept a byte-range GET on a real file; everything else uses
        # the normal path.
        range_header = self.headers.get("Range")
        if not range_header:
            self._range_remaining = None
            return super().send_head()

        path = self.translate_path(self.path)
        if os.path.isdir(path):
            self._range_remaining = None
            return super().send_head()
        try:
            f = open(path, "rb")
        except OSError:
            self.send_error(404, "File not found")
            return None

        try:
            fs = os.fstat(f.fileno())
            size = fs.st_size
            m = re.match(r"bytes=(\d*)-(\d*)\s*$", range_header.strip())
            if not m or (m.group(1) == "" and m.group(2) == ""):
                f.close()
                self._range_remaining = None
                return super().send_head()

            start_s, end_s = m.group(1), m.group(2)
            if start_s == "":  # suffix range: the last N bytes
                length = int(end_s)
                start = max(0, size - length)
                end = size - 1
            else:
                start = int(start_s)
                end = int(end_s) if end_s else size - 1

            if start >= size:
                f.close()
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return None

            end = min(end, size - 1)
            length = end - start + 1
            self.send_response(206)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Content-Length", str(length))
            self.send_header("Last-Modified", self.date_time_string(fs.st_mtime))
            self.end_headers()
            f.seek(start)
            self._range_remaining = length
            return f
        except Exception:
            f.close()
            raise

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_range_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        while remaining > 0:
            chunk = source.read(min(64 * 1024, remaining))
            if not chunk:
                break
            outputfile.write(chunk)
            remaining -= len(chunk)
        self._range_remaining = None

    def log_message(self, fmt, *args):
        # Quieter than the default: skip the successful asset noise.
        if args and str(args[1]).startswith(("2", "3")) and not str(args[0]).endswith((".html", ".js")):
            return
        super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Safe Creatives dev server -> http://localhost:{port}")
    print("Caching disabled; edits are picked up on reload. Range requests supported.\n")
    ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
