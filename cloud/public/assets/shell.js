import { icon, wave } from "./icons.js";

const navigation = [
  "Overview",
  "Projects",
  "Agents",
  "Connections",
  "Evidence",
  "Recovery",
];
const button = (label, view, primary = false) =>
  `<button class="btn${primary ? " primary" : ""}" data-view="${view}">${label}${icon("arrow", true)}</button>`;
const heading = (text, view, extra = "") =>
  `<div class="panel-head"><h2 class="eyebrow">${text}${extra}</h2><button class="link-button" data-view="${view}">View all ${icon("arrow", true)}</button></div>`;
export function shell(login) {
  return `<header class="app-header"><a class="brand" href="/" aria-label="ASIP home"><img src="/assets/mark.svg" width="37" height="37" alt=""><span class="wordmark">ASIP</span><span class="tagline">CONTINUITY<br>FOR DEEP WORK</span></a><nav class="top-nav" aria-label="Main navigation">${navigation.map((name, i) => `<button data-view="${name.toLowerCase()}" class="${i ? "" : "selected"}"${i ? "" : ' aria-current="page"'}>${name}</button>`).join("")}</nav><div class="header-tools"><form class="global-search" id="global-search" role="search">${icon("search")}<input id="global-query" aria-label="Search projects, agents, or evidence" placeholder="Search projects, agents, or evidence…"><kbd>⌘ K</kbd></form><button class="icon-button" aria-label="Recent activity" data-view="evidence">${icon("bell")}<span class="notification-dot"></span></button><div class="account-wrap"><button class="account-button" id="account-toggle" aria-label="Account menu" aria-expanded="false">${login ? "↗" : "·"}</button><div class="account-menu" id="account-menu" hidden><strong id="account-name">Your ASIP account</strong><small id="account-handle" class="muted"></small><button data-view="settings">Account & API access</button><button data-view="billing">Subscription</button><button id="signout">Sign out</button></div></div><button class="icon-button mobile-menu" id="mobile-menu" aria-label="Open navigation" aria-expanded="false">${icon("menu")}</button></div></header>
  <main class="main-shell" id="main"><section class="system-strip" aria-label="Workspace status"><div class="system-health"><span class="live-dot"></span><div><strong id="system-status">${login ? "YOUR CONTINUITY STARTS HERE" : "CONNECTING YOUR WORKSPACE"}</strong><p id="system-description">${login ? "One private memory. Across every handoff." : "Loading your project memory…"}</p></div></div>${[
    ["project-total", login ? "∞" : "—", "Projects"],
    [
      "record-total",
      login ? "7 days" : "—",
      login ? "Free access" : "Project records",
    ],
    ["agent-total", login ? "3" : "—", login ? "Native agents" : "Agents"],
    ["device-total", login ? "Any" : "—", "Devices"],
    [
      "connection-total",
      login ? "1" : "—",
      login ? "Shared context" : "API connections",
    ],
  ]
    .map(
      ([id, n, label]) =>
        `<div class="stat"><strong id="${id}">${n}</strong><small>${label}</small></div>`,
    )
    .join(
      "",
    )}<div class="sync-summary"><span class="sync-ring">${icon("sync")}</span><div class="sync-meta"><span>${login ? "ASIP Cloud" : "Last refresh"}</span><strong id="last-sync">${login ? "Ready when you are" : "Waiting for cloud"}</strong><span id="sync-note">${login ? "Private by design" : "Your work stays with you"}</span></div>${login ? '<a class="btn primary" href="#signin">Start free trial ' + icon("arrow", true) + "</a>" : '<button class="btn primary" id="refresh">' + icon("sync") + "Refresh memory</button>"}</div></section><div id="error" class="alert" role="alert"></div><div id="access-notice" class="alert" hidden></div>
  <section data-panel="overview"><div class="hero-grid"><div class="hero-copy"><h1>Your work,<br>in continuous context.</h1><p>ASIP remembers the intent, the work, and the evidence across all your agents and devices. So you can pick up anywhere, on any machine, and keep moving forward.</p><div class="actions">${login ? '<a class="btn primary" href="#signin">Start 7 day free trial ' + icon("arrow", true) + "</a>" : button("Open project memory", "projects", true)}<button class="btn" id="how-button">${icon("play")}Watch how it works</button></div></div><div class="orb" aria-label="Project continuity"><div class="orb-art"></div><div class="orb-readout"><div class="eyebrow">PROJECT CONTINUITY</div><div class="orb-title" id="orb-title">${login ? "ALWAYS IN CONTEXT" : "SYNCHRONIZED"}</div><div class="orb-line"></div><div class="orb-count" id="orb-count">${login ? "One memory. Every handoff." : "Connecting your memory"}</div><div class="orb-meta" id="orb-meta">${login ? "Your projects · Your agents · Your devices" : "Your private cloud workspace"}</div>${wave()}</div></div>${login ? loginCard() : `<div class="agents-preview"><div class="panel-head"><h2 class="eyebrow">AGENTS & DEVICES <span class="count-badge" id="active-agents">—</span></h2><button class="link-button" data-view="agents">View all ${icon("arrow", true)}</button></div><div id="agent-previews"></div><div class="agent-manage"><button class="link-button" data-view="agents">${icon("grid", true)} Manage agents</button><a href="/download">Install on a new device&nbsp; →</a></div></div>`}</div>
  <section class="glass activity-stream" aria-label="Recent activity"><div class="stream-heading"><h2 class="eyebrow">${login ? "CONTINUITY, AT EVERY STEP" : "LIVE ACTIVITY STREAM"}</h2><p>${login ? "From the first intention to the next handoff." : "Recent continuity events across your agents, devices, and projects."}</p>${wave(94)}<span class="live-label"><span class="live-dot"></span>${login ? "Connected" : "Cloud"}</span><button class="btn compact" data-view="evidence">${login ? "Explore ASIP" : "View all events"} ${icon("arrow", true)}</button></div><div class="activity-items" id="activity-items"></div></section>
  <div class="dashboard-grid"><section class="glass projects-preview">${heading(login ? "YOUR ENTIRE WORKING CONTEXT" : 'YOUR PROJECTS <span id="project-count" class="count-badge">—</span>', "projects")}${
    login
      ? `<div class="login-benefits">${[
          [
            "network",
            "Every project, connected",
            "Plans, decisions, and outcomes stay together.",
          ],
          [
            "connect",
            "Across your AI agents",
            "Codex, Claude Code, and Antigravity.",
          ],
          [
            "shield",
            "Evidence you can trace",
            "Original sessions, source records, and hashes.",
          ],
        ]
          .map(
            ([i, t, p]) =>
              `<div class="benefit-row"><span class="activity-symbol green">${icon(i)}</span><div><strong>${t}</strong><small>${p}</small></div></div>`,
          )
          .join("")}</div>`
      : '<div class="project-tabs" aria-label="Project filter"><button class="selected" data-project-tab="recent">Recent</button><button data-project-tab="active">Active</button><button data-project-tab="pinned">Pinned</button></div><div id="project-previews"></div>'
  }</section><section class="glass spotlight">${heading("PROJECT SPOTLIGHT", "projects", '<span class="count-badge" id="spotlight-state">' + (login ? "YOUR NEXT HANDOFF" : "CLOUD MEMORY") + "</span>")}<div id="spotlight-body">${login ? `<div class="spotlight-project"><span class="project-avatar">A</span><div><h3>Pick up where you left off.</h3><p>Full context, before the next prompt.</p></div></div><p class="spotlight-description">Keep the original intent, the decisions, and the verified result. Your next agent starts with the story so far.</p><div class="recent-label">ONE DURABLE PROJECT MEMORY</div><div class="login-feature">Record with your native agent plugin.<br>Synchronize through Beacon.<br>Recall from your next session.</div><div class="actions"><a href="#signin" class="btn primary compact">Begin your free trial ${icon("arrow", true)}</a><a href="/download" class="btn compact">Get Beacon ${icon("device", true)}</a></div>` : '<p class="empty">Loading your most recent project…</p>'}</div></section>${continuity(login)}</div>
  <div class="bottom-grid"><section class="glass how-panel" id="how"><h2 class="eyebrow">HOW ASIP KNOWS</h2><div class="how-steps">${[
    [
      "network",
      "CAPTURE",
      "Agents, devices, and APIs produce activity, conversations, code, and artifacts.",
    ],
    [
      "file",
      "UNDERSTAND",
      "ASIP preserves intent, entities, decisions, and relationships across sources.",
    ],
    [
      "connect",
      "CONNECT",
      "Everything is linked into a unified project memory with provenance.",
    ],
    [
      "database",
      "REMEMBER",
      "Return anytime with full context, evidence, and a verifiable history.",
    ],
  ]
    .map(
      ([i, t, p], n) =>
        `<div class="how-step"><span class="how-icon">${icon(i)}</span><div><strong>${n + 1}&nbsp; ${t}</strong><p>${p}</p></div>${n < 3 ? icon("chevron") : ""}</div>`,
    )
    .join(
      "",
    )}</div></section><section class="glass evidence-preview">${heading("EVIDENCE & PROVENANCE", "evidence")}<div id="evidence-previews">${login ? '<p class="login-feature">The original record. The native session.<br>The evidence behind every outcome.</p><a class="link-button" href="/api">Explore the agent API ' + icon("arrow", true) + "</a>" : ""}</div></section></div></section>
  ${pages()}<footer class="page-footer"><span>ASIP · CONTINUITY FOR DEEP WORK</span><div><a href="/download">Beacon</a><a href="/api">API & MCP</a><a href="/privacy">Privacy</a><button class="link-button" data-view="billing">CA$12 / month</button><a href="https://github.com/M-o-liver/asip-linux">Source ↗</a></div></footer></main>
  <dialog class="detail-dialog" id="record-dialog"><div class="dialog-head"><span class="eyebrow">SOURCE & EVIDENCE</span><button class="icon-button" id="close-record" aria-label="Close evidence">${icon("close")}</button></div><h2 id="evidence-title"></h2><dl id="record-facts"></dl><div class="actions"><a class="btn compact" id="source-download" download>Download source ${icon("file", true)}</a><button class="btn compact" id="verify-source">${icon("shield", true)}Verify source</button></div><p id="verification-status" class="selected-note" role="status"></p><details><summary>Recorded evidence</summary><pre id="record-data"></pre></details></dialog>
  <dialog class="detail-dialog" id="how-dialog"><div class="dialog-head"><span class="eyebrow">YOUR NEXT SESSION, ALREADY IN CONTEXT</span><button class="icon-button" id="close-how" aria-label="Close how it works">${icon("close")}</button></div><h2>One project. Every handoff.</h2><p class="login-feature">1. Sign in and install Beacon on your computer.<br><br>2. Connect your native Codex, Claude Code, or Antigravity plugin. Your agents record intent, work, and evidence locally.<br><br>3. Connect cloud to synchronize your project memory. Open ASIP on another device or ask your next agent to recall the project.<br><br>Your original sessions, evidence, and source hashes stay connected.</p><div class="actions"><a class="btn primary" href="/download">Download Beacon ${icon("arrow", true)}</a><a class="btn" href="/api">Agent API</a></div></dialog><div class="toast" id="toast" role="status" hidden></div>`;
}
function loginCard() {
  return `<div class="login-card-wrap"><section class="login-card" id="signin" aria-labelledby="signin-title"><span class="eyebrow">ENTER YOUR WORKSPACE</span><h2 id="signin-title">Welcome to ASIP.</h2><p>Your work continues here.</p><a class="oauth-button" data-provider="github" href="/auth/github">${icon("github")}Continue with GitHub</a><a class="oauth-button" data-provider="google" href="/auth/google">${icon("google")}Continue with Google</a><button class="btn primary" id="start-trial">Start 7 day free trial ${icon("arrow", true)}</button><p class="trial-detail">No card required · Then CA$12/month</p><a class="owner-login" href="/auth/access">Existing preview account</a><p id="signin-status" class="trial-detail" role="status"></p></section></div>`;
}
function continuity(login) {
  return `<section class="glass continuity"><h2 class="eyebrow">CONTINUITY ACROSS DEVICES</h2><div class="continuity-map"><div class="orbit-ring"></div><div class="map-line"></div><div class="map-line horizontal"></div><div class="map-core"><img src="/assets/sigil.svg" alt=""><span>ASIP</span></div><div class="map-node top"><span class="node-symbol">${icon("cloud")}</span><div>Cloud Workspace<small id="map-cloud-records">${login ? "One private memory" : "— records"}</small></div></div><div class="map-node left"><span class="node-symbol">${icon("device")}</span><span id="map-device-one">${login ? "Your computer" : "Connect Beacon"}</span><small id="map-agent-one">${login ? "Your native agents" : "Local recording"}</small><small id="map-time-one">${login ? "Record locally" : "Offline first"}</small></div><div class="map-node right"><span class="node-symbol">${icon("device")}</span><span id="map-device-two">${login ? "Your next device" : "Your next device"}</span><small id="map-agent-two">${login ? "Your next session" : "Same project memory"}</small><small id="map-time-two">${login ? "Continue anywhere" : "Continue anywhere"}</small></div><div class="map-node bottom"><span class="node-symbol">${icon("database")}</span><span>APIs</span><small id="map-apis">${login ? "Connected context" : "— connected"}</small></div></div></section>`;
}
const title = (eyebrow, name, copy, action = "") =>
  `<div class="view-title"><div><span class="eyebrow">${eyebrow}</span><h1>${name}</h1><p>${copy}</p></div>${action}</div>`;
