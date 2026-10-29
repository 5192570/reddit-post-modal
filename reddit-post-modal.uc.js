// ==UserScript==
// @name         Reddit Post on Pop Up Modal
// @version      1.11.2
// @description  Open Reddit posts in a functional in-page reader modal.
// @match        https://www.reddit.com/*
// @grant        GM_openInTab
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const MODAL_ID = 'rmp-modal';
  const FRAME_STYLE_ID = 'rmp-frame-style';
  const PARENT_STYLE_ID = 'rmp-parent-style';

  // Identifies reader iframes and preserves the original post ID.
  const FRAME_NAME_PREFIX = 'rmp:';

  const IS_TOP = window.self === window.top;

  const IS_READER_FRAME =
    !IS_TOP &&
    window.name.startsWith(FRAME_NAME_PREFIX);

  const READER_FRAME_POST_ID =
    IS_READER_FRAME
      ? window.name.slice(FRAME_NAME_PREFIX.length)
      : '';

  // Reader-only chrome that is independent of the post/comment surface.
  // These are removed from the DOM as soon as they appear instead of merely
  // hiding them with CSS after Reddit has finished constructing them.
  const AGGRESSIVE_CHROME_SELECTORS = [
    'reddit-header-large',
    'shreddit-header',
    '#left-sidebar-container',
    '#right-sidebar-container',
    '[data-testid="left-sidebar"]',
    '[data-testid="right-sidebar"]',
    'reddit-sidebar-nav',
    'reddit-subreddit-right-sidebar',
    'shreddit-post-recommendations',
    'shreddit-related-posts',
    'pdp-back-button'
  ].join(',');

  // Current modal close handler, used by iframe messages.
  let activeModalClose = null;

  function addStyle(id, css) {
    if (document.getElementById(id)) return;

    const style = document.createElement('style');
    style.id = id;
    style.textContent = css;

    (document.head || document.documentElement).appendChild(style);
  }

  function removeAggressiveChrome(root) {
    if (!root?.querySelectorAll) return;

    for (const node of root.querySelectorAll(AGGRESSIVE_CHROME_SELECTORS)) {
      node.remove();
    }
  }

  function installAggressiveChromeSuppression() {
    if (!IS_READER_FRAME) return;

    // Remove anything already present.
    removeAggressiveChrome(document);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          if (node.matches?.(AGGRESSIVE_CHROME_SELECTORS)) {
            node.remove();
            continue;
          }

          removeAggressiveChrome(node);
        }
      }
    });

    const target = document.documentElement;
    if (target) {
      observer.observe(target, {
        childList: true,
        subtree: true
      });
    }
  }

  // Cached per event: composedPath() is only valid during dispatch, and
  // every caller runs synchronously inside the handler for that event.
  const clickPaths = new WeakMap();

  function getClickPath(event) {
    let path = clickPaths.get(event);

    if (!path) {
      path =
        typeof event.composedPath === 'function'
          ? event.composedPath()
          : [event.target];

      clickPaths.set(event, path);
    }

    return path;
  }

  // True for an unmodified primary-button click.
  function isPlainLeftClick(event) {
    return (
      event.button === 0 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      !event.altKey
    );
  }

  function getAnchorFromClick(event) {
    for (const item of getClickPath(event)) {
      if (
        item?.localName === 'a' &&
        item.href
      ) {
        return item;
      }
    }

    return event.target?.closest?.('a[href]') || null;
  }

  function isInteractiveClick(event) {
    return getClickPath(event).some(
      (item) =>
        item?.matches?.(
          'button, input, select, textarea, [role="button"], [contenteditable="true"], notification-context-menu, [data-id="notification-item-prevent-link"]'
        )
    );
  }

  // Let Reddit handle clicks on embedded media players. With autoplay disabled,
  // these clicks are playback controls, even when the player sits inside an
  // anchor that points to Reddit's media viewer.
  const NATIVE_MEDIA_INTERACTION_SELECTOR = [
    'video',
    'audio',
    'shreddit-player',
    'faceplate-video',
    'reddit-video-player',
    '[data-testid*="video-player"]',
    '[data-testid*="media-player"]',
    '.video-player',
    '.media-player'
  ].join(',');

  function isNativeMediaInteraction(event) {
    return getClickPath(event).some(
      (item) =>
        item?.matches?.(
          NATIVE_MEDIA_INTERACTION_SELECTOR
        )
    );
  }

  function getPostHrefFromClick(event) {
    if (isInteractiveClick(event)) {
      return null;
    }

    const anchor =
      getAnchorFromClick(event);

    if (anchor?.href) {
      return anchor.href;
    }

    for (const item of getClickPath(event)) {
      if (
        item?.localName === 'rpl-inbox-row' &&
        item.hasAttribute('inaccessiblehref')
      ) {
        return item.getAttribute(
          'inaccessiblehref'
        );
      }
    }

    return null;
  }

  function getHttpUrl(value, base = location.href) {
    try {
      const url = new URL(value, base);

      if (
        url.protocol !== 'http:' &&
        url.protocol !== 'https:'
      ) {
        return null;
      }

      return url;
    } catch {
      return null;
    }
  }

  // Opens a tab through the userscript manager, falling back to window.open.
  function openTab(url, active) {
    if (typeof GM_openInTab === 'function') {
      try {
        GM_openInTab(
          url,
          {
            active,
            insert: true,
            setParent: true
          }
        );

        return;
      } catch {
        // Fall through to the native behavior.
      }
    }

    window.open(
      url,
      '_blank',
      'noopener'
    );
  }

  function isRedditHost(hostname) {
    const host = hostname.toLowerCase();

    return (
      host === 'reddit.com' ||
      host.endsWith('.reddit.com')
    );
  }

  // Hosts the reader runs on; keep in sync with @match.
  function isModalHost(hostname) {
    const host = hostname.toLowerCase();

    return host === 'www.reddit.com';
  }

  const COMMENTS_PATH_RE =
    /^\/(?:r\/[^/]+\/|u(?:ser)?\/[^/]+\/)?comments\/([^/]+)/i;

  // Extracts a Reddit post ID from a comments URL.
  function extractPostId(pathname) {
    const match =
      COMMENTS_PATH_RE.exec(pathname);

    return match ? match[1] : null;
  }

  // ============================================================
  // IFRAME READER
  // ============================================================

  // Layout classes are added once the Reddit content wrapper exists.
  const FRAME_STYLE = `
    html.rmp-frame-loading {
      visibility: hidden !important;
    }

    html.rmp-frame-ready {
      visibility: visible !important;
    }

    html,
    body {
      scrollbar-width: thin !important;
      scrollbar-color:
        rgba(255, 255, 255, 0.28)
        transparent !important;
    }

    html::-webkit-scrollbar,
    body::-webkit-scrollbar {
      width: 6px;
    }

    html::-webkit-scrollbar-track,
    body::-webkit-scrollbar-track {
      background: transparent;
    }

    html::-webkit-scrollbar-thumb,
    body::-webkit-scrollbar-thumb {
      background: rgba(255, 255, 255, 0.28);
      border-radius: 999px;
    }

    html::-webkit-scrollbar-thumb:hover,
    body::-webkit-scrollbar-thumb:hover {
      background: rgba(255, 255, 255, 0.42);
    }

    /* Hide redundant nested scrollbars. */
    shreddit-post *,
    shreddit-comment-tree *,
    #comment-tree-container * {
      scrollbar-width: none !important;
    }

    shreddit-post *::-webkit-scrollbar,
    shreddit-comment-tree *::-webkit-scrollbar,
    #comment-tree-container *::-webkit-scrollbar {
      display: none !important;
    }

    body {
      margin: 0 !important;
      min-width: 0 !important;
    }

    /* Every wrapper stretches to the modal width. */
    .rmp-grid,
    .rmp-subgrid,
    .rmp-main-container,
    .rmp-main-container > #main-content,
    shreddit-app,
    shreddit-main,
    main,
    #main-content,
    main > div,
    #main-content > div,
    shreddit-post,
    shreddit-comment-tree,
    #comment-tree-container {
      box-sizing: border-box !important;

      width: 100% !important;
      max-width: none !important;
      min-width: 0 !important;
    }

    /* No side margins on the page shell and the post/comment blocks. */
    shreddit-app,
    shreddit-main,
    main,
    #main-content,
    shreddit-post,
    shreddit-comment-tree,
    #comment-tree-container {
      margin-left: 0 !important;
      margin-right: 0 !important;
    }

    shreddit-post,
    shreddit-comment-tree,
    #comment-tree-container {
      padding-left: 0 !important;
      padding-right: 0 !important;
    }

    /* Single-column grids replace Reddit's multi-column layout. */
    .rmp-grid,
    .rmp-main-container {
      display: grid !important;

      grid-template-columns: minmax(0, 1fr) !important;
      grid-template-areas: none !important;
    }

    .rmp-grid,
    .rmp-subgrid,
    .rmp-main-container {
      margin: 0 !important;
      padding: 0 !important;
    }

    .rmp-subgrid,
    .rmp-main-container > #main-content {
      grid-column: 1 / -1 !important;
    }

    .rmp-main-container {
      justify-content: stretch !important;
      justify-items: stretch !important;
      align-content: stretch !important;
    }

    .rmp-main-container > #main-content {
      margin: 0 !important;

      padding-left: 24px !important;
      padding-right: 24px !important;
    }
  `;

  // Adds layout classes to the rendered Reddit content wrappers.
  function tagLayoutAncestors() {
    const main =
      document.querySelector('#main-content');

    if (!main) {
      return false;
    }

    main
      .closest('.main-container')
      ?.classList.add('rmp-main-container');

    main
      .closest('.subgrid-container')
      ?.classList.add('rmp-subgrid');

    main
      .closest('.grid-container')
      ?.classList.add('rmp-grid');

    return true;
  }

  // ============================================================
  // IFRAME TOP-LEVEL NAVIGATION
  // ============================================================

  const USERNAME_PATH_RE =
    /^\/u(?:ser)?\/[^/]+\/?$/i;

  // Image hosts are converted to Reddit's media viewer URL.
  function isRedditImageHost(hostname) {
    const host = hostname.toLowerCase();

    return (
      host === 'i.redd.it' ||
      host === 'preview.redd.it' ||
      host === 'external-preview.redd.it'
    );
  }

  // Classifies links as modal navigation, new-tab peek, or page leave.
  function classifyFrameLink(url) {
    if (isRedditImageHost(url.hostname)) {
      const mediaUrl =
        new URL(
          'https://www.reddit.com/media'
        );

      mediaUrl.searchParams.set(
        'url',
        url.href
      );

      return {
        outcome: 'stay',
        url: mediaUrl
      };
    }

    if (!isRedditHost(url.hostname)) {
      return { outcome: 'peek', url };
    }

    if (url.pathname === '/media') {
      return { outcome: 'stay', url };
    }

    const postId =
      extractPostId(url.pathname);

    if (postId !== null) {
      return {
        outcome:
          postId === READER_FRAME_POST_ID
            ? 'stay'
            : 'leave',
        url
      };
    }

    if (
      USERNAME_PATH_RE.test(
        url.pathname
      )
    ) {
      return { outcome: 'stay', url };
    }

    return { outcome: 'leave', url };
  }

  function postToParent(message) {
    window.top.postMessage(
      message,
      '*'
    );
  }

  function requestModalNavigation(url) {
    postToParent({
      type: 'rmp-modal-navigate',
      href: url.href
    });
  }

  function handleFrameNavigation(url) {
    const classified =
      classifyFrameLink(url);

    if (classified.outcome === 'stay') {
      requestModalNavigation(
        classified.url
      );

      return true;
    }

    postToParent({
      type:
        classified.outcome === 'peek'
          ? 'rmp-open-tab'
          : 'rmp-navigate',
      href: classified.url.href
    });

    return true;
  }

  function installFrameHistoryNavigation() {
    for (const methodName of [
      'pushState',
      'replaceState'
    ]) {
      const original =
        history[methodName];

      history[methodName] = function(
        state,
        unused,
        url
      ) {
        if (url !== undefined && url !== null) {
          const nextUrl =
            getHttpUrl(url);

          if (
            nextUrl &&
            nextUrl.href !== location.href &&
            handleFrameNavigation(nextUrl)
          ) {
            return;
          }
        }

        const result = original.call(
          history,
          state,
          unused,
          url
        );

        return result;
      };
    }

    window.addEventListener(
      'popstate',
      () => {
        const nextUrl =
          getHttpUrl(location.href);

        if (!nextUrl) {
          return;
        }

        const classified =
          classifyFrameLink(nextUrl);

        if (classified.outcome === 'stay') {
          return;
        }

        // History destinations outside the modal leave the reader.
        postToParent({
          type: 'rmp-navigate',
          href: classified.url.href
        });
      },
      true
    );
  }

  function installFrameNavigation() {
    document.addEventListener(
      'click',
      (event) => {
        // Preserve modified clicks for the browser's native behavior.
        if (
          !isPlainLeftClick(event) ||
          isNativeMediaInteraction(event)
        ) {
          return;
        }

        const anchor =
          getAnchorFromClick(event);

        if (!anchor?.href) {
          return;
        }

        // Preserve explicit downloads.
        if (
          anchor.hasAttribute('download')
        ) {
          return;
        }

        const url =
          getHttpUrl(anchor.href);

        if (!url) {
          return;
        }

        const classified =
          classifyFrameLink(url);

        // Replace Reddit's default handling with the classified action.
        event.preventDefault();
        event.stopPropagation();

        if (classified.outcome === 'stay') {
          // The parent owns the modal stack and loads with replace().
          requestModalNavigation(
            classified.url
          );

          return;
        }

        postToParent({
          type:
            classified.outcome === 'peek'
              ? 'rmp-open-tab'
              : 'rmp-navigate',
          href: classified.url.href
        });
      },
      true
    );
  }

  function installReaderFrame() {
    installAggressiveChromeSuppression();

    addStyle(
      FRAME_STYLE_ID,
      FRAME_STYLE
    );

    // Route ordinary links through the modal classifier.
    installFrameNavigation();

    // Catch SPA navigations that do not originate from anchor clicks.
    installFrameHistoryNavigation();

    // Forward Escape because iframe key events do not reach the parent.
    document.addEventListener(
      'keydown',
      (event) => {
        if (
          event.key === 'Escape'
        ) {
          postToParent({
            type: 'rmp-escape'
          });
        }
      },
      true
    );

    const html =
      document.documentElement;

    if (!html) {
      return;
    }

    html.classList.add(
      'rmp-frame-loading'
    );

    let settled = false;
    let fallbackTimer = null;
    let observer = null;

    const reveal = () => {
      if (settled) {
        return;
      }

      settled = true;

      html.classList.remove(
        'rmp-frame-loading'
      );

      html.classList.add(
        'rmp-frame-ready'
      );

      observer?.disconnect();
      observer = null;

      if (fallbackTimer !== null) {
        clearTimeout(
          fallbackTimer
        );

        fallbackTimer = null;
      }

      postToParent({
        type: 'rmp-ready',
        href: location.href
      });
    };

    // Reveal after layout tagging, with fallbacks for layout variants.
    const check = () => {
      if (tagLayoutAncestors()) {
        reveal();
        return;
      }

      if (
        document.querySelector(
          'shreddit-post'
        ) ||
        location.pathname === '/media'
      ) {
        reveal();
      }
    };

    let checkQueued = false;

    const queueCheck = () => {
      if (
        settled ||
        checkQueued
      ) {
        return;
      }

      checkQueued = true;

      requestAnimationFrame(() => {
        checkQueued = false;
        check();
      });
    };

    observer =
      new MutationObserver(queueCheck);

    observer.observe(
      html,
      {
        childList: true,
        subtree: true
      }
    );

    check();

    fallbackTimer =
      setTimeout(
        reveal,
        10000
      );
  }

  // ============================================================
  // PARENT / MODAL
  // ============================================================

  const PARENT_STYLE = `
    #${MODAL_ID} {
      /* Loader logo size: change it here, and only here. */
      --rmp-logo-size: 128px;

      position: fixed;
      inset: 0;

      z-index: 2147483647;

      display: flex;
      align-items: center;
      justify-content: center;

      padding: 24px;

      background: rgba(0, 0, 0, 0.78);
    }

    #${MODAL_ID} .rmp-window {
      position: relative;

      width: min(
        1600px,
        calc(100vw - 48px)
      );

      height: min(
        94vh,
        calc(100vh - 48px)
      );

      overflow: hidden;

      background: #0b0b0b;

      border: 1px solid
        rgba(255, 255, 255, 0.12);

      border-radius: 12px;

      box-shadow:
        0 24px 80px
        rgba(0, 0, 0, 0.55),
        0 8px 32px
        rgba(0, 0, 0, 0.35);
    }

    #${MODAL_ID} .rmp-back,
    #${MODAL_ID} .rmp-close,
    #${MODAL_ID} .rmp-newtab {
      box-sizing: border-box;
      text-decoration: none;

      position: absolute;

      top: 10px;
      right: 20px;

      z-index: 4;

      width: 34px;
      height: 34px;

      display: grid;
      place-items: center;

      margin: 0;
      padding: 0;

      border: 1px solid
        rgba(255, 255, 255, 0.12);

      border-radius: 50%;

      background:
        rgba(21, 21, 21, 0.92);

      color: #bdbdbd;

      font:
        24px/1
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;

      cursor: pointer;
      user-select: none;
    }

    #${MODAL_ID} .rmp-back:hover:not(:disabled),
    #${MODAL_ID} .rmp-close:hover,
    #${MODAL_ID} .rmp-newtab:hover {
      background:
        rgba(40, 40, 40, 0.96);

      color: #ffffff;
    }

    /* Keep disabled Back above the iframe so clicks cannot fall through. */
    #${MODAL_ID} .rmp-back:disabled {
      z-index: 10;
      pointer-events: auto;
      opacity: 0.48;
      cursor: not-allowed;
    }

    #${MODAL_ID} .rmp-back:active:not(:disabled),
    #${MODAL_ID} .rmp-close:active,
    #${MODAL_ID} .rmp-newtab:active {
      background:
        rgba(55, 55, 55, 0.96);
    }

    #${MODAL_ID} .rmp-back {
      left: 20px;
      right: auto;

      padding-bottom: 2px;

      font-size: 20px;
    }

    #${MODAL_ID} .rmp-newtab {
      right: 62px;

      padding-bottom: 0;
    }

    #${MODAL_ID} .rmp-newtab svg {
      width: 18px;
      height: 18px;

      display: block;
    }

    #${MODAL_ID} .rmp-body {
      position: relative;

      width: 100%;
      height: 100%;

      overflow: hidden;

      background: #0b0b0b;
    }

    #${MODAL_ID} .rmp-iframe {
      position: absolute;
      inset: 0;

      width: 100%;
      height: 100%;

      display: block;

      border: 0;

      background: #0b0b0b;

      visibility: hidden;
      opacity: 0;

      transition:
        opacity 160ms ease,
        visibility 0s linear 160ms;
    }

    #${MODAL_ID} .rmp-iframe.rmp-loaded {
      visibility: visible;
      opacity: 1;

      transition:
        opacity 160ms ease,
        visibility 0s linear 0s;
    }

    #${MODAL_ID} .rmp-loader {
      position: absolute;
      inset: 0;

      z-index: 2;

      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;

      gap: 24px;

      background: #0b0b0b;
      color: #e5e5e5;

      pointer-events: none;

      transition:
        opacity 180ms ease;
    }

    #${MODAL_ID}
      .rmp-loader.rmp-loader-hidden {
      opacity: 0;
    }

    #${MODAL_ID} .rmp-loader-logo {
      width: var(--rmp-logo-size);
      height: var(--rmp-logo-size);

      display: grid;
      place-items: center;

      animation:
        rmp-logo-spin
        1.8s
        linear
        infinite;
    }

    #${MODAL_ID} .rmp-loader-logo svg {
      width: var(--rmp-logo-size) !important;
      height: var(--rmp-logo-size) !important;

      display: block !important;
      margin: 0 !important;
      flex: none;
    }

    #${MODAL_ID} .rmp-loader-text {
      min-width: 180px;

      text-align: center;

      font:
        14px/20px
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;

      color: #d7d7d7;
    }

    @keyframes rmp-logo-spin {
      from {
        transform: rotate(0deg);
      }

      to {
        transform: rotate(360deg);
      }
    }

  `;

  // Embedded flat-color logo for the modal loader.

  const LOGO_SVG = `
<svg viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <circle cx="128" cy="128" r="128" fill="#FF4500"></circle>
  <path d="M127.77 88.03C125.23 88.03 123.18 86.97 123.18 85.33C123.18 66.35 138.62 50.92 157.59 50.92C160.13 50.92 162.18 52.98 162.18 55.51C162.18 58.04 160.12 60.1 157.59 60.1C143.68 60.1 132.36 71.42 132.36 85.33C132.36 86.97 130.3 88.03 127.77 88.03Z" fill="#172E35"></path>
  <circle cx="174.81" cy="55.45" r="21.18" fill="#FFFFFF"></circle>
  <circle cx="55.44" cy="123.65" r="29.89" fill="#FFFFFF"></circle>
  <circle cx="200.56" cy="123.65" r="29.89" fill="#FFFFFF"></circle>
  <ellipse cx="128.07" cy="149.33" rx="85.33" ry="64" fill="#FFFFFF"></ellipse>
  <ellipse cx="88.4" cy="141.5" rx="15" ry="17" fill="#FF4500"></ellipse>
  <ellipse cx="167.7" cy="141.5" rx="15" ry="17" fill="#FF4500"></ellipse>
  <path d="M97.97 166.56C96.37 166.72 95.35 166.72 95.97 169.81C101.22 182.12 113.61 190.77 128.07 190.77C142.53 190.77 154.91 182.12 160.17 169.81C160.79 168.35 159.78 166.72 158.17 166.56C148.79 165.63 138.65 165.12 128.07 165.12C117.49 165.63 107.35 165.12 97.97 166.56Z" fill="#172E35"></path>
</svg>`;

  // Inline external-link icon.

  const NEW_TAB_ICON_SVG = `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path d="M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"></path>
  <path d="M11 13l9 -9"></path>
  <path d="M15 4h5v5"></path>
</svg>`;

  // ============================================================
  // MODAL
  // ============================================================

  function createModal(url) {
    const modal =
      document.createElement('div');

    modal.id = MODAL_ID;

    const windowElement =
      document.createElement('div');

    windowElement.className =
      'rmp-window';

    windowElement.setAttribute(
      'role',
      'dialog'
    );

    windowElement.setAttribute(
      'aria-modal',
      'true'
    );

    windowElement.setAttribute(
      'aria-label',
      'Reddit Reader'
    );

    const closeButton =
      document.createElement('button');

    closeButton.className =
      'rmp-close';

    closeButton.type =
      'button';

    closeButton.setAttribute(
      'aria-label',
      'Close Reddit reader'
    );

    closeButton.textContent =
      '×';

    const backButton =
      document.createElement('button');

    backButton.className =
      'rmp-back';

    backButton.type =
      'button';

    backButton.disabled =
      true;

    backButton.setAttribute(
      'aria-label',
      'Back to post'
    );

    backButton.title =
      'Back to post';

    backButton.textContent =
      '←';

    // Keep this as a real link for native tab and context-menu actions.
    const newTabLink =
      document.createElement('a');

    newTabLink.className =
      'rmp-newtab';

    newTabLink.href =
      url;

    newTabLink.target =
      '_blank';

    newTabLink.rel =
      'noopener';

    newTabLink.title =
      'Open in new tab';

    newTabLink.setAttribute(
      'aria-label',
      'Open post in new tab'
    );

    newTabLink.innerHTML =
      NEW_TAB_ICON_SVG;

    const body =
      document.createElement('div');

    body.className =
      'rmp-body';

    const loader =
      document.createElement('div');

    loader.className =
      'rmp-loader';

    const loaderLogo =
      document.createElement('div');

    loaderLogo.className =
      'rmp-loader-logo';

    // Static markup owned by this script.
    loaderLogo.innerHTML =
      LOGO_SVG;

    const loaderText =
      document.createElement('div');

    loaderText.className =
      'rmp-loader-text';

    loaderText.textContent =
      'Loading your post...';

    const iframe =
      document.createElement('iframe');

    const postId =
      extractPostId(
        new URL(url, location.href)
          .pathname
      ) || '';

    // Set the frame identity before attaching or navigating it.
    iframe.name =
      FRAME_NAME_PREFIX + postId;

    iframe.className =
      'rmp-iframe';

    iframe.title =
      'Reddit post';

    iframe.setAttribute(
      'scrolling',
      'auto'
    );

    loader.append(
      loaderLogo,
      loaderText
    );

    body.append(
      loader,
      iframe
    );

    windowElement.append(
      backButton,
      newTabLink,
      closeButton,
      body
    );

    modal.appendChild(
      windowElement
    );

    return {
      modal,
      backButton,
      closeButton,
      newTabLink,
      iframe,
      loader
    };
  }

  function openModal(url) {
    if (
      document.getElementById(MODAL_ID) ||
      !document.body
    ) {
      return;
    }

    const {
      modal,
      backButton,
      closeButton,
      newTabLink,
      iframe,
      loader
    } = createModal(url);

    document.body.appendChild(
      modal
    );

    const abortController =
      new AbortController();

    const { signal } =
      abortController;

    const previousOverflow =
      document.body.style.overflow;

    document.body.style.overflow =
      'hidden';

    let closed = false;
    let revealed = false;

    // Modal-owned stack; replace() avoids nested browser history.
    const modalHistory = [
      new URL(url, location.href).href
    ];

    const updateBackButton = () => {
      backButton.disabled =
        modalHistory.length === 1;
    };

    const modalGuardId =
      `rmp-${Date.now()}-${Math.random()}`;

    let modalGuardActive = false;

    const addModalHistoryGuard = () => {
      history.pushState(
        { rmpModalGuard: modalGuardId },
        '',
        location.href
      );

      modalGuardActive = true;
    };

    const navigateFrame = (href) => {
      newTabLink.href = href;

      try {
        iframe.contentWindow?.location.replace(
          href
        );
      } catch {
        // Fallback for cross-origin Reddit subdomains.
        iframe.src = href;
      }
    };

    const navigateModalBack = () => {
      if (modalHistory.length === 1) {
        return;
      }

      modalHistory.pop();
      updateBackButton();

      navigateFrame(
        modalHistory.at(-1)
      );
    };

    const revealFrame = () => {
      if (
        closed ||
        revealed
      ) {
        return;
      }

      revealed = true;

      requestAnimationFrame(() => {
        if (closed) {
          return;
        }

        iframe.classList.add(
          'rmp-loaded'
        );

        loader.classList.add(
          'rmp-loader-hidden'
        );

        setTimeout(
          () => {
            loader.remove();
          },
          180
        );
      });
    };

    const closeModal = () => {
      if (closed) {
        return;
      }

      closed = true;

      if (
        activeModalClose ===
        closeModal
      ) {
        activeModalClose = null;
      }

      abortController.abort();

      // Remove the temporary top-level history guard.
      if (modalGuardActive) {
        modalGuardActive = false;
        history.back();
      }

      document.body.style.overflow =
        previousOverflow;

      modal.remove();
    };

    activeModalClose =
      closeModal;

    // Route browser Back through the modal stack while it is open.
    // At the first post, Back closes the modal instead.
    window.addEventListener(
      'popstate',
      (event) => {
        if (
          event.state?.rmpModalGuard ===
          modalGuardId
        ) {
          modalGuardActive = true;
          return;
        }

        modalGuardActive = false;

        if (modalHistory.length > 1) {
          navigateModalBack();
          addModalHistoryGuard();
        } else {
          // The guard entry was consumed, so closeModal skips history.back().
          closeModal();
        }
      },
      { signal }
    );

    addModalHistoryGuard();

    closeButton.addEventListener(
      'click',
      closeModal,
      { signal }
    );

    backButton.addEventListener(
      'click',
      () => {
        if (backButton.disabled) {
          return;
        }

        navigateModalBack();
      },
      { signal }
    );

    newTabLink.addEventListener(
      'click',
      (event) => {
        if (!isPlainLeftClick(event)) {
          return;
        }

        event.preventDefault();

        openTab(
          newTabLink.href,
          false
        );

        closeModal();
      },
      { signal }
    );

    modal.addEventListener(
      'click',
      (event) => {
        if (
          event.target === modal
        ) {
          closeModal();
        }
      },
      { signal }
    );

    document.addEventListener(
      'keydown',
      (event) => {
        if (
          event.key === 'Escape'
        ) {
          closeModal();
        }
      },
      {
        capture: true,
        signal
      }
    );

    window.addEventListener(
      'message',
      (event) => {
        if (
          !isTrustedReaderMessage(event, iframe)
        ) {
          return;
        }

        if (
          event.data?.type === 'rmp-ready'
        ) {
          revealFrame();
          return;
        }

        if (
          event.data?.type === 'rmp-modal-navigate'
        ) {
          const nextUrl =
            getHttpUrl(event.data.href);

          if (!nextUrl) {
            return;
          }

          if (modalHistory.at(-1) === nextUrl.href) {
            return;
          }

          modalHistory.push(nextUrl.href);
          updateBackButton();

          navigateFrame(nextUrl.href);
        }
      },
      { signal }
    );

    iframe.addEventListener(
      'load',
      () => {
        if (closed) {
          return;
        }

        revealFrame();
      },
      { signal }
    );

    /*
     * iframe.name was already set at creation time, above. Only
     * the URL remains: the original, clean post URL.
     */
    iframe.src =
      url;
  }

  // ============================================================
  // TOP-LEVEL NAVIGATION MESSAGE BRIDGE
  // ============================================================

  function isTrustedReaderMessage(event, iframe) {
    let senderHost;

    try {
      senderHost =
        new URL(event.origin).hostname;
    } catch {
      return false;
    }

    return (
      isRedditHost(senderHost) &&
      event.source === iframe.contentWindow
    );
  }

  window.addEventListener(
    'message',
    (event) => {
      const data = event.data;

      if (
        !data ||
        (data.type !== 'rmp-navigate' &&
          data.type !== 'rmp-open-tab' &&
          data.type !== 'rmp-escape')
      ) {
        return;
      }

      const modal =
        document.getElementById(MODAL_ID);

      if (!modal) {
        return;
      }

      const iframe =
        modal.querySelector('.rmp-iframe');

      if (
        !iframe ||
        !isTrustedReaderMessage(event, iframe)
      ) {
        return;
      }

      if (data.type === 'rmp-escape') {
        activeModalClose?.();
        return;
      }

      const url =
        getHttpUrl(data.href);

      if (!url) {
        return;
      }

      if (data.type === 'rmp-open-tab') {
        // Keep the modal open while opening external links.
        openTab(
          url.href,
          true
        );

        return;
      }

      // Close before navigating the real tab.
      activeModalClose?.();

      window.location.assign(
        url.href
      );
    }
  );

  // ============================================================
  // REDDIT POST LINK DETECTION
  // ============================================================

  function isRedditPostLink(value) {
    const href =
      typeof value === 'string'
        ? value
        : value?.href;

    if (!href) {
      return false;
    }

    const url =
      getHttpUrl(href);

    // Only hosts where the reader script runs (see @match).
    if (
      !url ||
      url.protocol !== 'https:' ||
      !isModalHost(url.hostname)
    ) {
      return false;
    }

    return extractPostId(url.pathname) !== null;
  }

  // ============================================================
  // ENTRY POINT
  // ============================================================

  // Only reader iframes receive the frame-specific behavior.
  if (!IS_TOP) {
    if (IS_READER_FRAME) {
      installReaderFrame();
    }

    return;
  }

  addStyle(
    PARENT_STYLE_ID,
    PARENT_STYLE
  );

  // Notification rows navigate from the row itself, so intercept
  // them before Reddit's later click handler starts hybrid navigation.
  window.addEventListener(
    'pointerdown',
    (event) => {
      if (
        !isPlainLeftClick(event) ||
        getAnchorFromClick(event)
      ) {
        return;
      }

      if (
        document.getElementById(MODAL_ID)
      ) {
        return;
      }

      const href =
        getPostHrefFromClick(event);

      if (
        !isRedditPostLink(href)
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      openModal(href);
    },
    true
  );

  window.addEventListener(
    'click',
    (event) => {
      if (
        !isPlainLeftClick(event) ||
        isNativeMediaInteraction(event)
      ) {
        return;
      }

      const modal =
        document.getElementById(
          MODAL_ID
        );

      if (
        modal?.contains(
          event.target
        )
      ) {
        return;
      }

      const href =
        getPostHrefFromClick(event);

      if (
        !isRedditPostLink(
          href
        )
      ) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();

      openModal(
        href
      );
    },
    true
  );
})();