// The parts of Jira's REST responses that jboard uses.

export interface User {
  name?: string;
  displayName?: string;
}

export interface Issue {
  key: string;
  fields: {
    summary: string;
    status: { id: string; name: string };
    assignee: User | null;
    issuetype: { name: string; subtask?: boolean };
    updated: string;
    parent?: { key: string };
  };
  points?: number | null; // story points, from the board's estimation field
}

/** A story, task or bug on the board, with its subtasks in this sprint. */
export interface Card extends Issue {
  subs: Issue[];
}

export interface Column {
  name: string;
  statuses: Set<string>;
}

export interface Sprint {
  id: number;
  name: string;
  state?: "active" | "future" | "closed";
  startDate?: string;
  endDate?: string;
}

export interface Transition {
  id: string;
  name: string;
  to: { id: string; name: string };
}
