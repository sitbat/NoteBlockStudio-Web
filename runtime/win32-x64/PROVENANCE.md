# FFmpeg Windows x86_64

Validated executable for local packages: `ffmpeg.exe`, version `9.0.2-essentials_build-www.gyan.dev`. The executable is excluded from Git; the full license, upstream README and provenance remain tracked.

FFmpeg's [official download page](https://ffmpeg.org/download.html) links Gyan as a Windows binary distributor. This is a fresh dependency download; no EXE or DLL from the original NoteBlockStudio archive was used.

- Distributor archive: https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip
- Distributor SHA256: https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip.sha256
- Archive size:114,768,076 bytes.
- Verified archive SHA256: `60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba`.
- ffmpeg.exe SHA256: `3256173f3f8bffd7df12227c68adf68025edb1832273a9530688a7bb1ed8edec`.
- License: GNU GPL version3, as stated in the upstream [README.txt](README.txt) and full [LICENSE](LICENSE). This license is separate from the editor's MIT license.
- Upstream source revision recorded by this distribution: https://github.com/FFmpeg/FFmpeg/commit/946fcce07b.

The official archive hash was verified before extracting or executing the binary. The archive was assembled from the preserved local download prefix and sixteen standard HTTP Range responses; final byte length and full SHA256 matched the distributor's independently fetched checksum. Local packages may include ffmpeg.exe with the full upstream LICENSE and README.txt. Upstream README.txt records the build configuration; `ffmpeg.exe -version` also prints it. No DLL installation, PATH change or system package installation is required.

The local server launches this executable with fixed argument arrays and `shell:false` for user-requested audio conversion. Its protocol whitelist is file/pipe; browser song downloads use the separate bounded HTTP(S) route. Normal playback and Rust WAV export run without FFmpeg.
