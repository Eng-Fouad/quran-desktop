**Quran for Desktop**: a Mushaf reader with recitation for Windows, macOS and Linux. Licence: GPL-3.0-or-later.

> Draft written by `.github/workflows/release.yml`. Before publishing, replace this paragraph with the changes
> in this version.

### Downloads

| System                                | Installer                         | Portable (no install)                |
| ------------------------------------- | --------------------------------- | ------------------------------------ |
| Windows 10/11, x64                    | `Quran_<version>_x64-setup.exe`   | `Quran_<version>_x64_portable.zip`   |
| Windows 11 on Arm                     | `Quran_<version>_arm64-setup.exe` | `Quran_<version>_arm64_portable.zip` |
| macOS 13.3+ (Apple silicon and Intel) | `Quran_<version>_universal.dmg`   | `Quran_<version>_universal.app.zip`  |
| Ubuntu 22.04+ / Debian 12+, x64       | `Quran_<version>_amd64.deb`       | `Quran_<version>_amd64.AppImage`     |
| Ubuntu 22.04+ / Debian 12+, arm64     | `Quran_<version>_arm64.deb`       | `Quran_<version>_aarch64.AppImage`   |

- **Windows**: the setup installs for the current user, and installs WebView2 if it is missing. The portable zip runs
  `Quran\quran-desktop.exe` from wherever it is extracted; it needs WebView2 (part of Windows 11).
- **macOS**: drag Quran to Applications. The `.app.zip` holds the same app.
- **Linux**: `sudo apt install ./Quran_<version>_<arch>.deb`, or `chmod +x` the AppImage and run it.

Checksums: every file has a `.sha256` next to it (`sha256sum -c <file>.sha256`; macOS: `shasum -a 256 -c …`), and
`SHA256SUMS` lists them all. When the release carries `SHA256SUMS.asc`, check it with the project's public key:
`gpg --verify SHA256SUMS.asc SHA256SUMS`.

### First launch of an unsigned build

Delete this section once the builds are signed.

- **Windows**: SmartScreen shows "Windows protected your PC". Choose **More info**, then **Run anyway**.
- **macOS**: the app is signed ad hoc, not notarised. Open it once, then go to **System Settings › Privacy & Security**
  and choose **Open Anyway** (on macOS 14 and earlier you can also Control-click the app and choose **Open**).

### Data and attributions

The Quran text and page layouts come from the QUL (Tarteel) exports. Recitations stream from their publishers;
translations and tafsir are downloaded on request. Settings › About lists every source and its terms.
