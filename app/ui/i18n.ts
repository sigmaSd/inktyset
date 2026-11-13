// The window's words. The English is here (the source tools/i18n.ts puts in locales/app/inktyset.pot); the
// other languages come from the catalogs (locales/app/<code>.po) through /api/i18n. Also the switch between
// languages: <html lang dir>, index.html's static text (data-i18n… attributes), numbers and sizes.
// Translations are plain text: markup (bold names, keys, line breaks) is added here, around them.

import { isRtlLang, type Source, Translator } from "../../src/i18n.ts";
import type { Translations } from "../../src/po.ts";

export const UI_SOURCE = {
  starting: "Starting…",
  appClosed: "App closed — reopen Inktyset",
  ready: "Ready",
  loadingModel: "Loading the model…",
  setupNeeded: "Setup needed",
  modelStopped: "Model stopped",
  readingPage: "Reading page {n}…",
  otherLanguage: "Other…",
  writingLanguage: "Writing language",
  langOtherPh: "e.g. Dutch",
  output: "Output",
  outputTitle: "What the pages are written in",
  restartToUpdate: "Restart to update",
  updateTitle: "Inktyset {v} is downloaded: restart to use it",
  copyAll: "Copy all {f}",
  copyAllTitle: "Copy the {f} of every finished page",
  saveFile: "Save {ext} file",
  saveFileTitle: "Save one file with every finished page",
  settings: "Settings",
  addTitle: "Add photos or PDF",
  addHint: "Or drag files anywhere onto this window",
  scanner: "Scanner",
  scanning: "Scanning… keep the lid closed.",
  lookingScanners: "Looking for scanners…",
  noScanner: "No scanner found. Plug it in and turn it on.",
  lookAgain: "Look again",
  chooseScanner: "Choose a scanner:",
  scanPage: "Scan a page",
  refresh: "Refresh",
  phone: "Phone",
  phoneUnavailable: "Phone sending is not available.",
  phonesConnected: {
    one: "{n} phone connected · photos appear here by themselves",
    other: "{n} phones connected · photos appear here by themselves",
  },
  connectPhone: "Connect your phone to send photos",
  phoneStarting: "The phone receiver is still starting. Try again in a moment.",
  phoneStep1: "Install {app} on the phone (free on F-Droid).",
  phoneStep2: "In {app}, open {settings} and tap {button}.",
  phoneStep3: "Point the phone at this code.",
  phoneStep4: "Take photos of your pages. They appear here by themselves.",
  codeExpires: "This code works once and expires in {t}.",
  newCode: "New code",
  showCode: "Show a pairing code",
  connectedPhones: "Connected phones",
  remove: "Remove",
  phoneDialogTitle: "Send photos from your phone",
  sameWifi: "The phone and this computer need to be on the same Wi-Fi.",
  done: "Done",
  gb: "{n} GB",
  mb: "{n} MB",
  checking: "Checking",
  unpacking: "Unpacking",
  ofTotal: "{a} of {b}",
  stop: "Stop",
  setupTitle: "Set up Inktyset",
  setupText:
    "Inktyset reads your pages on this computer, so it needs two downloads, once. Nothing you add ever leaves this computer. Pages you add now wait until it's ready.",
  engineName: "Engine (llama.cpp)",
  modelName: "Model (Qwen3.5 9B vision)",
  setupServer:
    "You chose a model server on your own network: enter its address in Settings, under “Model and engine”.",
  setupFiles:
    "You chose model files of your own: pick them in Settings, under “Model and engine”. Inktyset's engine runs them, a download needed once.",
  openModelSettings: "Open the model settings",
  noEngine:
    "There is no ready-made engine for this system yet. If you have your own llama.cpp build, set its llama-server in Settings.",
  download: "Download ({size})",
  haveModel: "I already have the model files…",
  haveModelTitle: "Use Qwen3.5-9B-Q4_K_M.gguf and mmproj-F16.gguf you already downloaded",
  gpuLater: "checked once the engine is downloaded",
  gpuNone: "none the engine can use",
  thisComputer:
    "This computer: {mem} of memory · graphics: {gpu}. With a graphics chip a page takes a minute or two; on the processor alone, several minutes.",
  memLow: "The model needs about {need} of memory; this computer has {have}. Reading will probably fail.",
  memTight: "This computer has {have} of memory: close other programs while pages are read.",
  noGpu:
    "No graphics chip the engine can use was found: pages are read by the processor, several minutes each.",
  smallGpu:
    "The graphics chip has little memory for this model: reading may fall back to the processor and be slow.",
  appLanguage: "Language of the app",
  appLanguageAuto: "Automatic (the computer's language)",
  appLanguageNote: "The language your pages are written in is chosen at the top (Writing language).",
  helpTranslate: "Help translate Inktyset",
  usingInstalledLatex: "Using the installed LaTeX: {d}",
  using: "Using {d}",
  notUsedYet: "Not used yet: the first preview decides.",
  latexForPreviews: "LaTeX for the previews",
  auto: "Automatic",
  autoHelp: "The LaTeX installed on this computer if it works for your language, otherwise the built-in one.",
  installedLatex: "Installed LaTeX",
  found: "Found: {list}",
  noneFound: "None found on this computer.",
  builtin: "Built-in (Tectonic)",
  downloaded: "Downloaded.",
  tectonicHelp:
    "Downloaded when first needed ({size}); then it fetches the LaTeX packages a page uses, once.",
  usingInstalledTypst: "Using the installed Typst: {d}",
  typstHelp: "For Typst output; downloaded when first needed ({size}).",
  phoneSetting: "Receive photos from a phone (Folder Camera)",
  phoneSettingHelp:
    "Off by default. When on, Inktyset listens on your Wi-Fi for photos from phones you pair with a QR code.",
  firewall: "Windows will ask once to allow it through the firewall.",
  noScannerShort: "No scanner found.",
  lookForScanners: "Look for scanners",
  saneNote:
    "Scanning needs SANE (scanimage), available on Linux and macOS. You can always add scanned files as photos or PDFs.",
  modelEngine: "Model and engine",
  modelFiles: "Model files: {p}",
  otherFolder: "Use model files from another folder…",
  ownCopy: "Use Inktyset's own copy",
  checkingFiles: "Checking files",
  ownServer: "Your own llama-server (optional)",
  ownServerPh: "Leave empty to use the downloaded one",
  noEngineYet: "No engine yet.",
  yourPages: "Your pages",
  savedIn: "Saved in {p}",
  useOtherFolder: "Use another folder…",
  otherFolderHelp:
    "Inktyset restarts in the folder you pick, with the pages already there, or none. The pages in this folder stay here. Inktyset doesn't keep a list of the folders you used.",
  useUsualFolder: "Back to the usual folder",
  folderGiven:
    "This folder was given when Inktyset was started (--folder), for this time only: the next start opens the folder in the settings.",
  folderWhileReading:
    "A page is being read. Inktyset restarts in the other folder now, and reads it when you come back to this one. Go on?",
  about: "About",
  aboutUpdate: "Version {v} is downloaded: restart to use it.",
  freeSoftware: "Free software under the GPL-3.0.",
  website: "Website",
  source: "Source",
  whatsNew: "What's new",
  licenses: "Licenses",
  report: "Report a problem",
  restartConfirm: "Pages are still being read. Restart now? They continue after the restart.",
  saved: "Saved",
  waiting: "Waiting",
  reading: "Reading…",
  failed: "Failed",
  formatError: "{f} error",
  buildingPreview: "Building the preview…",
  checked: "Checked ✓",
  mayBeCut: "May be cut off",
  unclear: { one: "{n} unclear spot", other: "{n} unclear spots" },
  statusDone: "Done",
  pagesDone: { one: "{done} of {n} page done", other: "{done} of {n} pages done" },
  checkedOf: "{c} of {d} checked",
  proofreadNext: "Proofread the next one",
  addingFiles: "Adding files…",
  timeLeft: "{t} left",
  lessMinute: "less than a minute",
  aboutMin: "about {n} min",
  aboutH: "about {n} h",
  canClose: "You can close this window: waiting pages are still finished.",
  scan: "Scan",
  scanAlt: "Scan of the page",
  waitingTurn: "Waiting its turn…",
  readingHandwriting: "Reading the handwriting…",
  usuallyTakes: "A page usually takes {t}.",
  wentWrong: "Something went wrong.",
  tryAgain: "Try again",
  nextUnclear: "Next unclear spot",
  nextUnclearTitle: "Jump to the next [??] the model could not read",
  copyFmt: "Copy {f}",
  cutOff: "The page was very long and may be cut off at the end. Check the last lines.",
  noCompile: "This {f} does not compile yet. Fix the text, and the preview updates by itself.",
  renderedAlt: "Rendered page",
  preview: "Preview",
  pageN: "Page {n}",
  compare: "Compare",
  compareTitle: "Scan and text side by side, to proofread",
  dragToMove: "Drag to move this page",
  stopPage: "Stop",
  stopPageTitle: "Don't read this page until you ask",
  stoppedChip: "Stopped",
  stoppedText: "Not read: stopped. It waits until you ask.",
  readPage: "Read",
  stopAll: "Stop all",
  stopAllTitle: "Stop the page being read and the waiting ones",
  stoppedN: { one: "{n} page stopped", other: "{n} pages stopped" },
  readThem: { one: "Read it", other: "Read them" },
  editPicture: "Edit picture",
  editPictureTitle: "Turn, straighten or crop this page's picture",
  turnLeft: "Turn left",
  turnRight: "Turn right",
  straighten: "Straighten",
  wholePicture: "Whole picture",
  undoPictureEdits: "Undo all changes",
  cropHint: "Drag on the picture to keep only part of it; drag the corners to adjust.",
  save: "Save",
  saveReadAgain: "Save and read again",
  pictureWhileReading: "This page is being read: saving starts its reading again with the new picture.",
  pictureReadAgainInfo: "Read again, the page gets a new version; your corrections stay in the current one.",
  moveUp: "Move up",
  moveDown: "Move down",
  readAgain: "Read again",
  readAgainTitle: "Read this page again",
  removeTitle: "Remove this page",
  copiedWhat: "{what} copied",
  copiedBtn: "Copied ✓",
  copyFailed: "Could not copy: select the text and press Ctrl+C",
  saving: "Saving…",
  notSaved: "Not saved: {e}",
  confirmRedo: "Read this page again? The text you have now is kept as a version you can go back to.",
  confirmRemove: "Remove page {n} from the list?",
  confirmRevoke: "Remove this phone? It will need a new code to send photos again.",
  allPages: "All pages",
  sideBySide: "Side by side",
  stacked: "One above the other",
  previewOf: "{f} preview",
  markChecked: "Mark as checked",
  unmarkTitle: "Click to mark as not checked",
  markTitle: "Mark this page as proofread and go to the next one (Enter)",
  allChecked: "Every page is checked",
  compareAria: "Compare a page with its text",
  prevTitle: "Previous page",
  nextTitle: "Next page",
  zoomOut: "Zoom out (−)",
  zoomIn: "Zoom in (+)",
  fit: "Fit",
  fitTitle: "Fit to width (0)",
  layout: "Layout",
  layoutTitle: "Side by side, or one above the other (L)",
  editorTitle: "Show or hide the text (E)",
  backTitle: "Back to the pages (Esc)",
  backToPages: "Pages",
  handwritten: "Handwritten",
  hintPages: "pages",
  hintCheck: "mark checked and go to the next one",
  hintWhileTyping: "while typing",
  hintOr: "or",
  hintScroll: "scroll",
  hintZoom: "zoom",
  hintLayout: "layout",
  hintEditor: "editor",
  hintClose: "close",
  keyEnter: "Enter",
  keyEsc: "Esc",
  onlyPhotos: "Only photos and PDFs can be added",
  addingN: { one: "Adding {n} file…", other: "Adding {n} files…" },
  dropHere: "Drop photos or PDFs to add them",
  noPages: "No pages yet",
  emptyText1: "Add photos or a PDF: drag them here, or use the button above.",
  emptyText2: "Each page is read on this computer and turned into LaTeX you can copy.",
  nowTypst: "Every page is now in Typst (converted from its LaTeX).",
  backLatex: "Every page is back in LaTeX (corrections made in Typst don't carry back).",
  langChanged: "Writing language: {l}. New pages are read in it.",
  savedBtn: "Saved ✓",
  savedTo: "Saved to {p}",
  saveFailed: "Could not save: {e}",
  readingInstructions: "Reading instructions",
  yourNotes: "Your notes for the model",
  yourNotesHelp:
    "About your handwriting or notation, in any language. For example: “I write ℝ as \\R”, “ignore the page numbers”.",
  yourNotesPh: "Nothing yet",
  allInstructions: "All the instructions (advanced)",
  allInstructionsHelp:
    "What Inktyset tells the model. The lines about [??], the theorem environments and “Output ONLY the LaTeX body” are what the app relies on: keep them.",
  thenAdded: "Inktyset sends this right after them, made from the writing language and your notes above:",
  promptChanged: "changed",
  promptCustom: "You changed these instructions.",
  resetPrompt: "Back to Inktyset's instructions",
  tryOnPages: "Try on some pages…",
  tryOnPagesHelp:
    "Read a few pages again with these instructions and this model, and compare with what you have.",
  modelBuiltin: "Built-in: Qwen3.5 9B",
  modelBuiltinHelp: "Downloaded once and checked. A good reader of handwritten math.",
  modelFilesKind: "Model files on this computer",
  modelFilesHelp:
    "Any vision model llama.cpp runs: a .gguf file and its mmproj .gguf (from Hugging Face, for example).",
  modelServerKind: "A model server on this computer or your network",
  modelServerHelp:
    "Ollama, LM Studio, llama-server, vLLM… already running. Never a cloud service: your pages stay on your own machines.",
  modelFileLabel: "Model: {p}",
  mmprojLabel: "Vision file: {p}",
  notChosen: "not chosen",
  choose: "Choose…",
  serverUrl: "Address",
  serverModelName: "Model on the server",
  serverModelPh: "The server's own when empty",
  findModels: "Find its models",
  modelsFound: { one: "{n} model found", other: "{n} models found" },
  serverKey: "Key (only if the server asks for one)",
  readingWith: "Reading with: {m}",
  trialTitle: "Try on some pages",
  trialText:
    "Each page you choose is read again with the current instructions and model, as a new version. Its text is not replaced: compare the two, then keep the one you prefer.",
  cancel: "Cancel",
  trialGo: { one: "Read {n} page", other: "Read {n} pages" },
  trialNone: "Choose pages",
  trialWaiting: "Waiting to try",
  trying: "Trying…",
  trialFailedShort: "Trial failed",
  trialsLeft: {
    one: "Trying other instructions: {n} page left",
    other: "Trying other instructions: {n} pages left",
  },
  stopTrials: "Stop trying",
  newVersion: "New version: compare",
  newVersionTitle: "A trial reading of this page is ready: compare it with the one shown",
  versionsN: { one: "{n} version", other: "{n} versions" },
  versionsTitle: "Compare the readings of this page",
  compareWith: "Compare with",
  nothing: "nothing",
  shownVersion: "{v}, shown",
  earlierReading: "an earlier reading",
  diffLegend: "Struck out: only in the text shown ({a}). Highlighted: only in {b}.",
  useVersion: "Use {v}",
  useVersionTitle: "Show {v} instead: the text shown now is kept as a version",
  deleteVersion: "Delete {v}",
  confirmDeleteVersion: "Delete {v} of this page? This can't be undone.",
  sameInstructions: "Read with the same instructions.",
  otherInstructions: "Read with other instructions",
  sameText: "The two texts are the same.",
  nowShowing: "Now showing {v}.",
} satisfies Record<string, Source>;

