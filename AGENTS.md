- Don't format code (no `vp check --fix`, no `vp fmt`): the pre-commit hook does it. Check with `vp lint` and `vp test`.
- Heavy commands run capped, or the machine runs out of memory and everything is killed:
  `systemd-run --user --scope --quiet -p MemoryMax=3G -p MemorySwapMax=0 vp lint`.
- Test the app with its data moved aside, never on the real pages: `INKTYSET_DATA=… INKTYSET_USERDATA=… electron . --dev --no-window`
  (prints a link that opens the window's page in a browser). `electron .` with any other flag opens the real app.
- Temporary files go in ~/dev/tmp, never /tmp.
- Every word the app or the website shows is translated (docs/translating.md): new or changed English goes in
  src/i18n.ts, app/ui/i18n.ts or site/index.html (data-t), then `node tools/i18n.ts` and a French and Arabic
  translation in locales/{app,site}/*.po. `vp test` fails until they are there.
