# VFS Global Login Shortcut - Chrome Extension

This Manifest V3 extension adds a **Login** button immediately after the
**Book now** control on:

https://visa.vfsglobal.com/ind/en/lva/book-an-appointment

Clicking **Login** navigates to:

https://visa.vfsglobal.com/ind/en/lva

## Install in Chrome

1. Download and unzip `vfs-login-extension.zip`.
2. Open Chrome.
3. Go to `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the unzipped `vfs-login-extension` folder.
7. Open/reload the VFS Global Book an Appointment page.

## How it works

The extension runs only on the specified VFS Latvia appointment URL.
Because the VFS page is a dynamic Nuxt/Vue application, the extension uses
a MutationObserver to wait for the Book now element if it is rendered after
the initial page load.

It does not submit forms, solve CAPTCHA, bypass security controls, or
automatically book an appointment.
