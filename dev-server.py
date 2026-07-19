#!/usr/bin/env python3
"""Static dev server for the Safe Creatives site.

Plain `python -m http.server` sends no cache-control headers, so browsers
cache CSS and JS aggressively and keep serving stale files after an edit --
you fix a bug, reload, and see the old behaviour. This sends no-store on
everything so a reload always reflects what is on disk.

Usage:  python dev-server.py [port]     (default 8000)
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Quieter than the default: skip the successful asset noise.
        if args and str(args[1]).startswith(("2", "3")) and not str(args[0]).endswith((".html", ".js")):
            return
        super().log_message(fmt, *args)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Safe Creatives dev server -> http://localhost:{port}")
    print("Caching disabled; edits are picked up on reload.\n")
    ThreadingHTTPServer(("", port), NoCacheHandler).serve_forever()
