**Quran for Desktop**: a Mushaf reader with recitation for Windows, macOS and Linux. Licence: GPL-3.0-or-later.

> Draft written by `.github/workflows/release.yml`. Before publishing, complete `docs/RELEASE_CHECKLIST.md`, then
> replace this paragraph with the changes in this version.

### Downloads

| System                                | File                             | Notes                                                                  |
| ------------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| Windows 10/11 (x64)                   | `Quran_<version>_x64-setup.exe`  | Installs for the current user. WebView2 is installed if it is missing. |
| macOS 13.3+ (Apple silicon and Intel) | `Quran_<version>_universal.dmg`  | Drag Quran to Applications.                                            |
| Ubuntu 22.04+ / Debian 12+ (x64)      | `Quran_<version>_amd64.deb`      | `sudo apt install ./Quran_<version>_amd64.deb`                         |
| Other Linux (x64)                     | `Quran_<version>_amd64.AppImage` | `chmod +x`, then run it.                                               |

Each file has a `.sha256` next to it: `sha256sum -c <file>.sha256` (macOS: `shasum -a 256 -c <file>.sha256`).

### First launch of an unsigned build

Code signing is not set up yet (see `docs/deviations/WP13b.md`), so the systems warn on first launch:

- **Windows**: SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**.
- **macOS**: the app is signed ad hoc, not notarised. Open it once, then go to **System Settings › Privacy & Security**
  and choose **Open Anyway** (on macOS 14 and earlier you can also Control-click the app and choose **Open**).

### Data and attributions

The Quran text and page layouts come from the QUL (Tarteel) exports. Recitations stream from their publishers;
translations and tafsir are downloaded on request. Settings › About lists every source and its terms.
