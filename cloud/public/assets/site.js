const proof = {
  intent: {
    kind: "Intent / ASIP release qualification",
    title: "Carry the handoff to the next computer.",
    text: "Record a project handoff in Linux Codex. Retrieve the original work, native session and evidence in Windows Antigravity. Then bring the next agent’s response back with you.",
  },
  result: {
    kind: "Result / Native agent response",
    title: "Recorded on Linux. Recalled on Windows.",
    text: "Windows Antigravity retrieved the original Codex record. Its response was captured automatically, synchronized through ASIP cloud, and recalled back on Linux.",
  },
  evidence: {
    kind: "Evidence / Source record",
    title: "A handoff with its history intact.",
    text: "Original record IDs, native sessions, timestamps, project associations and source hashes stay with the work. The published qualification follows both directions of the handoff and verifies the original Windows record’s hash on Linux.",
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
