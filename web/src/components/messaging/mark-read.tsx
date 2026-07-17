"use client";

import { useEffect, useRef } from "react";

/** Marks the conversation read on mount (clears the unread badge). */
export function MarkRead({
  conversationId,
  action,
}: {
  conversationId: string;
  action: (id: string) => Promise<void>;
}) {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    action(conversationId).catch(() => {});
  }, [conversationId, action]);
  return null;
}
