// The page script of admin.html (it was an inline <script type="module"> there). Bundled by webpack.config.js.
import { api, requireLogin, getRole, getUsername, renderShell, wireLogout, passwordLinkUrl } from "../js/api.js";
import { pageHint } from "../js/help.js";

requireLogin();
const role = getRole();
if (role !== "admin") window.location.href = "/index.html";

document.getElementById("shell").innerHTML = `
  ${renderShell("admin", role, getUsername())}
  <main>
    <div class="toolbar">
      <h1>Users</h1>
      <button class="primary" id="new-user-btn">Add user</button>
    </div>
    ${pageHint("admin", role)}
    <div id="error" style="display:none" class="error-box"></div>
    <table class="responsive">
      <thead><tr><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
      <tbody id="users-body"></tbody>
    </table>
  </main>
  <div id="modal-root"></div>
`;
wireLogout();

const me = getUsername();

async function load() {
  let users;
  try {
    users = await api.listUsers();
  } catch (err) {
    document.getElementById("error").textContent = err.message;
    document.getElementById("error").style.display = "block";
    return;
  }
  document.getElementById("users-body").innerHTML = users
    .map(
      (u) => `
    <tr>
      <td>${escapeHtml(u.username)}</td>
      <td><span class="pill ${u.role}">${u.role}</span></td>
      <td>${u.disabled ? '<span class="dim">disabled</span>' : u.pending ? '<span class="dim" title="No password yet: the user has to open the link they were given">waiting for password</span>' : '<span style="color:var(--ok)">active</span>'}</td>
      <td class="row-actions">
        ${
          u.username === me
            ? '<span class="dim" style="font-size:0.85em">(you)</span>'
            : `
          <select data-role="${u.id}">
            ${["reader", "editor", "admin"]
              .map((r) => `<option value="${r}" ${r === u.role ? "selected" : ""}>${r}</option>`)
              .join("")}
          </select>
          <button data-toggle="${u.id}" data-disabled="${u.disabled}">${u.disabled ? "Enable" : "Disable"}</button>
          ${u.disabled ? "" : `<button data-reset="${u.id}">${u.pending ? "New setup link" : "Reset password"}</button>`}
          <button class="danger" data-delete="${u.id}">Delete</button>
          `
        }
      </td>
    </tr>`
    )
    .join("");

  document.querySelectorAll("[data-role]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      await api.updateUser(sel.dataset.role, { role: sel.value });
      load();
    });
  });
  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const disabled = btn.dataset.disabled === "true";
      await api.updateUser(btn.dataset.toggle, { disabled: !disabled });
      load();
    });
  });
  document.querySelectorAll("[data-reset]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const target = users.find((u) => String(u.id) === btn.dataset.reset);
      const name = target ? target.username : "this user";
      if (!confirm(target?.pending
        ? `Make a new setup link for ${name}? The earlier link stops working.`
        : `Make a password reset link for ${name}? Their current password keeps working until they use the link. Any earlier link stops working.`)) return;
      try {
        showLink(await api.createPasswordLink(btn.dataset.reset), "Password link");
        load();
      } catch (err) {
        document.getElementById("error").textContent = err.message;
        document.getElementById("error").style.display = "block";
      }
    });
  });
  document.querySelectorAll("[data-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this user? This cannot be undone.")) return;
      await api.deleteUser(btn.dataset.delete);
      load();
    });
  });
}

document.getElementById("new-user-btn").addEventListener("click", () => {
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" id="backdrop">
      <div class="modal">
        <h2>Add user</h2>
        <div id="modal-error" style="display:none" class="error-box"></div>
        <div class="field">
          <label for="nu-username">Username</label>
          <input id="nu-username" required />
        </div>
        <p class="dim">The account is created without a password. You get a one-time link to give to the user, who sets the password themselves.</p>
        <div class="field">
          <label for="nu-role">Role</label>
          <select id="nu-role">
            <option value="reader">reader</option>
            <option value="editor">editor</option>
            <option value="admin">admin</option>
          </select>
        </div>
        <div class="modal-actions">
          <button id="nu-cancel">Cancel</button>
          <button class="primary" id="nu-save">Create</button>
        </div>
      </div>
    </div>
  `;
  document.getElementById("nu-cancel").addEventListener("click", () => {
    document.getElementById("modal-root").innerHTML = "";
  });
  document.getElementById("nu-save").addEventListener("click", async () => {
    const username = document.getElementById("nu-username").value.trim();
    const userRole = document.getElementById("nu-role").value;
    try {
      const made = await api.createUser({ username, role: userRole });
      load();
      showLink(made, "User created");
    } catch (err) {
      const box = document.getElementById("modal-error");
      box.textContent = err.message;
      box.style.display = "block";
    }
  });
});

// The one-time link for a new account or a password reset. It is shown only now: the server keeps just a hash.
function showLink(made, title) {
  const url = passwordLinkUrl(made.token);
  const until = new Date(made.expires_at).toLocaleString();
  const what = made.purpose === "setup" ? "set their password and sign in" : "choose a new password";
  document.getElementById("modal-root").innerHTML = `
    <div class="modal-backdrop" id="backdrop">
      <div class="modal">
        <h2>${escapeHtml(title)}</h2>
        <p class="dim">Give this link to <strong>${escapeHtml(made.user.username)}</strong>. They open it to ${what}.
          It can be used once and works until ${escapeHtml(until)}. It is not shown again: make a new one if it gets lost.</p>
        <div class="field">
          <input id="pl-url" readonly value="${escapeHtml(url)}" aria-label="Link" />
        </div>
        <div class="modal-actions">
          <button id="pl-copy">Copy link</button>
          <button class="primary" id="pl-close">Done</button>
        </div>
      </div>
    </div>
  `;
  const input = document.getElementById("pl-url");
  input.addEventListener("focus", () => input.select());
  document.getElementById("pl-copy").addEventListener("click", async (e) => {
    try {
      await navigator.clipboard.writeText(url);
      e.target.textContent = "Copied";
    } catch (_) {
      input.select(); // no clipboard access (plain HTTP): the link is selected, Ctrl+C does the rest
    }
  });
  document.getElementById("pl-close").addEventListener("click", () => { document.getElementById("modal-root").innerHTML = ""; });
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

load();
