# Reddit Post in Pop-up Modal

A userscript that opens Reddit posts in a functional in-page reader modal, keeping the user on the current feed while reading posts and comments.

## Features

- Opens Reddit post links in an overlay reader modal.
- Leaves embedded video/GIF player clicks to Reddit's native playback handlers.
- Includes modal navigation, a back-to-post control, and an open-in-new-tab action.
- Closes with Escape or by clicking outside the modal.
- Uses the original userscript manager's `GM_openInTab` API when available, with a browser fallback.

## Installation

1. Install a userscript manager such as Tampermonkey or Violentmonkey in your browser.
2. Open [reddit-post-modal.uc.js](./reddit-post-modal.uc.js) and copy its contents into a new userscript, or download the file and import it into your userscript manager.
3. Save and enable the script.
4. Visit Reddit and click a post to open it in the reader modal.

## Compatibility

The script targets `https://www.reddit.com/*`. Reddit's page structure may change over time, which can affect compatibility.

## Version

Current userscript version: **1.11.2**.
