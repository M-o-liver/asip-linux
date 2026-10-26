export function hostedWorkspace(cloud, project) {
  const handle = cloud?.account;
  const base = /^[-a-z0-9_]{3,40}$/.test(handle || "")
    ? "https://asip.ca/users/" + handle
    : "https://asip.ca/app";
  const url = new URL(base);
  if (typeof project === "string" && project) {
    url.searchParams.set("project", project);
  }
  return url.href;
}
