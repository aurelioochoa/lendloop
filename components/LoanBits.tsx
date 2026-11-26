import { timeAgo } from "@/lib/ui";

type Status = "requested" | "approved" | "declined" | "cancelled" | "returned";

const STATUS_LABEL: Record<Status, string> = {
  requested: "Pending",
  approved: "Approved",
  declined: "Declined",
  cancelled: "Cancelled",
  returned: "Returned",
};

export function StatusBadge({ status, overdue }: { status: Status; overdue?: boolean }) {
  if (overdue) return <span className="badge overdue">Overdue</span>;
  return <span className={`badge status-${status}`}>{STATUS_LABEL[status]}</span>;
}

type Activity = {
  lastReminder: { outcome: "sent" | "failed"; at: number } | null;
  lastNotification: { type: string; status: "pending" | "delivered" | "failed"; at: number } | null;
};

/** "Reminder sent 2 days ago · Notification delivered 1 h ago" */
export function ActivityLine({ activity }: { activity: Activity }) {
  const parts: string[] = [];
  if (activity.lastReminder) {
    parts.push(
      activity.lastReminder.outcome === "sent"
        ? `Reminder sent ${timeAgo(activity.lastReminder.at)}`
        : `Reminder failed ${timeAgo(activity.lastReminder.at)}`,
    );
  }
  if (activity.lastNotification) {
    const n = activity.lastNotification;
    const verb = n.status === "delivered" ? "delivered" : n.status === "failed" ? "failed" : "sending";
    parts.push(`Notification ${verb} ${timeAgo(n.at)}`);
  }
  if (parts.length === 0) return null;
  return <p className="activity">{parts.join(" · ")}</p>;
}
