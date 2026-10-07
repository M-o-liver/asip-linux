(() => {
  const pending = new Map();
  const eventListeners = new Set();

  window.ASIPNative = {
    receive(message) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) entry.resolve(message.result);
      else {
        const reason = message.error?.message || "Desktop request failed";
        window.ASIPWorkspace.error(reason);
        entry.reject(new Error(reason));
      }
    },
    event(message) {
      eventListeners.forEach(listener => listener(message));
    },
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    call(method, params = {}) {
      const id = `desktop-${crypto.randomUUID()}`;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        window.webkit.messageHandlers.asip.postMessage({ id, method, params });
      });
    }
  };

  const text = (value) => String(value ?? "");
  const escape = (value) => text(value).replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]);

  let latestCore = null;
  let coreSerial = 0;
  let changeFilter = null;
  let historyBefore = null;
  let detailSerial = 0;
  let turnBusy = false;
  let loginBusy = false;
  let aiConnected = false;
  window.addEventListener('asip:navigation', () => { detailSerial++; });
  window.addEventListener('unhandledrejection', event => { window.ASIPWorkspace.error(event.reason?.message || 'Action failed'); });
  async function actionDialog(title, initial=null) {
    const dialog=document.getElementById('action-dialog');
    document.getElementById('dialog-title').textContent=title;
    document.getElementById('dialog-input-label').hidden=initial===null;
    document.getElementById('dialog-input').value=initial || '';
    dialog.returnValue='cancel';
    const closed=new Promise(resolve=>dialog.addEventListener('close',()=>resolve(dialog.returnValue==='confirm' ? (initial===null ? true : document.getElementById('dialog-input').value) : null),{once:true}));
    dialog.showModal();
    if(initial!==null) document.getElementById('dialog-input').focus();
    return closed;
  }
  function renderHistory(rows, append=false) {
    const list=document.getElementById('changes-list');
    if (!append) list.innerHTML=changeFilter ? `<p class="filter-note">Showing ${escape(changeFilter)} changes · <button class="quiet" id="clear-change-filter">Show all</button></p>` : '';
    list.querySelector('#load-history')?.remove();
    list.insertAdjacentHTML('beforeend', rows.length ? rows.map(change=>`<button type="button" class="change-row" data-change-id="${escape(change.change_id)}"><span class="row-main"><strong>${escape(change.intent || 'Untitled change')}</strong><span class="row-secondary">${escape(changeSecondary(change)).slice(0,320)}</span></span><span class="row-status">${escape(change.status)}</span></button>`).join('') : '<p class="empty">No matching changes.</p>');
    if(historyBefore) list.insertAdjacentHTML('beforeend','<button class="quiet" id="load-history">Older changes</button>');
  }
  async function loadHistory(append=false) {
    const filter=changeFilter;
    const page=await window.ASIPNative.call('change.list',{status:filter || 'all', before:append ? historyBefore : null});
    if(filter!==changeFilter) return;
    historyBefore=page.before;
    renderHistory(page.changes || [],append);
  }
  function renderMessages(data) {
    clearConversation(data.history_error || (data.truncated ? 'Showing the newest 100 messages.' : 'Saved conversation.'));
    const area=document.getElementById('conversation');
    for(const message of data.messages || data.conversation?.messages || []) {
      area.insertAdjacentHTML('beforeend',message.role==='user' ? `<div class="user-message"><small>You asked</small><p>${escape(message.text)}</p></div>` : `<div class="agent-message"><span class="agent-mark">A</span><div><strong>ASIP</strong><span class="work-status">${escape(message.state || '')}</span><p class="agent-response">${escape(message.text)}</p></div></div>`);
    }
  }


  function applyTheme(theme, persist = false) {
    theme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    const button = document.getElementById("theme-toggle");
    if (button) {
      const light = theme === "light";
      button.textContent = light ? "☾ Dark" : "☼ Light";
      button.setAttribute("aria-label", light ? "Switch to dark mode" : "Switch to light mode");
    }
    if (persist) window.ASIPNative.call("appearance.theme", { theme }).catch(console.error);
  }

  function changeSecondary(change) {
    if (change.outcome) return change.outcome;
    if (change.status === "open") return "In progress";
    if (change.status === "held") return change.hold?.reason || "Waiting for a recorded condition";
    if (change.status === "failed") return "Failed";
    if (change.status === "superseded") return "Superseded";
    if (change.status === "abandoned") return "Abandoned";
    return "";
  }

  function selectTab(tab, persist = true) {
    window.ASIPWorkspace.select(tab);
    if (persist) window.ASIPNative.call("navigation.select", { tab }).catch(console.error);
  }

  function renderConversations(data) {
    const items = data?.conversations || [];
    const activeId = data?.active_id || "";
    const selected = items.find(item => item.id === activeId);
    document.getElementById("recent-conversations").innerHTML = items.length ? items.slice(0, 12).map(item => `<button type="button" class="recent-conversation${item.id === activeId ? " active" : ""}" data-conversation-id="${escape(item.id)}"><strong>${escape(item.title || "Conversation")}</strong><small>${escape(item.provider === "google" ? "Google Gemini" : item.provider === "chatgpt" ? "ChatGPT" : "Saved conversation")}</small></button>`).join("") : '<p class="sidebar-empty">Your conversations will appear here.</p>';
    const trigger = document.getElementById("conversation-trigger");
    const popover = document.getElementById("conversation-popover");
    if (!trigger || !popover) return;
    trigger.firstChild.textContent = `${selected?.title || "Quick Ask"} `;
    const recent = items.filter(item => !item.kept);
    const kept = items.filter(item => item.kept);
    const itemMarkup = item => `<button type="button" class="conversation-item${item.id === activeId ? " active" : ""}" role="menuitem" data-conversation-id="${escape(item.id)}"><span>${item.id === activeId ? "●" : "○"}</span><strong>${escape(item.title || "Conversation")}</strong><small>${item.turns ? `${escape(item.turns)} turn${item.turns === 1 ? "" : "s"}` : "New"}</small></button>`;
    const group = (label, values) => values.length ? `<p class="conversation-group-label">${label}</p>${values.map(itemMarkup).join("")}` : "";
    popover.innerHTML = `<button type="button" class="conversation-item fresh" role="menuitem" data-conversation-action="new"><span>＋</span><strong>New conversation</strong><small>Fresh context, same computer</small></button>${group("Recent", recent)}${group("Kept", kept)}${selected ? `<div class="conversation-menu-actions"><button type="button" class="quiet compact" data-conversation-action="rename">Rename</button><button type="button" class="quiet compact" data-conversation-action="${selected.kept ? "unkeep" : "keep"}">${selected.kept ? "Unkeep" : "Keep"}</button><button type="button" class="quiet compact danger" data-conversation-action="forget">Forget</button></div>` : ""}`;
    trigger.setAttribute("aria-label", selected ? `Conversation: ${selected.title || "Conversation"}` : "Start a quick ask");
  }

  function clearConversation(message = "Fresh conversation. Same computer.") {
    const conversation = document.getElementById("conversation");
    const connect = document.getElementById("connect-ai");
    conversation.innerHTML = `<div class="welcome-card"><span class="agent-mark">A</span><div><strong>Let’s get to work.</strong><p id="welcome-status">${escape(message)}</p></div></div>`;
    if (connect) conversation.append(connect);
    document.getElementById("conversation-continuity").textContent = message;
  }

  async function refreshConversations() {
    const data = await window.ASIPNative.call("conversation.list");
    renderConversations(data);
    return data;
  }

  function renderCore(core) {
    latestCore = core;
    const connection = document.querySelector(".connection");
    const label = document.getElementById("connection-label");
    const welcome = document.getElementById("welcome-status");
    document.getElementById("topbar-status").textContent = core?.available ? "Connected to this computer" : "Core unavailable";
    if (!core?.available) {
      connection.classList.remove("ready");
      label.textContent = "Core unavailable";
      document.getElementById("core-status").textContent = "Unavailable";
      if (welcome) welcome.textContent = core?.message || "ASIP is not ready on this computer.";
      for(const id of ['computer-metrics','attention-list','current-work','question-list','authority-list','continuity-state','health-state','changes-list']) document.getElementById(id).innerHTML='<p>Core unavailable. Retry connection to load current state.</p>';
      return;
    }
    if(Object.keys(core.errors || {}).length) window.ASIPWorkspace.error(Object.values(core.errors).join('; '));
    connection.classList.add("ready");
    label.textContent = `ASIP ${core.summary?.version || "ready"}`;
    if (welcome) welcome.textContent = "Ask naturally. Your computer’s history stays connected.";
    const healthy=core.health?.status==='ok' && core.health?.product?.match!==false && !Object.keys(core.errors || {}).length;
    document.getElementById("core-status").textContent = healthy ? 'Healthy' : 'Needs inspection';

    historyBefore=core.changes_before;
    if(!changeFilter) renderHistory(core.changes || []);
    else loadHistory().catch(error=>window.ASIPWorkspace.error(error.message));
    const statistics = core.summary?.statistics || {};
    const blocking = core.brief?.blocking || {};
    document.getElementById("computer-metrics").innerHTML = [
      [statistics.completed_changes ?? 0, "Completed changes", "finished"],
      [blocking.open ?? 0, "Open changes", "open"],
      [blocking.held ?? 0, "Held", "held"],
      [statistics.verification_pass ?? 0, "Verified", "verification"],
    ].map(([value, labelText, action]) => `<button type="button" class="metric interactive" data-computer-action="${action}"><strong>${escape(value)}</strong><span>${escape(labelText)}</span></button>`).join("");

    const attention = (core.brief?.attention || []).filter(item => item.audience === "operator");
    const attentionSummary = item => {
      if (item.kind === "access_provisioning") return `${item.count || 1} connected service${item.count === 1 ? "" : "s"} need setup`;
      if (item.kind === "operator_question") return `${item.count || 1} operator question${item.count === 1 ? "" : "s"} need an answer`;
      return item.summary;
    };
    document.getElementById("attention-list").innerHTML = attention.length ? attention.map(item => `<button type="button" class="attention-row interactive" data-attention-kind="${escape(item.kind || "")}" data-attention-change-id="${escape(item.change_id || item.refs?.change_id || "")}"><span><strong>${escape(attentionSummary(item))}</strong><small>${escape(item.kind || "Attention")}</small></span></button>`).join("") : '<p>No attention needed.</p>';
    const work = core.current || [];
    document.getElementById("current-work").innerHTML = work.length ? work.map(item => `<button type="button" class="attention-row interactive" data-work-status="${escape(item.status || "open")}" data-change-id="${escape(item.change_id || "")}"><span><strong>${escape(item.intent)}</strong><small>${escape(item.status || "open")}${item.hold?.unblock ? ` · ${escape(item.hold.unblock)}` : ""}</small></span></button>`).join("") : '<p>No open work.</p>';

    const questions = core.questions?.unanswered || [];
    const questionCount = document.getElementById("question-count");
    questionCount.textContent = questions.length ? `${questions.length} waiting` : "None";
    questionCount.classList.toggle("neutral", !questions.length);
    document.querySelector(".question-panel")?.classList.toggle("attention-needed", questions.length > 0);
    document.getElementById("question-list").innerHTML = questions.length ? questions.map(item => {
      const actions = item.free_text
        ? `<input class="question-note" aria-label="Answer for ${escape(item.question || "operator question")}" placeholder="Your answer"><button type="button" class="quiet answer-free-text" data-question-id="${escape(item.question_id)}">Answer</button>`
        : (item.choices || []).map(choice => `<button class="quiet answer-choice" data-question-id="${escape(item.question_id)}" data-choice="${escape(choice)}">${escape(choice)}</button>`).join("");
      return `<div class="question-row"><strong>${escape(item.question)}</strong><p>${escape(item.cannot || "ASIP needs your decision.")}</p><div class="question-actions">${actions}</div></div>`;
    }).join("") : '<p>No operator questions.</p>';

    const recovery = core.recovery || {};
    const snapshots = recovery.journal_snapshots || [];
    document.getElementById("continuity-state").innerHTML = `
      <button type="button" class="continuity-row interactive" data-continuity="recovery"><span><strong>Recovery</strong><small>${recovery.supported ? `${escape(snapshots.length)} recent snapshot(s)` : "View recovery support and recorded points"}</small></span></button>`;
    const incomplete = (core.brief?.attention || []).find(item => item.kind === "incomplete_operation")?.count || 0;
    document.getElementById("health-state").innerHTML = `<div class="continuity-row"><strong>ASIP ${escape(core.summary?.version || "installed")}</strong><p>Journal and policy state are available through native health details.</p></div><div class="continuity-row"><strong>Incomplete operations</strong><p>${escape(incomplete)}</p></div>`;

    renderAuthorities(core.access);
  }

  function renderAuthorities(access) {
    const items = (access?.access || []).filter(item=> !["removed","not_requested"].includes(item.state));
    document.getElementById("authority-list").innerHTML = items.length ? items.map(item => {
      const state = (item.available || item.state === "available") ? "Connected" : item.state === "operator_action_required" ? "Needs setup" : "Not requested";
      const action = (item.available || item.state === "available")
        ? `<button class="quiet remove-authority" data-name="${escape(item.name)}">Remove</button>`
        : item.state === "operator_action_required"
          ? `<button class="quiet provision-authority" data-name="${escape(item.name)}" data-label="${escape(item.label)}" data-env-var="${escape(item.env_var)}">Provision</button><button class="quiet dismiss-authority" data-name="${escape(item.name)}">Not now</button>`
          : "";
      return `<div class="authority-row"><strong>${escape(item.label || item.name)}</strong><p>${escape(item.name)} · ${escape(item.env_var || "No environment binding")} · ${state}</p>${action ? `<div class="question-actions">${action}</div>` : ""}</div>`;
    }).join("") : '<p>No connected services.</p>';
  }

  async function refreshCore() {
    const serial = ++coreSerial;
    const core = await window.ASIPNative.call("core.refresh");
    if (serial === coreSerial) renderCore(core);
    return core;
  }

  function beginDetail(title) {
    const serial=++detailSerial;
    document.getElementById('change-detail-body').innerHTML=`<h2>${escape(title)}</h2><p role="status">Loading…</p>`;
    window.ASIPWorkspace.detail();
    return serial;
  }

  async function openChange(changeId) {
    const serial=beginDetail('Change');
    const detail = await window.ASIPNative.call("change.detail", { change_id: changeId });
    if(serial!==detailSerial) return;
    const notes = detail.notes || [];
    const verifications = detail.verifications || [];
    const operations = detail.operations || [];
    const outcome = detail.outcome || (["open", "held"].includes(detail.status) ? "This change is still in progress." : "");
    const hold = detail.hold || {};
    const operationMarkup = operations.length ? operations.map(item => `<details class="detail-expander"><summary><strong>${escape(item.detail || item.op || "Operation")}</strong><span>${escape(item.state || item.status || "recorded")}</span></summary><p>${escape(item.outcome || item.summary || item.detail || "No additional operation detail.")}</p><small>${escape(item.operation_id || item.id || "")}${item.at ? ` · ${escape(item.at)}` : ""}${item.exit !== undefined && item.exit !== null ? ` · exit ${escape(item.exit)}` : ""}</small>${item.references?.length ? `<p>References: ${escape(item.references.join(", "))}</p>` : ""}<button class="quiet" data-operation-id="${escape(item.id)}">Open operation</button></details>`).join("") : "<p>No durable operations recorded.</p>";
    const verificationMarkup = verifications.length ? verifications.map(item => `<div class="detail-row"><strong class="result-${escape(item.result || "unknown")}">${escape(item.result || "recorded")}</strong><span>${escape(item.tool || "verification")}</span><p>${escape(item.reason || item.note || "No reason recorded.")}</p><small>${escape(item.at || item.verified_at || item.created_at || "")}${item.references?.length ? ` · evidence ${escape(item.references.join(", "))}` : ""}</small></div>`).join("") : "<p>No verification recorded.</p>";
    const noteMarkup = notes.length ? notes.map(item => `<div class="detail-row"><strong>${escape(item.subject || "Note")}</strong><p>${escape(item.reason || item.note || "")}</p>${item.reference ? `<small>${escape(item.reference)}</small>` : ""}</div>`).join("") : "<p>No notes recorded.</p>";
    const snapshots = detail.recovery?.snapshots || detail.recovery?.journal_snapshots || [];
    const recoveryMarkup = snapshots.length ? snapshots.map(item => `<div class="detail-row"><strong>${escape(item.reason || "Recovery snapshot")}</strong><p>${escape(item.created_at || item.timestamp || item.at || "")}</p><small>${escape(item.recovery_handle || item.handle || item.snapshot_id || "")}</small></div>`).join("") : "<p>No recovery snapshot is recorded.</p>";
    const terminalMarkup = detail.terminal_action === "supersede" && detail.superseded_by
      ? `<div class="detail-section"><strong>Superseded</strong><p>This change was replaced by ${escape(detail.superseded_by)}.</p></div>`
      : detail.status === "failed" ? `<div class="detail-section failure-detail"><strong>Failure</strong><p>${escape(detail.outcome || "The change did not complete.")}</p></div>` : "";
    const questionMarkup = (detail.operator_questions || []).filter(item => item.status === "unanswered").map(item => `<div class="detail-row"><strong>Operator question</strong><p>${escape(item.question || "ASIP needs an answer")}</p></div>`).join("");
    document.getElementById("change-detail-body").innerHTML = `
      <p class="kicker">${escape(detail.status)}</p><h2>${escape(detail.intent)}</h2>
      ${outcome ? `<p>${escape(outcome)}</p>` : ""}
      <div class="detail-section"><strong>Started</strong><p>${escape(detail.started_at || "Unknown")}${detail.finished_at ? ` · completed ${escape(detail.finished_at)}` : ""}</p></div>
      ${hold.reason ? `<div class="detail-section hold-detail"><strong>Held</strong><p>${escape(hold.reason)}</p>${hold.unblock ? `<small>Unblock: ${escape(hold.unblock)}</small>` : ""}</div>` : ""}
      <div class="detail-section"><strong>Operations · ${escape(operations.length)}</strong>${operationMarkup}</div>
      <div class="detail-section"><strong>Verification</strong>${verificationMarkup}</div>
      <div class="detail-section"><strong>Important notes</strong>${noteMarkup}</div>
      <div class="detail-section"><strong>Recovery</strong>${recoveryMarkup}</div>${terminalMarkup}${questionMarkup ? `<div class="detail-section"><strong>Questions</strong>${questionMarkup}</div>` : ""}`;
    if(serial!==detailSerial) return;
    window.ASIPWorkspace.detail();
  }

  async function openVerification() {
    const serial=beginDetail('Verification');
    const result = await window.ASIPNative.call("verification.list");
    if(serial!==detailSerial) return;
    const items = result.verifications || [];
    const rows = items.slice().reverse().map(item => {
      const action = item.change_id ? ` data-change-id="${escape(item.change_id)}"` : "";
      const tag = action ? "button type=\"button\" class=\"detail-row interactive\"" : "div class=\"detail-row\"";
      return `<${tag}${action}><span><strong class="result-${escape(item.result || "unknown")}">${escape(item.result || "recorded")}</strong><span>${escape(item.tool || "verification")}</span><small>${escape(item.note || item.reason || "No note recorded.")}</small><small>${escape(item.at || item.created_at || item.verified_at || "")}${item.change_id ? ` · change ${escape(item.change_id)}` : ""}${item.references?.length ? ` · evidence ${escape(item.references.join(", "))}` : ""}</small></span></${action ? "button" : "div"}>`;
    }).join("");
    document.getElementById("change-detail-body").innerHTML = `<p class="kicker">Computer detail</p><h2>Verification</h2><p>In-situ checks recorded by ASIP. A verification is evidence about a result, not a replacement for the durable change.</p>${rows || "<p>No in-situ verifications recorded.</p>"}`;
    if(serial!==detailSerial) return;
    window.ASIPWorkspace.detail();
  }

  async function openRecovery() {
    const serial=beginDetail('Recovery');
    const result = await window.ASIPNative.call("recovery.detail");
    if(serial!==detailSerial) return;
    const snapshots = result.journal_snapshots || result.snapshots || [];
    const timeline = result.timeline?.snapshots || [];
    const timelineMarkup = timeline.length ? timeline.map(item => `<div class="detail-row"><strong>${escape(item.description || item.type || "Snapshot")}</strong><p>${escape(item.date || "")}</p><small>${item.recovery_handle ? `Recovery handle ${escape(item.recovery_handle)}` : "Backend snapshot only; no rollback handle"}</small></div>`).join("") : `<p>${escape(result.timeline?.error || "No live snapshot timeline is available.")}</p>`;
    document.getElementById("change-detail-body").innerHTML = `<p class="kicker">Computer detail</p><h2>Recovery</h2><p>${result.supported ? "ASIP can use the configured snapshotter for machine recovery." : "No managed snapshotter is available on this computer."}</p><div class="detail-section"><strong>Recorded recovery points</strong>${snapshots.length ? snapshots.map(item => `<div class="detail-row"><strong>${escape(item.reason || "Recovery snapshot")}</strong><p>${escape(item.at || item.created_at || item.timestamp || "")}</p><small>Handle: ${escape(item.recovery_handle || item.handle || item.snapshot_id || "unknown")}</small></div>`).join("") : "<p>No recent journaled snapshots.</p>"}</div><div class="detail-section"><strong>Live snapshot timeline</strong>${timelineMarkup}</div><div class="detail-section"><strong>Rollback</strong><p>${escape(result.rollback || "Rollback is unavailable until a supported recovery handle exists.")}</p><small>${escape(result.rollback_accepts || "Recovery handles remain the product identity; backend numbers are diagnostic.")}</small></div>`;
    if(serial!==detailSerial) return;
    window.ASIPWorkspace.detail();
  }

  function renderCodex(codex) {
    const account = codex.account || {};
    const managed = codex.managed_provider;
    const active = codex.providers?.active || (managed?.id || "chatgpt");
    const connected = Boolean(account.connected || managed);
    aiConnected = connected;
    const provider = managed ? `${managed.name} via Codex` : account.provider === "chatgpt" ? "ChatGPT via Codex" : "Existing Codex setup";
    document.getElementById("codex-provider").textContent = connected ? provider : "Connect your AI";
    document.getElementById("codex-detail").textContent = connected
      ? `${managed?.model || codex.models?.find(model => model.default)?.name || "Model ready"} · ASIP-managed Codex runtime`
      : "Connect a ChatGPT account or configure an API provider.";
    const status = document.getElementById("codex-status");
    status.textContent = managed ? (managed.verified ? "Configured · authenticated" : "Configured · unverified") : connected ? "Connected" : "Sign in";
    status.classList.toggle("neutral", !connected);
    document.getElementById("connect-ai").hidden = connected && !loginBusy;
    const chatgptConnected = Boolean(codex.providers?.chatgpt_connected || (active === "chatgpt" && account.connected));
    const googleSaved = Boolean(codex.providers?.connections?.google);
    document.getElementById("chatgpt-connection").textContent = active === "chatgpt" && connected ? "Active provider" : chatgptConnected ? "Connected · ready to switch" : "Not connected";
    document.getElementById("google-connection").textContent = active === "google" && connected ? "Active provider" : googleSaved ? "Saved connection" : "Not connected";
    document.getElementById("settings-connect-openai").textContent = active === "chatgpt" ? "Reconnect ChatGPT" : "Switch to ChatGPT";
    document.getElementById("settings-connect-google").textContent = codex.providers?.connections?.google ? (active === "google" ? "Reconnect Google" : "Switch to Google") : "Connect Google Gemini";
    document.getElementById("remove-provider").hidden = !managed;
    document.getElementById("remove-provider").dataset.provider = managed?.id || "";
    document.getElementById("prompt").disabled = !connected || turnBusy || loginBusy;
    document.getElementById("send-prompt").disabled = loginBusy || (!connected && !turnBusy);
  }

  async function connectOpenAI() {
    if (loginBusy || turnBusy) return;
    const returnTab = document.querySelector('[data-tab].active')?.dataset.tab || "ask";
    loginBusy = true;
    showTurnControl(false);
    selectTab("ask");
    document.getElementById("connect-ai").hidden = false;
    const buttons = [
      document.getElementById("connect-openai"),
      document.getElementById("settings-connect-openai"),
    ];
    const loginStatus = document.getElementById("login-status");
    buttons.forEach(button => { button.disabled = true; });
    loginStatus.textContent = "Opening secure sign-in in your browser…";
    try {
      const current = await window.ASIPNative.call("codex.status");
      if (current.providers?.active !== "chatgpt" && current.providers?.chatgpt_connected) {
        await window.ASIPNative.call("provider.select", { provider: "chatgpt" });
        clearConversation();
        await refreshConversations();
        renderCodex(await window.ASIPNative.call("codex.status"));
        loginStatus.textContent = "CHATGPT IS READY.";
        selectTab("ask");
        return;
      }
      await window.ASIPNative.call("codex.login.openai");
      document.getElementById("cancel-login").hidden=false;
      loginStatus.textContent = "Complete sign-in in your browser. ASIP will continue automatically.";
      const result = await window.ASIPNative.call("codex.login.wait");
      if (!result.login?.success) throw new Error(result.login?.error || "OpenAI sign-in did not complete");
      renderCodex(result.status);
      loginStatus.textContent = "Connected.";
      selectTab("ask");
    } catch (error) {
      loginStatus.textContent = error.message;
      document.getElementById("provider-action-status").textContent = error.message;
      selectTab(returnTab);
    } finally {
      loginBusy = false;
      document.getElementById("connect-ai").hidden = aiConnected;
      showTurnControl(false);
      document.getElementById("prompt").disabled = !aiConnected;
      document.getElementById("send-prompt").disabled = !aiConnected;
      buttons.forEach(button => { button.disabled = false; });
      document.getElementById("cancel-login").hidden=true;
    }
  }

  document.querySelectorAll("[data-tab]").forEach(button => button.addEventListener("click", () => selectTab(button.dataset.tab)));
  document.getElementById("theme-toggle").addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light", true);
  });
  const conversationTrigger = document.getElementById("conversation-trigger");
  const conversationPopover = document.getElementById("conversation-popover");
  const closeConversationMenu = () => {
    conversationPopover.hidden = true;
    conversationTrigger.setAttribute("aria-expanded", "false");
  };
  conversationTrigger.addEventListener("click", () => {
    conversationPopover.hidden = !conversationPopover.hidden;
    conversationTrigger.setAttribute("aria-expanded", String(!conversationPopover.hidden));
    if (!conversationPopover.hidden) conversationPopover.querySelector("button")?.focus();
  });
  async function conversationAction(event) {
    const item = event.target.closest("[data-conversation-id]");
    const action = event.target.closest("[data-conversation-action]")?.dataset.conversationAction;
    const selectedId = item?.dataset.conversationId;
    try {
      if (selectedId) {
        const result = await window.ASIPNative.call("conversation.select", { conversation_id: selectedId });
        selectTab("ask");
        renderMessages(result);
      } else if (action === "new") {
        await window.ASIPNative.call("conversation.new");
        clearConversation();
      } else {
        const conversationState = await window.ASIPNative.call("conversation.list");
        const current = conversationState.conversations?.find(entry => entry.id === conversationState.active_id);
        if (!current) return;
        if (action === "rename") {
          const title = await actionDialog("Conversation name", current.title || "Conversation");
          if (title?.trim()) await window.ASIPNative.call("conversation.rename", { conversation_id: current.id, title });
        } else if (action === "keep" || action === "unkeep") {
          await window.ASIPNative.call("conversation.keep", { conversation_id: current.id });
        } else if (action === "forget" && await actionDialog("Forget this local conversation entry? Codex and machine history remain available.")) {
          await window.ASIPNative.call("conversation.forget", { conversation_id: current.id });
          clearConversation("Conversation forgotten. Same computer.");
        }
      }
      await refreshConversations();
    } catch (error) {
      document.getElementById("conversation-continuity").textContent = error.message;
    } finally {
      closeConversationMenu();
    }
  }
  conversationPopover.addEventListener("click", conversationAction);
  document.getElementById("recent-conversations").addEventListener("click", conversationAction);
  conversationPopover.addEventListener("keydown", event => {
    if (event.key === "Escape") { closeConversationMenu(); conversationTrigger.focus(); }
  });
  document.addEventListener("click", event => {
    if (!event.target.closest(".conversation-menu")) closeConversationMenu();
  });
  document.getElementById("new-conversation").addEventListener("click", async () => {
    await window.ASIPNative.call("conversation.new");
    clearConversation();
    await refreshConversations();
  });
  document.querySelectorAll(".refresh").forEach(button => button.addEventListener("click", refreshCore));
  document.getElementById("connect-openai").addEventListener("click", connectOpenAI);
  document.getElementById("settings-connect-openai").addEventListener("click", connectOpenAI);
  const googleForm = document.getElementById("google-form");
  let googleReturnTab = "ask";
  function showGoogleForm() {
    googleReturnTab = document.querySelector('[data-tab].active')?.dataset.tab || "ask";
    selectTab("settings");
    document.getElementById("google-status").textContent = "";
    googleForm.hidden = false;
    googleForm.elements.api_key.focus();
  }
  document.getElementById("onboarding-connect-google").addEventListener("click", showGoogleForm);
  document.getElementById("settings-connect-google").addEventListener("click", async () => {
    const feedback = document.getElementById("provider-action-status");
    feedback.textContent = "Checking Google connection…";
    try {
      const status = await window.ASIPNative.call("codex.status");
      if (status.providers?.active === "google" || !status.providers?.connections?.google) {
        showGoogleForm();
      } else {
        await window.ASIPNative.call("provider.select", { provider: "google" });
        clearConversation();
        await refreshConversations();
        renderCodex(await window.ASIPNative.call("codex.status"));
        selectTab("ask");
      }
      feedback.textContent = "";
    } catch (error) {
      feedback.textContent = error.message;
    }
  });
  document.getElementById("cancel-google").addEventListener("click", () => {
    googleForm.reset();
    googleForm.hidden = true;
    selectTab(googleReturnTab);
  });
  googleForm.addEventListener("submit", async event => {
    event.preventDefault();
    const submit = googleForm.querySelector('[type="submit"]');
    if (submit.disabled) return;
    submit.disabled = true;
    const key = googleForm.elements.api_key.value;
    googleForm.elements.api_key.value = "";
    const status = document.getElementById("google-status");
    status.textContent = "Checking Google authentication…";
    try {
      const configured=await window.ASIPNative.call("provider.google.configure", { api_key: key, model:googleForm.elements.model.value });
      clearConversation();
      await refreshConversations();
      status.textContent = "Google configured. Model access is confirmed by the first successful turn.";
      if(configured.warning) window.ASIPWorkspace.error(configured.warning);
      googleForm.hidden = true;
      renderCodex(await window.ASIPNative.call("codex.status"));
      selectTab("ask");
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  const providerForm = document.getElementById("provider-form");
  let providerReturnTab = "settings";
  function showProviderForm() {
    providerReturnTab = document.querySelector('[data-tab].active')?.dataset.tab || "settings";
    selectTab("settings");
    document.getElementById("provider-status").textContent = "ASIP retains the key as named authority.";
    providerForm.hidden = false;
    providerForm.elements.name.focus();
  }
  document.getElementById("settings-configure-provider").addEventListener("click", showProviderForm);
  document.getElementById("onboarding-configure-provider").addEventListener("click", showProviderForm);
  document.getElementById("cancel-provider").addEventListener("click", () => {
    providerForm.reset();
    providerForm.hidden = true;
    selectTab(providerReturnTab);
  });
  providerForm.addEventListener("submit", async event => {
    event.preventDefault();
    const buttons = [...providerForm.querySelectorAll('button')];
    if (buttons.some(button => button.disabled)) return;
    buttons.forEach(button => { button.disabled = true; });
    const fields = Object.fromEntries(new FormData(providerForm));
    providerForm.elements.api_key.value = "";
    const status = document.getElementById("provider-status");
    status.textContent = "Securing the key with ASIP and starting the provider…";
    try {
      const configured=await window.ASIPNative.call("provider.configure", fields);
      clearConversation();
      await refreshConversations();
      if(configured.warning) window.ASIPWorkspace.error(configured.warning);
      providerForm.elements.api_key.value = "";
      providerForm.hidden = true;
      renderCodex(await window.ASIPNative.call("codex.status"));
      selectTab("ask");
    } catch (error) {
      status.textContent = error.message;
    } finally {
      buttons.forEach(button => { button.disabled = turnBusy; });
    }
  });
  document.getElementById("remove-provider").addEventListener("click", async () => {
    const provider = document.getElementById("remove-provider").dataset.provider;
    if (!await actionDialog("Disconnect this provider? ASIP-owned provider credentials are removed.")) return;
    const result = await window.ASIPNative.call("provider.remove", { provider });
    clearConversation();
    await refreshConversations();
    if (result.warning) document.getElementById("provider-action-status").textContent = result.warning;
    renderCodex(await window.ASIPNative.call("codex.status"));
  });
  document.getElementById("changes-list").addEventListener("click", event => {
    if (event.target.closest("#clear-change-filter")) {
      changeFilter = null;
      loadHistory().catch(error=>window.ASIPWorkspace.error(error.message));
      return;
    }
    if(event.target.closest("#load-history")) { loadHistory(true).catch(error=>window.ASIPWorkspace.error(error.message)); return; }
    const row = event.target.closest("[data-change-id]");
    if (row) openChange(row.dataset.changeId).catch(console.error);
  });
  document.getElementById("computer-metrics").addEventListener("click", event => {
    const metric = event.target.closest("[data-computer-action]");
    if (!metric) return;
    const action = metric.dataset.computerAction;
    if (action === "verification") openVerification().catch(console.error);
    else { changeFilter = action; selectTab("changes"); loadHistory().catch(error=>window.ASIPWorkspace.error(error.message)); }
  });
  document.getElementById("current-work").addEventListener("click", event => {
    const row = event.target.closest("[data-change-id]");
    if (row?.dataset.changeId) openChange(row.dataset.changeId).catch(console.error);
    else {
      changeFilter = row?.dataset.workStatus || "open";
      selectTab("changes");
      if (latestCore) renderCore(latestCore);
    }
  });
  document.getElementById("attention-list").addEventListener("click", event => {
    const row = event.target.closest("[data-attention-kind]");
    if (!row) return;
    const kind = row.dataset.attentionKind;
    if (row.dataset.attentionChangeId) {
      openChange(row.dataset.attentionChangeId).catch(console.error);
    } else if (kind === "access_provisioning") {
      selectTab("settings");
      document.getElementById("authority-list")?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (kind === "operator_question") {
      document.getElementById("question-list")?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (kind === "incomplete_operation") {
      changeFilter = "open";
      selectTab("changes");
      if (latestCore) renderCore(latestCore);
    } else if (kind === "recovery") {
      openRecovery().catch(console.error);
    }
  });
  document.getElementById("continuity-state").addEventListener("click", event => {
    const row = event.target.closest("[data-continuity]");
    if (row?.dataset.continuity === "recovery") openRecovery().catch(console.error);
  });
  document.getElementById("health-card").addEventListener("click", async () => {
    const serial=beginDetail('ASIP health');
    const result = await window.ASIPNative.call("health.detail");
    if(serial!==detailSerial) return;
    document.getElementById("change-detail-body").innerHTML = `<h2>ASIP health</h2><div class="detail-row"><strong>${escape(result.status)}</strong><p>Runtime ${escape(result.version)} · application ${escape(result.product?.client_version || 'unknown')}</p>${result.product?.match===false ? '<p>Installed runtime and application versions differ. Complete the update and reconnect.</p>' : ''}</div><div class="detail-row"><strong>Machine policy</strong><p>${result.machine?.readable ? 'Readable' : 'Unavailable'} · ${escape(result.machine?.path)}</p></div><div class="detail-row"><strong>Journal</strong><p>${result.journal?.readable ? 'Readable' : 'Unavailable'} · ${escape(result.journal?.records)} records</p></div><h3>Incomplete operations</h3>${(result.journal?.incomplete_operations || []).map(id=>`<button class="detail-row interactive" data-operation-id="${escape(id)}">${escape(id)}</button>`).join('') || '<p>None.</p>'}`;
    window.ASIPWorkspace.detail();
  });
  document.getElementById("question-list").addEventListener("click", async event => {
    const choice = event.target.closest(".answer-choice");
    const free = event.target.closest(".answer-free-text");
    if (!choice && !free) return;
    const questionId = (choice || free).dataset.questionId;
    const note = free ? free.parentElement.querySelector(".question-note").value : "";
    if(free && !note.trim()) { window.ASIPWorkspace.error('Enter an answer first.'); return; }
    const control = choice || free;
    control.disabled = true;
    try {
      await window.ASIPNative.call("question.answer", { question_id: questionId, choice: choice?.dataset.choice, note });
      await refreshCore();
    } catch (error) {
      control.disabled = false;
      control.insertAdjacentHTML("afterend", `<small class="inline-error">${escape(error.message)}</small>`);
    }
  });
  document.addEventListener("keydown", event => {
    if (!(event.key === "Enter" || event.key === " ") || event.target.closest("button, a, input, textarea, select")) return;
    const target = event.target.closest('[role="button"]');
    if (!target) return;
    event.preventDefault();
    target.click();
  });

  const authorityForm = document.getElementById("authority-form");
  function showAuthorityForm(fields = {}) {
    authorityForm.hidden = false;
    for (const name of ["name", "label", "env_var"]) authorityForm.elements[name].value = fields[name] || "";
    authorityForm.elements.value.value = "";
    authorityForm.elements.name.readOnly = Boolean(fields.name);
    authorityForm.elements.value.focus();
  }
  document.getElementById("add-authority").addEventListener("click", () => showAuthorityForm());
  document.getElementById("cancel-authority").addEventListener("click", () => { authorityForm.reset(); authorityForm.hidden = true; });
  document.getElementById("authority-list").addEventListener("click", async event => {
    const provision = event.target.closest(".provision-authority");
    const dismiss = event.target.closest(".dismiss-authority");
    const remove = event.target.closest(".remove-authority");
    if (provision) showAuthorityForm({ name: provision.dataset.name, label: provision.dataset.label, env_var: provision.dataset.envVar });
    if (dismiss) {
      await window.ASIPNative.call("access.dismiss", { name: dismiss.dataset.name });
      await refreshCore();
    }
    if (remove && await actionDialog(`Remove the credential for ${remove.dataset.name}?`)) {
      await window.ASIPNative.call("access.remove", { name: remove.dataset.name });
      await refreshCore();
    }
  });
  authorityForm.addEventListener("submit", async event => {
    event.preventDefault();
    const buttons = [...authorityForm.querySelectorAll('button')];
    if (buttons.some(button => button.disabled)) return;
    buttons.forEach(button => { button.disabled = true; });
    const status = document.getElementById("authority-status");
    const fields = Object.fromEntries(new FormData(authorityForm));
    authorityForm.elements.value.value = "";
    status.textContent = "Storing through ASIP named authority…";
    try {
      await window.ASIPNative.call("access.provision", fields);
      authorityForm.elements.value.value = "";
      authorityForm.hidden = true;
      await refreshCore();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  });
  let activeConversation = null;
  function showTurnControl(active, stopping = false) {
    const button = document.getElementById("send-prompt");
    button.textContent = active ? "■" : "↑";
    button.setAttribute("aria-label", active ? (stopping ? "Stopping ASIP" : "Stop ASIP") : "Send");
    button.classList.toggle("stop", active);
    button.disabled = stopping || loginBusy || (!active && !aiConnected);
    turnBusy=active;
    for(const node of document.querySelectorAll('[data-conversation-id], #conversation-trigger, #new-conversation, .provider-choice button, .provider-card button, #settings-configure-provider, #remove-provider, #provider-form button, #google-form button, #connect-openai')) node.disabled=active || loginBusy;
    document.getElementById("prompt").disabled = active || loginBusy || !aiConnected;
  }

  window.ASIPNative.onEvent(event => {
    if (event.method==='desktop/turnFinished' && !activeConversation) {
      showTurnControl(false);
      refreshConversations().then(data=>{
        const selected=data.conversations?.find(item=>item.id===data.active_id);
        if(selected) renderMessages({conversation:selected});
      }).catch(error=>window.ASIPWorkspace.error(error.message));
      return;
    }
    if (!activeConversation) return;
    if (event.method === "item/agentMessage/delta") {
      const itemId = event.payload?.itemId;
      if (activeConversation.itemId && itemId !== activeConversation.itemId) {
        activeConversation.response.textContent = "";
      }
      activeConversation.itemId = itemId;
      activeConversation.response.textContent += event.payload?.delta || "";
      activeConversation.status.textContent = "ASIP is responding";
    } else if (event.method === "item/started") {
      activeConversation.status.textContent = "ASIP is working";
    } else if (event.method === "turn/completed") {
      const turn=event.payload?.turn || {};
      activeConversation.status.textContent = turn.status === "completed" ? "✓ Done" : turn.status === "interrupted" ? "Stopped" : "Failed";
      if(turn.error?.message) activeConversation.response.textContent += "\n"+turn.error.message;
    }
  });

  document.getElementById("composer").addEventListener("submit", async event => {
    event.preventDefault();
    const input = document.getElementById("prompt");
    const button = document.getElementById("send-prompt");
    if (turnBusy && !activeConversation) { await window.ASIPNative.call('ask.interrupt'); return; }
    if (activeConversation) {
      if (activeConversation.stopping) return;
      activeConversation.stopping = true;
      activeConversation.status.textContent = "Stopping…";
      showTurnControl(true, true);
      try {
        await window.ASIPNative.call("ask.interrupt");
      } catch (error) {
        activeConversation.status.textContent = "Could not stop";
        activeConversation.response.textContent = error.message;
        activeConversation.stopping = false;
        showTurnControl(true);
      }
      return;
    }
    const prompt = input.value.trim();
    if (!prompt) return;
    const conversation = document.getElementById("conversation");
    conversation.insertAdjacentHTML("beforeend", `<div class="user-message"><small>You asked</small><p>${escape(prompt)}</p></div><div class="agent-message working"><span class="agent-mark" aria-hidden="true">A</span><div><strong>ASIP</strong><span class="work-status" role="status" aria-live="polite">ASIP is working</span><p class="agent-response" aria-live="polite"></p></div></div>`);
    const agent = conversation.lastElementChild;
    activeConversation = {
      status: agent.querySelector(".work-status"),
      response: agent.querySelector(".agent-response"),
      itemId: null,
      agent,
      stopping: false,
    };
    input.value = "";
    showTurnControl(true);
    try {
      const result = await window.ASIPNative.call("ask.send", { prompt });
      await refreshConversations();
      if(result.answer!==undefined) activeConversation.response.textContent=result.answer;
      activeConversation.status.textContent = result.state === "completed" ? "✓ Done" : result.state === "interrupted" ? "Stopped" : "Failed";
      if(result.error?.message && !activeConversation.response.textContent.includes(result.error.message)) activeConversation.response.textContent += "\n"+result.error.message;
    } catch (error) {
      activeConversation.status.textContent = "Could not complete";
      activeConversation.response.textContent = error.message;
    } finally {
      activeConversation.agent.classList.remove("working");
      activeConversation = null;
      showTurnControl(false);
      input.focus();
    }
  });

  document.getElementById('dismiss-error').addEventListener('click',()=>{ document.getElementById('error-banner').hidden=true; });
  document.getElementById('retry-core').addEventListener('click',()=>refreshCore().catch(error=>window.ASIPWorkspace.error(error.message)));
  document.getElementById('cancel-login').addEventListener('click',async()=>{
    await window.ASIPNative.call('codex.login.cancel');
    document.getElementById('login-status').textContent='Sign-in cancelled.';
    document.getElementById('cancel-login').hidden=true;
  });
  document.getElementById('change-detail-body').addEventListener('click',event=>{
    const change=event.target.closest('[data-change-id]');
    if(change) openChange(change.dataset.changeId).catch(error=>window.ASIPWorkspace.error(error.message));
    const operation=event.target.closest('[data-operation-id]');
    if(operation) openOperation(operation.dataset.operationId).catch(error=>window.ASIPWorkspace.error(error.message));
    const output=event.target.closest('[data-output-stream]');
    if(output) readOutput(output).catch(error=>window.ASIPWorkspace.error(error.message));
  });
  async function openOperation(id) {
    const serial=beginDetail('Operation');
    const data=await window.ASIPNative.call('operation.detail',{operation_id:id});
    if(serial!==detailSerial) return;
    const record=data.operation || {};
    document.getElementById('change-detail-body').innerHTML=`<h2>Operation</h2><p>${escape(data.status)} · ${escape(record.op)} · ${escape(id)}</p><p>${escape(record.error || record.reason || '')}</p><pre class="health-pre">${escape((record.argv || []).join(' '))}</pre><p>${record.exit!==undefined ? 'Exit '+escape(record.exit) : ''}${record.pid ? ' · PID '+escape(record.pid) : ''}</p><div class="question-actions">${['stdout','stderr'].map(stream=>`<button class="quiet" data-output-stream="${stream}" data-output-operation="${escape(id)}">Read ${stream}</button>`).join('')}</div><pre class="health-pre" id="operation-output"></pre>`;
    window.ASIPWorkspace.detail();
  }
  async function readOutput(button) {
    const serial=detailSerial;
    button.disabled=true;
    try {
      const data=await window.ASIPNative.call('operation.output',{operation_id:button.dataset.outputOperation,stream:button.dataset.outputStream,offset:Number(button.dataset.offset || 0)});
      if(serial!==detailSerial) return;
      document.getElementById('operation-output').textContent=(button.dataset.offset ? document.getElementById('operation-output').textContent : '')+(data.text || 'No captured output.');
      button.dataset.offset=data.next_offset || '';
      button.textContent=data.next_offset ? 'More '+button.dataset.outputStream : 'Read '+button.dataset.outputStream;
    } finally { button.disabled=false; }
  }

  window.ASIPNative.call("application.initialize").then(result => {
    document.getElementById("computer-name").textContent = result.product?.machine || "This computer";
    applyTheme(result.desktop?.theme || "light");
    selectTab(result.desktop?.selected_tab || "ask", false);
    renderConversations({active_id: result.desktop?.active_conversation_id, conversations: result.desktop?.conversations || []});
    renderCore(result.core);
    if(result.provider_error) window.ASIPWorkspace.error(result.provider_error);
    const selected=result.desktop?.conversations?.find(i=>i.id===result.desktop?.active_conversation_id);
    if(selected) renderMessages({conversation:selected});
    if(result.turn_active) { showTurnControl(true); document.getElementById('conversation-continuity').textContent='A turn is still active. Stop it or wait before starting another.'; }
    window.ASIPNative.call("codex.status").then(renderCodex).catch(error => {
      document.getElementById("codex-detail").textContent = error.message;
      document.getElementById("codex-status").textContent = "Unavailable";
      for (const id of ["chatgpt-connection", "google-connection"]) document.getElementById(id).textContent = "Connection could not be checked";
      document.getElementById("connect-ai").hidden = false;
      document.getElementById("prompt").disabled = true;
      document.getElementById("send-prompt").disabled = true;
      document.getElementById("login-status").textContent = error.message;
    });
  }).catch(error => {
    document.getElementById("connection-label").textContent = error.message;
  });
})();
