#!/usr/bin/env python3
"""Make the offline pnpm store (flatpak-node-generator's) findable by pnpm 12 for packages installed by URL.

pnpm 12 indexes a URL tarball under "<integrity>\\t<url>"; the generator's store script writes
"<integrity>\\t<name>@<url>", so `pnpm install --offline` reports ERR_PNPM_NO_OFFLINE_TARBALL. Inktyset has one such
package (folder-camera-receiver, from Folder Camera's GitHub releases). This adds each such row again under the key
pnpm 12 reads. Usage: pnpm-url-keys.py <store>/v11/index.db
"""

import re
import sqlite3
import sys

db = sqlite3.connect(sys.argv[1])
rows = db.execute("SELECT key, data FROM package_index").fetchall()
added = 0
for key, data in rows:
    integrity, sep, pkg_id = key.partition("\t")
    m = re.match(r"(?:@[^/]+/)?[^@]+@(https?://.+)$", pkg_id)
    if sep and integrity.startswith("sha") and m:
        db.execute("INSERT OR REPLACE INTO package_index (key, data) VALUES (?, ?)", (f"{integrity}\t{m[1]}", data))
        added += 1
db.commit()
print(f"pnpm-url-keys: {added} URL package(s) indexed for pnpm 12")
