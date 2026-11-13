- Don't format code (no `vp check --fix`, no `vp fmt`): the pre-commit hook does it. Check with `vp lint` and `vp test`.
- Heavy commands run capped, or the machine runs out of memory and everything is killed:
  `systemd-run --user --scope --quiet -p MemoryMax=3G -p MemorySwapMax=0 vp lint`.
- Test the app with its data moved aside, never on the real pages: `HAND2TEX_DATA=… HAND2TEX_USERDATA=… electron . --dev --no-window`
  (prints a link that opens the window's page in a browser). `electron .` with any other flag opens the real app.
- Temporary files go in ~/dev/tmp, never /tmp.
