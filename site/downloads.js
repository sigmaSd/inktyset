// The download links, from the latest GitHub release: one list per system, and the main button set to the
// visitor's own system. Without JavaScript (or if GitHub can't be reached), the links go to the releases page.
(async () => {
  const REPO = "sigmaSd/inktyset";
  let release;
  try {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { accept: "application/vnd.github+json" },
    });
    if (!r.ok) return;
    release = await r.json();
  } catch {
    return;
  }
  const assets = release.assets || [];
  const find = (re) => assets.find((a) => re.test(a.name));
  const mb = (a) => `${Math.round(a.size / 1e6)} MB`;
  const files = {
    linux: [
      ["AppImage (any distribution, updates itself)", find(/\.AppImage$/)],
      [".deb (Debian, Ubuntu)", find(/\.deb$/)],
      [".rpm (Fedora, openSUSE)", find(/\.rpm$/)],
    ],
    windows: [["Installer (.exe)", find(/setup\.exe$/)]],
    mac: [
      ["Apple Silicon (M1 and later)", find(/arm64\.dmg$/)],
      ["Intel", find(/(x64|x86_64)\.dmg$/) || find(/^(?!.*arm64).*\.dmg$/)],
    ],
  };
  for (const [os, list] of Object.entries(files)) {
    const box = document.getElementById(`dl-${os}`);
    const html = list
      .filter(([, a]) => a)
      .map(
        ([label, a]) =>
          `<a class="button" href="${a.browser_download_url}">${label}<small>${mb(a)}</small></a>`,
      )
      .join("");
    if (html) box.innerHTML = html;
  }
  const version = document.getElementById("version");
  version.innerHTML = `Version ${release.tag_name.replace(/^v/, "")}, released ${new Date(release.published_at).toLocaleDateString()} · <a href="${release.html_url}">release notes</a>`;

  // the main button: this visitor's system
  const ua = navigator.userAgent;
  const os = /Windows/.test(ua) ? "windows" : /Mac/.test(ua) ? "mac" : /Linux|X11/.test(ua) ? "linux" : null;
  const first = os && files[os].find(([, a]) => a);
  if (first) {
    const name = { linux: "Linux", windows: "Windows", mac: "macOS" }[os];
    const button = document.getElementById("primary");
    button.href = first[1].browser_download_url;
    button.textContent = `Download for ${name}`;
    document.getElementById("primaryNote").innerHTML =
      `${first[0]} · ${mb(first[1])} · <a href="#download">other systems</a>`;
  }
})();
