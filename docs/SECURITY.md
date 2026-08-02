# Security and privacy notes

- Keep the permanent OpenAI key only in the local root `.env`.
- `VITE_*` variables are client-visible; never put secrets there.
- The server defaults to `127.0.0.1` and must remain local for exhibition mode.
- Only final transcript text, selected robot, rule, generated title/tasks, latency and errors are written to SQLite. No audio, camera frames, face images or raw bounding boxes are written.
- Source ZIP/MOV files, `.env`, SQLite files and Chrome profile data are ignored by Git.
- Before pushing a private repository, install Git LFS and run `git lfs install`; `.gitattributes` declares the runtime WebM/WebP files for LFS.