/** What a translator should know about an entry (comments in the .pot file). */
export const UI_NOTES: Partial<Record<keyof typeof UI_SOURCE, string>> = {
  copyAll: "{f} is LaTeX or Typst",
  copyAllTitle: "{f} is LaTeX or Typst",
  copyFmt: "{f} is LaTeX or Typst",
  formatError: "{f} is LaTeX or Typst",
  noCompile: "{f} is LaTeX or Typst",
  previewOf: "{f} is LaTeX or Typst",
  saveFile: "{ext} is .tex or .typ",
  phoneStep2:
    "{app} is Folder Camera; {settings} and {button} are its English buttons: Settings, Scan PC pairing QR",
  phoneStep1: "{app} is Folder Camera, an Android app",
  gb: "gigabytes; {n} is a number",
  mb: "megabytes; {n} is a number",
  thisComputer: "{mem} is a size like 16 GB; {gpu} names graphics chips",
  pagesDone: "{done} pages finished out of {n}",
  timeLeft: "{t} is a duration: less than a minute, about 5 min…",
  usuallyTakes: "{t} is a duration: less than a minute, about 5 min…",
  hintPages: "Keyboard help in the Compare view: ← → pages",
  hintCheck: "Keyboard help: Enter marks the page checked and goes to the next one",
  hintScroll: "Keyboard help: Ctrl+scroll zooms (the mouse wheel)",
  keyEnter: "The Enter key, as printed on keyboards",
  keyEsc: "The Esc key, as printed on keyboards",
  langOtherPh: "An example of a language name, typed by the user",
  scan: "Column title: the photo or scan of the handwritten page",
  yourNotesHelp: "Keep \\R as it is: it is LaTeX",
  shownVersion: "{v} is a version name like v2",
  useVersion: "{v} is a version name like v2",
  diffLegend: "{a} and {b} are version names like v2",
  modelsFound: "Models offered by the model server",
};

