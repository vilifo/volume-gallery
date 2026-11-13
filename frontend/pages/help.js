// The page script of help.html (it was an inline <script type="module"> there). Bundled by webpack.config.js.
import { requireLogin, getRole, getUsername, renderShell, wireLogout, getBranding, contactItems } from "../js/api.js";
import { helpPageHtml, wireHelpPage } from "../js/help.js";

requireLogin();
const role = getRole();

document.getElementById("shell").innerHTML = `
  ${renderShell("help", role, getUsername())}
  <main class="help-page">
    <h1>Help</h1>
    <p class="subtitle">How to use the gallery. What you see depends on your role (<strong>${role}</strong>).</p>
    <div id="help-root"><p class="dim">Loading\u2026</p></div>
    <p class="help-footnote">Short notes at the top of the pages link here. Hidden one?
      <button type="button" class="link-btn" data-show-hints>Show the page notes again</button></p>
  </main>
`;
wireLogout();

const branding = await getBranding();
const root = document.getElementById("help-root");
root.innerHTML = helpPageHtml({ role, branding, contactItems: contactItems(branding) });
wireHelpPage(document.querySelector("main"));
