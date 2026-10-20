import { toastManager } from "./ui/toast";
import { useSlowRpcAckRequests, type SlowRpcAckRequest } from "../wire/requestLatencyState";
import { useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";

/** What a person would call the request, from its RPC method name (which means nothing to them). */
export function describeRpcTag(tag: string): string {
  const t = tag.toLowerCase();
  if (/merge/.test(t)) return "Merging a worker";
  if (/(startturn|sendturn|send|turn\.start|prompt)/.test(t)) return "Sending your message";
  if (/^fleet\.|worker|swarm/.test(t)) return "Updating workers";
  if (/^(chat|thread)/.test(t)) return "Updating a chat";
  if (/^workspace\.|^host\.fs|files|grep/.test(t)) return "Reading project files";
  if (t.startsWith("pty.")) return "Talking to a terminal";
  if (t.startsWith("browser.")) return "Updating the browser";
  if (t.startsWith("daemon.")) return "Syncing Kora's settings";
  if (t.startsWith("blobs.")) return "Updating Kora";
  return "Talking to Kora's local service";
}

function describeSlowRequests(requests: ReadonlyArray<SlowRpcAckRequest>): string {
  // Thresholds vary per method, so report the smallest one the batch has passed.
  const smallestMs = Math.min(...requests.map((request) => request.thresholdMs));
  const seconds = Math.round(smallestMs / 1000);
  const actions = [...new Set(requests.map((request) => describeRpcTag(request.tag)))];
  const what = actions.length === 1 ? actions[0]! : `${actions.length} things`;
  return `${what} is taking longer than ${seconds}s. Kora's local service may be busy.`;
}

const slowRequestDetailsCls1 = "min-w-0 border-border/50 border-b pb-2 last:border-b-0 last:pb-0";

function SlowRequestDetails(props: { requests: ReadonlyArray<SlowRpcAckRequest> }) {
  const rows = props.requests.map((request) => (
    <li className={slowRequestDetailsCls1} key={request.requestId}>
      <div className="wrap-break-word font-medium text-foreground">
        {describeRpcTag(request.tag)}
      </div>
      <div className="mt-0.5 text-[10px] opacity-75">
        Started {new Date(request.startedAt).toLocaleTimeString()}
      </div>
    </li>
  ));
  return <ul className="space-y-2.5 text-xs text-muted-foreground">{rows}</ul>;
}

export function SlowRpcRequestToastCoordinator() {
  const toastIdRef = useRef<ReturnType<typeof toastManager.add> | null>(null);
  const slowRequests = useSlowRpcAckRequests();
  const navigate = useNavigate();

  useEffect(() => {
    const shownId = toastIdRef.current;
    if (slowRequests.length === 0) {
      if (shownId !== null) {
        toastManager.close(shownId);
        toastIdRef.current = null;
      }
      return;
    }

    const toast = {
      data: {
        expandableLabels: { collapse: "Hide details", expand: "Show details" },
        expandableContent: <SlowRequestDetails requests={slowRequests} />,
        expandableDescriptionTrigger: true,
      },
      description: describeSlowRequests(slowRequests),
      type: "warning" as const,
      title: "Kora is slow to respond",
      timeout: 0,
      actionProps: {
        children: "Diagnostics",
        onClick: () => void navigate({ to: "/settings/diagnostics" as never }),
      },
    };

    if (shownId === null) {
      toastIdRef.current = toastManager.add(toast);
    } else {
      toastManager.update(shownId, toast);
    }
  }, [navigate, slowRequests]);

  useEffect(
    () => () => {
      const lingering = toastIdRef.current;
      if (lingering !== null) {
        toastManager.close(lingering);
      }
    },
    [],
  );

  return null;
}
