///////////////////////////////////////////////////////////////////////////////
// Copyright (C) 2026 Jean-Philippe Steinmetz
// SPDX-License-Identifier: MPL-2.0
///////////////////////////////////////////////////////////////////////////////
import { APPEARANCE_STYLE_ID } from "./theme.js";
import { APPEARANCE_CACHE_KEY } from "./appearanceCache.js";

/**
 * The inline script the page layouts put in `<head>`, after the stylesheets and before the body, so the user's theme is in place before
 * the first paint. It runs before any of this app's code and must not depend on it, which is why it is a plain ES5 string:
 *
 * - it reads the cache `AppearanceProvider` keeps in `localStorage` (`appearanceCache.ts`): finished stylesheet text, the mode, the key
 * of the preferences they were made from and the time they were last changed (`t`);
 * - it does nothing when the cache belongs to another account (`<html data-uid>` names the signed-in one, when the page knows it), or
 * when the server already rendered a stylesheet (`<style data-key data-t>`) for *different* preferences that are at least as new: the
 * server's copy can be a minute old, so it only wins when it is not older than the browser's;
 * - otherwise it puts the cached stylesheet in the page (replacing the server's, which for the same preferences lacks the measured
 * lightness of the background image), or removes the server's when the cache says nothing is chosen, and sets `<html data-theme>` for
 * an explicit "Light" or "Dark" (removing it for "System", whose stylesheet follows the operating system by media query).
 *
 * Any failure (storage blocked, bad JSON) leaves the page as it was.
 */
export const APPEARANCE_BOOT_SCRIPT =
    "(function(){try{" +
    `var c=JSON.parse(localStorage.getItem("${APPEARANCE_CACHE_KEY}")||"null"),d=document,h=d.documentElement;` +
    'if(!c||c.v!==1||typeof c.css!=="string"||typeof c.key!=="string")return;' +
    'var u=h.getAttribute("data-uid");if(u&&c.uid&&u!==c.uid)return;' +
    `var s=d.getElementById("${APPEARANCE_STYLE_ID}");` +
    'if(s&&s.getAttribute("data-key")!==c.key&&Number(s.getAttribute("data-t")||0)>=(c.t||0))return;' +
    "if(c.css){" +
    `if(!s){s=d.createElement("style");s.id="${APPEARANCE_STYLE_ID}";d.head.appendChild(s)}` +
    's.setAttribute("data-key",c.key);s.textContent=c.css' +
    "}else if(s){s.parentNode.removeChild(s)}" +
    'if(c.mode==="light"||c.mode==="dark")h.setAttribute("data-theme",c.mode);else h.removeAttribute("data-theme")' +
    "}catch(e){}})();";