export type Key = keyof typeof UI_SOURCE;

let tr = new Translator("en", UI_SOURCE, null);
export const uiLang = () => tr.lang;
export const isRtl = () => isRtlLang(tr.lang);

/** A string of the window in its current language (plain text: escape it before putting it in HTML). */
export const t = (key: Key, vars: Record<string, unknown> = {}) => tr.t(key, vars);

/** A number in the window's language (with Western digits, as on the pages). */
export const num = (n: number, digits = 0) =>
  new Intl.NumberFormat(`${tr.lang}-u-nu-latn`, {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(n);

/** A download size: "6.6 GB", "6,6 Go"… */
export const bytes = (n: number) =>
  n >= 1e9 ? t("gb", { n: num(n / 1e9, 1) }) : t("mb", { n: num(Math.max(1, Math.round(n / 1e6))) });

/** Left-to-right text (a path, ".tex") inside right-to-left text: isolated, so it keeps its own order. */
export const ltr = (s: string) => `⁦${s}⁩`;

/** The writing languages' ISO codes, for their names in the window's language. */
const ISO: Record<string, string> = {
  english: "en",
  french: "fr",
  arabic: "ar",
  german: "de",
  spanish: "es",
  italian: "it",
  portuguese: "pt",
  turkish: "tr",
};
export function languageName(id: string, fallback: string): string {
  try {
    const name = ISO[id] && new Intl.DisplayNames([tr.lang], { type: "language" }).of(ISO[id]);
    if (name) return name[0].toLocaleUpperCase(tr.lang) + name.slice(1);
  } catch {
    /* no names for this language here: the English one */
  }
  return fallback;
}

/** The website in the window's language, when it has one. */
export const websiteUrl = () =>
  `https://sigmasd.github.io/inktyset/${["fr", "ar"].includes(tr.lang) ? tr.lang + "/" : ""}`;

/** Switch the window's language: its catalog, <html lang dir>, and index.html's static text. */
export function setUiLang(lang: string, catalog: Translations | null) {
  tr = new Translator(lang, UI_SOURCE, catalog);
  document.documentElement.lang = lang;
  document.documentElement.dir = isRtlLang(lang) ? "rtl" : "ltr";
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]"))
    el.textContent = t(el.dataset.i18n as Key);
  // data-i18n-title="key" → title, and so on
  for (const [attr, name] of [
    ["title", "title"],
    ["aria-label", "aria"],
    ["placeholder", "ph"],
    ["alt", "alt"],
  ])
    for (const el of document.querySelectorAll<HTMLElement>(`[data-i18n-${name}]`))
      el.setAttribute(attr, t(el.getAttribute(`data-i18n-${name}`) as Key));
}
