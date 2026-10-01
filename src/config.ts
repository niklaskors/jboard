// Settings from the environment; see the README for what each one means.

export const SERVER = (process.env.JIRA_SERVER ?? "").replace(/\/+$/, "");
export const TOKEN = process.env.JIRA_API_TOKEN ?? "";

/** Opens Jira's SSO sign-in; set JIRA_SSO_URL when login.jsp doesn't (e.g. <jira>/plugins/servlet/samlsso). */
export const SSO_URL = process.env.JIRA_SSO_URL
  || `${SERVER}/login.jsp?os_destination=${encodeURIComponent("/secure/Dashboard.jspa")}`;

export const boardUrl = (boardId: string) => `${SERVER}/secure/RapidBoard.jspa?rapidView=${boardId}`;
export const issueUrl = (key: string) => `${SERVER}/browse/${key}`;