function pages() {
  return `<section class="view-page" data-panel="projects" hidden>${title("YOUR PROJECT MEMORY", "Projects", "The intent, the work, and the evidence. Together.", '<a class="btn" href="/download">' + icon("device", true) + "Connect a computer</a>")}<div class="filter-bar"><input type="search" id="project-query" aria-label="Filter projects" placeholder="Find a project…"><button class="btn" data-action="all-memory">All project memory ${icon("arrow", true)}</button></div><div id="project-directory" class="management-grid"></div></section>
  <section class="view-page" data-panel="agents" hidden>${title("AGENTS & DEVICES", "Your connected world", "Native agents, original sessions, and the devices carrying your work.", '<a class="btn primary" href="/download">Install Beacon ' + icon("arrow", true) + "</a>")}<div class="management-grid" id="agent-directory"></div><h2 class="eyebrow welcome">COMPUTERS & CLOUD CONNECTIONS</h2><div class="management-grid" id="device-directory"></div><h2 class="eyebrow welcome">RECENT AGENT SESSIONS</h2><section class="glass form-panel" id="sessions"></section></section>
  <section class="view-page" data-panel="connections" hidden>${title("YOUR API CONNECTIONS", "Connected context", "Named API connections synchronized from your devices. Manage provider access in Beacon.", button("Agent API access", "settings", true))}<div id="connection-directory" class="management-grid"></div><p class="muted login-feature">Provider credentials stay in your device’s OS keychain. Use its Beacon for provider requests.</p></section>
  <section class="view-page" data-panel="evidence" hidden>${title("WORK, WITH PROVENANCE", '<span id="history-title">Evidence & memory</span>', '<span id="history-description">Return to the original record, agent session, and supporting evidence.</span>', '<button class="btn" id="history-refresh">' + icon("sync", true) + "Refresh history</button>")}<div class="view-grid"><section class="glass"><form id="history-search" class="filter-bar"><input type="search" id="query" aria-label="Search work and evidence" placeholder="Search work and evidence…"><select id="kind" aria-label="Record category"><option value="work">Work & outcomes</option><option value="all">All records</option><option value="intent">Intent</option><option value="results">Results & evidence</option><option value="failures">Failures & unresolved</option></select><select id="agent" aria-label="Agent"><option value="">Every agent</option><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="antigravity">Antigravity</option></select><button class="btn primary" type="submit">Search</button></form><div id="history-scope" class="session-filter" hidden><span id="scope-label" class="selected-note"></span> <button class="link-button" id="clear-scope">Clear filter ×</button></div><div id="events"></div><div class="history-pagination"><button id="previous" class="btn compact">← Newer</button><span id="page">Page 1</span><button id="next" class="btn compact">Older →</button></div></section><aside><section class="glass form-panel"><h2>Source & evidence</h2><p>Open any record to inspect the original session, recorded data, and SHA-256 source hash.</p><div class="how-icon">${icon("shield")}</div><p id="history-count"></p></section><section class="glass form-panel"><h2>Connected projects</h2><div id="relationships"></div></section></aside></div></section>
  <section class="view-page" data-panel="recovery" hidden>${title("CONTINUITY YOU CAN RETURN TO", "Recovery", "Your cloud history preserves original records. Local checkpoints belong to each computer.")}<div class="recovery-grid"><article class="glass">${icon("cloud")}<h2>Your cloud memory</h2><p id="recovery-summary">Your synchronized history is retained with its source evidence and original identity.</p>${button("Open recorded history", "evidence", true)}</article><article class="glass">${icon("shield")}<h2>Verify the original.</h2><p>Open an evidence record to download its canonical source and verify its SHA-256 hash against the cloud record.</p>${button("Inspect evidence", "evidence")}</article><article class="glass">${icon("device")}<h2>Recover on your device.</h2><p>Open Beacon → Recovery on the computer you want to recover. Local checkpoints restore ASIP history. They do not restore repository or operating-system files.</p><a class="btn" href="/download">Get Beacon ${icon("arrow", true)}</a></article></div></section>
  <section class="view-page" data-panel="billing" hidden>${title("YOUR ASIP SUBSCRIPTION", "Keep your context moving.", "7 days to make ASIP part of your workflow. One simple plan after.")}<div class="billing-layout"><div class="billing-copy"><h2>Every agent.<br>Every device.<br>One continuous memory.</h2><p>Cloud memory, project recall, evidence, API access, and cross-device continuity — together in ASIP Cloud.</p><p id="billing-state" role="status">Loading your subscription…</p><p id="billing-message" role="status"></p></div><section class="glass billing-card"><span class="eyebrow">ASIP CLOUD</span><div class="plan-price">CA$12<small> / month</small></div><span class="pill" id="billing-badge">7 day free trial</span><ul class="plan-features"><li>Synchronized projects & cloud memory</li><li>Codex, Claude Code & Antigravity</li><li>Original evidence & source verification</li><li>Cross-device continuity</li><li>HTTP & MCP agent access</li></ul><button class="btn primary" id="subscribe">Subscribe to ASIP Cloud ${icon("arrow", true)}</button><button class="btn" id="manage-billing" hidden>Manage subscription ${icon("arrow", true)}</button><p class="muted" id="billing-terms">No card needed for your trial. Subscription payments are handled securely by Stripe. Cancel in your billing portal.</p></section></div></section>
  <section class="view-page" data-panel="settings" hidden>${title("YOUR ACCOUNT & API ACCESS", "Make ASIP yours.", "Your workspace address and scoped connections for external agents.")}<div class="settings-grid"><section class="glass form-panel"><h2>Your workspace</h2><form id="profile"><label class="field">Display name<input id="profile-name" required maxlength="200" autocomplete="name"></label><label class="field">Workspace handle<input id="profile-handle" required pattern="[a-z0-9][a-z0-9_-]{2,39}" minlength="3" maxlength="40" autocomplete="off"><small>asip.ca/users/<span id="profile-preview"></span></small></label><button class="btn primary" type="submit">Save account</button><p id="profile-status" role="status"></p></form><div class="actions" id="identity-links"></div></section><section class="glass form-panel"><h2>Connect an external agent</h2><p>Create revocable access to your cloud memory. Credentials expire after 90 days. Read access is the default.</p><form id="token-form"><label class="field">Connection name<input id="token-label" required maxlength="120" placeholder="My project assistant"></label><label class="field">Agent<select id="token-agent"><option value="codex">Codex</option><option value="claude-code">Claude Code</option><option value="antigravity">Antigravity</option><option value="http">HTTP client</option></select></label><label class="field">Project access<select id="token-projects" multiple aria-label="Allowed projects"></select><small>Leave empty to allow all your projects. Hold Ctrl or ⌘ to select several.</small></label><label class="check-field"><input type="checkbox" id="token-write">Allow this agent to record work</label><button class="btn primary" type="submit">Create API connection</button></form><div class="token-result" id="token-result" hidden><p>Copy this credential now. It is shown once.</p><input id="token-value" readonly aria-label="New API credential"><div class="actions"><button class="btn compact" id="copy-token">Copy credential</button><button class="btn compact" id="check-token">Check connection</button></div><p id="token-check-status" role="status"></p></div></section></div><section class="glass form-panel"><h2>External agent connections</h2><div id="tokens"></div></section></section>`;
}
