const proof = {
  intent: {
    kind: "Intent / ASIP release qualification",
    title: "Capture the work without asking twice.",
    text: "Verify that an ordinary Antigravity reply is automatically preserved and can be recalled by Codex, with its original session and source evidence.",
  },
  result: {
    kind: "Result / Native agent response",
    title: "“Automatic turn summary verified.”",
    text: "The ordinary reply appeared automatically in Beacon and its project workspace on Linux, Windows and Intel macOS. Codex then recalled the recorded response.",
  },
  evidence: {
    kind: "Evidence / Source record",
    title: "A response with a source you can inspect.",
    text: "The recorded evidence preserves the transcript reference, native timestamp, step number and SHA-256. Alpha 3 qualification independently recomputed the Linux source-row hash and matched the recorded value.",
  },
};
const tabs = [...document.querySelectorAll("[data-proof]")];
function choose(tab) {
  tabs.forEach((t) => {
    t.setAttribute("aria-selected", String(t === tab));
    t.tabIndex = t === tab ? 0 : -1;
  });
  const p = proof[tab.dataset.proof];
  document.querySelector("#proof-kind").textContent = p.kind;
  document.querySelector("#proof-title").textContent = p.title;
  document.querySelector("#proof-text").textContent = p.text;
  document
    .querySelector("#proof-panel")
    .setAttribute("aria-labelledby", tab.id);
}
tabs.forEach((tab, i) => {
  tab.addEventListener("click", () => choose(tab));
  tab.addEventListener("keydown", (e) => {
    let next;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    if (e.key === "ArrowLeft") next = (i + tabs.length - 1) % tabs.length;
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = tabs.length - 1;
    if (next !== undefined) {
      e.preventDefault();
      tabs[next].focus();
      choose(tabs[next]);
    }
  });
});
