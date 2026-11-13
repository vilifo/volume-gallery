// The page script of set-password.html (it was an inline <script type="module"> there). Bundled by webpack.config.js.
import { api, setSession, postLoginUrl, getBranding, getCachedBranding, brandLogoHtml, contactItems, linkItems, escapeHtml } from "../js/api.js";

// The link an administrator gave you: /set-password.html#token=... (the token stays in the fragment, which the
// browser does not send anywhere). It is taken out of the address bar at once so it is not left in the history.
const token = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";
history.replaceState(null, "", window.location.pathname);

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
    document.title = `Set password \u2014 ${b.app_name}`;
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

const form = document.getElementById("pw-form");
const errorBox = document.getElementById("error");
const subtitle = document.getElementById("subtitle");
const fail = (message) => { errorBox.textContent = message; errorBox.style.display = "block"; };

(async () => {
  if (!token) { subtitle.textContent = ""; fail("This page needs the link an administrator gave you."); return; }
  try {
    const info = await api.checkPasswordLink(token);
    subtitle.textContent = info.purpose === "setup"
      ? `Welcome, ${info.username}. Choose a password to finish creating your account.`
      : `Hello, ${info.username}. Choose a new password.`;
    document.getElementById("username").value = info.username;
    form.hidden = false;
    document.getElementById("new-password").focus();
  } catch (err) {
    subtitle.textContent = "";
    fail(err.message);
  }
})();

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.style.display = "none";
  const password = document.getElementById("new-password").value;
  if (password !== document.getElementById("confirm-password").value) { fail("The passwords do not match."); return; }
  document.getElementById("save").disabled = true;
  try {
    const data = await api.setPasswordWithLink(token, password);
    setSession(data.access_token, data.role, data.username);
    window.location.href = postLoginUrl();
  } catch (err) {
    fail(err.message);
    document.getElementById("save").disabled = false;
  }
});
