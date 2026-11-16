# VFS runner

Cycles accounts a -> b -> c -> a ... with the extension doing the slot checks.

## First run
1. `npm install` (the runner drives your installed Google Chrome)
2. One-time: `npm run runner -- --setup`. Chrome opens on the runner's own profile (`runner/.profile/`, separate from your normal Chrome). Turn on Developer mode, click "Load unpacked", choose this repo folder, then close the window. Chrome 137+ ignores `--load-extension`, so this manual step is needed. After editing extension files, reload the extension at `chrome://extensions` in that profile.
3. Put your accounts in `runner/accounts.csv` (gitignored):
   ```
   email,password,source,destination,vacCode|visaCategoryCode,category
   a@example.com,<pw>,are,lva,"AUH|LL,DXB|LL",Long Stay
   b@example.com,<pw>,are,lva,"AUH|LL,DXB|LL",Long Stay
   ```
4. `npm run runner`
5. When the login page shows the captcha, tick it. A macOS notification appears after 30 s.

Options: `--chromium` (Playwright's bundled Chromium instead of Chrome, no setup step), `--csv <path>`, `--until HH:MM` (no new session after that time), `--clear-cookies`.
Log: `runner/runner.log` (JSON lines). Stop with Ctrl+C.

A session lasts about 23 minutes, then 5 minutes of cooldown (10, 20, 30 ... after a 429).
You must be at the keyboard for the captcha at the start of every session.
