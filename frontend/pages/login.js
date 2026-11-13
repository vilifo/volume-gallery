// The page script of login.html (it was an inline <script type="module"> there). Bundled by webpack.config.js.
import { api, setSession, getToken, postLoginUrl, getBranding, getCachedBranding, brandLogoHtml, contactItems, linkItems, escapeHtml } from "../js/api.js";

if (getToken()) window.location.href = postLoginUrl();

// Name, logo, copyright and contact details come from the server's branding.toml.
// Drawn from the cached copy at once (no flash of the defaults), then refreshed from the
// server; the page is only touched again if something actually changed. On the very first
// visit the brand and footer stay invisible until the branding arrives.
let paintedSig = null;
function paintBranding(b) {
  const html = {
    logos: brandLogoHtml(b, "login-logo"),
    footer: [
      b.copyright ? `<div>${escapeHtml(b.copyright)}</div>` : "",
      contactItems(b).length ? `<div class="login-contact">${contactItems(b).join("")}</div>` : "",
      linkItems(b).length ? `<div class="login-contact">${linkItems(b).join("")}</div>` : "",
    ].join(""),
  };
  const sig = JSON.stringify([b.app_name, b.tagline, html]);
  if (sig !== paintedSig) {
    paintedSig = sig;
    document.title = `Sign in \u2014 ${b.app_name}`;
    document.getElementById("app-name").textContent = b.app_name;
    document.getElementById("tagline").textContent = b.tagline;
    document.getElementById("brand-logos").innerHTML = html.logos;
    document.getElementById("login-footer").innerHTML = html.footer;
  }
  document.querySelectorAll("[data-pending]").forEach((el) => el.removeAttribute("data-pending"));
}
const cachedBranding = getCachedBranding();
if (cachedBranding) paintBranding(cachedBranding);
getBranding().then(paintBranding);

const form = document.getElementById("login-form");
const errorBox = document.getElementById("error");

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.style.display = "none";
  const username = document.getElementById("username").value.trim();
  const password = document.getElementById("password").value;
  try {
    const data = await api.login(username, password);
    setSession(data.access_token, data.role, data.username);
    window.location.href = postLoginUrl();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.style.display = "block";
  }
});
